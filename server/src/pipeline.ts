// batch -> store -> engine.ingest -> events -> SSE (+ pickCue). Also sets, calibration and replay.
import { Engine, pickCueSequence, pickSetEndCue, buildCoachContext, summarizeSet, writeTodayHistory, speak,
  type Arm, type Batch, type Calibration, type EngineEvent, type RepEvent, type SetContext, type SetEndEvent, type Variant } from "./modules.js";
import type { Store, SessionKind, EventRow } from "./store.js";
import type { Hub } from "./hub.js";
import type { Heartbeat } from "./schemas.js";

export const ENV_CEILING = 14960;
export interface SetTemplate { exercise: string; variant: Variant; load_lb?: number; arms: Arm[]; auto_next: boolean }
export const DEFAULT_SET: Omit<SetTemplate, "arms"> = { exercise: "dumbbell curl", variant: "standing", load_lb: 35, auto_next: false };
/** Live run Nov 14: 10 s pauses split real sets, and 0.95 of a short flex under-read the biceps MVC.
 *  The engine also raises the MVC to p99 of each finished set (autoRaiseMvc, on by default). */
// Hands-free sets (Nov 14): a set ends 8 s after the last rep, so putting the weights down ends it.
export const ENGINE_CONFIG = { autoEndMs: 8_000, mvcPercentile: 0.99 } as const;
/** Start set = a voiced countdown ("Pick them up. Three, two, one, curl!"); the set arms when it ends. */
export const COUNTDOWN_MS = 6000;
export const MVC_PERCENTILE = 0.99;
/** Auto-rest: 10th percentile of the last 5 s of idle samples, taken when a set is armed. */
export const AUTO_REST = { windowMs: 5000, percentile: 0.1, minSamples: 200, minChange: 25 } as const;
const DEFAULT_CAL: Calibration = { rest: [550, 550, 550, 550], mvc: [14960, 14960, 14960, 14960], ok: true, problems: [] };
export type CalSource = "saved" | "calibrated" | "auto";
/** Live run: a weak flex saved R biceps MVC 5118 vs L 14857, so R read ~3x more sensitive. Never load or
 *  persist an MVC under 9000: lift it to 80% of the ENV ceiling and let the engine's auto-raise go up from there. */
export const MVC_FLOOR = { below: 9000, to: Math.round(14960 * 0.8) } as const;
export function floorMvc(c: Calibration): Calibration {
  const mvc = c.mvc.map(m => (m < MVC_FLOOR.below ? Math.max(m, MVC_FLOOR.to) : m));
  return mvc.every((m, i) => m === c.mvc[i]) ? c : { ...c, mvc };
}
/** Fewer distinct reps than this: no coach summary ("set too short"). */
export const MIN_REPS_FOR_SUMMARY = 3;

export class HttpError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) { super(message); } }

const pad = (n: number) => String(n).padStart(2, "0");
function newId(prefix: string) {
  const d = new Date();
  return `${prefix}-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 5)}`;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pctl = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms))]);
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Last ~12 s of raw samples, for calibration windows. */
class Ring {
  t: number[] = []; ch: number[][] = [[], [], [], []]; lastWall = 0;
  private cap = 2400;
  push(b: Batch) {
    const n = b.ch[0].length;
    for (let i = 0; i < n; i++) { this.t.push(b.t0_ms + i * b.dt_ms); for (let k = 0; k < 4; k++) this.ch[k].push(b.ch[k][i]); }
    if (this.t.length > this.cap * 1.5) { const cut = this.t.length - this.cap; this.t = this.t.slice(cut); this.ch = this.ch.map(c => c.slice(cut)); }
    this.lastWall = Date.now();
  }
  window(ms: number): number[][] {
    if (!this.t.length) return [[], [], [], []];
    const newest = this.t[this.t.length - 1];
    let i = this.t.length - 1;
    while (i > 0 && this.t[i - 1] >= newest - ms) i--;
    return this.ch.map(c => c.slice(i));
  }
}

interface Sess {
  id: string; person: string; isWalkUp: boolean; kind: SessionKind; arms: Arm[];
  engine: Engine; ring: Ring;
  calibration: Calibration | null; calibrating: boolean; cal: { rest?: number[][]; mvc: (number[] | null)[] };
  armed: SetTemplate | null; set: SetContext | null; setNo: number | null; lastBatchId: number;
  sets: SetEndEvent[]; source?: string;
  /** Where the current calibration came from: saved (last session), calibrated (flex holds), auto (defaults + auto-rest/MVC). */
  calSource: CalSource;
  /** When rest was last measured (countdown start), so arming a few seconds later doesn't re-measure it
   *  while the lifter is already holding the weights. */
  restTakenAt: number;
}

export class Pipeline {
  live: Sess | null = null;
  replay: { sess: Sess; source: string; i: number; n: number; stop: boolean; speed: number } | null = null;
  private batchTimes: number[] = [];
  private lastBatchWall = 0;
  private lastHb: (Heartbeat & { at: number }) | null = null;
  private statusTimer = setInterval(() => this.hub.send(this.status()), 1000);

  constructor(private store: Store, private hub: Hub) { this.statusTimer.unref?.(); }

  get active() { return this.replay?.sess ?? this.live; }

  // ------------------------------------------------------------------ device input
  ingest(b: Batch): { duplicate: boolean } {
    // Guard: real hardware never feeds a fake-device session. A non-fake device with no open session,
    // or with a fake one open, gets a fresh live session for Mike (even while a replay is playing).
    const realDevice = !b.device.startsWith("lw-fake");
    const sess = this.live && !(realDevice && this.live.kind !== "live")
      ? this.live
      : this.openSession({ person: "Mike", walkup: false, kind: realDevice ? "live" : "fake" });
    const id = this.store.saveBatch(sess.id, b);
    if (id === null) return { duplicate: true };
    sess.lastBatchId = id;
    const now = Date.now();
    this.lastBatchWall = now;
    this.batchTimes.push(now);
    while (this.batchTimes.length && this.batchTimes[0] < now - 5000) this.batchTimes.shift();
    if (!this.replay) this.process(sess, b); // while a replay drives the dashboard, live batches are only stored
    return { duplicate: false };
  }

  heartbeat(h: Heartbeat) {
    this.store.saveHeartbeat(h);
    this.lastHb = { ...h, at: Date.now() };
  }

  private process(sess: Sess, b: Batch) {
    sess.ring.push(b);
    let events: EngineEvent[];
    try { events = sess.engine.ingest(b); } catch (e) { console.error("[engine] ingest failed:", errMsg(e)); return; }
    for (const e of events) this.handle(sess, e);
  }

  private handle(sess: Sess, e: EngineEvent) {
    if (e.type === "live") this.hub.send(e);
    else if (e.type === "rep") this.onRep(sess, e);
    else if (e.type === "set_end") {
      const ctx = sess.set;
      sess.set = null;
      this.onSetEnd(sess, e, ctx);
      this.maybeRearm(sess);
    }
  }

  private onRep(sess: Sess, rep: RepEvent) {
    const ctx = sess.set && sess.set.set_id === rep.set_id ? sess.set : null;
    if (ctx) sess.setNo = this.store.ensureSet(ctx);
    this.store.saveRep(sess.id, rep);
    let cue: string[] = [];
    try { cue = pickCueSequence(rep, { variant: ctx?.variant }); } catch (e) { console.error("[coach] pickCueSequence failed:", errMsg(e)); }
    this.hub.send({ ...rep, set_no: sess.setNo, cue, session_id: sess.id, exercise: ctx?.exercise ?? null });
  }

  private onSetEnd(sess: Sess, e: SetEndEvent, ctx: SetContext | null) {
    if (!e.reps.length) return; // armed but nobody curled: not a set
    const setNo = ctx ? this.store.ensureSet(ctx) : sess.setNo;
    // endSet() can close a final rep that never had its own rep event: store + show it now (no call-out).
    for (const r of e.reps) {
      if (this.store.hasRep(r.set_id, r.arm, r.rep)) continue;
      this.store.saveRep(sess.id, r);
      this.hub.send({ ...r, set_no: setNo, cue: [], session_id: sess.id, exercise: ctx?.exercise ?? null, late: true });
    }
    this.store.endSet(e);
    sess.sets.push(e);
    if (e.calibration) this.applyRaised(sess, e.calibration);
    const nReps = new Set(e.reps.map(r => r.rep)).size;
    const short = nReps < MIN_REPS_FOR_SUMMARY;
    let cue: string | null = null;
    if (!short) try { cue = pickSetEndCue(e); } catch (err) { console.error("[coach] pickSetEndCue failed:", errMsg(err)); }
    this.hub.send({ ...e, set_no: setNo, session_id: sess.id, exercise: ctx?.exercise ?? null, load_lb: ctx?.load_lb ?? null, cue, n_reps: nReps, too_short: short });
    if (short) this.hub.send({ type: "coach", set_id: e.set_id, text: null, too_short: true, n_reps: nReps });
    else void this.coach(sess, e);
    this.writeHistory(sess); // also at session end; per set so a crash never loses the day
  }

  /** The engine raised the MVC from this set (raise-only, p99, already applied): keep and persist it. */
  private applyRaised(sess: Sess, cal: Calibration) {
    const before = sess.calibration?.mvc ?? DEFAULT_CAL.mvc;
    sess.calibration = cal;
    this.persistCal(sess, cal);
    console.log(`[cal] ${sess.id} MVC raised from the set: ${before.join("/")} -> ${cal.mvc.join("/")}`);
    this.hub.send({ type: "calibration", phase: "raised", before, ...cal });
  }

  private async coach(sess: Sess, e: SetEndEvent) {
    const fallback = e.cheats ? "stop_and_rest" : "nice_set";
    try {
      const todaySets = sess.kind === "live" && !sess.isWalkUp ? this.store.todaySetEnds(sess.person) : sess.sets;
      const ctx = buildCoachContext({ person: sess.person, todaySets });
      const text = await withTimeout(summarizeSet(ctx, e), 12_000);
      this.store.saveCoachLine(e.set_id, text);
      console.log(`[coach] ${sess.person} set ${e.set_id}: ${text}`);
      // Generate the speech ONCE here; the speaker dashboard's /voice/say then hits the server's TTS cache.
      try { await withTimeout(speak(text), 10_000); } catch (err) { console.error("[voice] summary TTS failed:", errMsg(err)); }
      this.hub.send({ type: "coach", set_id: e.set_id, text, fallback_clip: fallback });
    } catch (err) {
      console.error("[coach] summarizeSet failed:", errMsg(err));
      this.hub.send({ type: "coach", set_id: e.set_id, text: null, fallback_clip: fallback });
    }
  }

  // ------------------------------------------------------------------ sessions + sets
  private newSess(o: { person: string; walkup: boolean; kind: SessionKind; arms?: Arm[]; source?: string }): Sess {
    const arms = o.arms ?? (o.walkup ? ["R"] : ["R", "L"]);
    const sess: Sess = {
      id: newId(o.kind === "replay" ? "replay" : "s"), person: o.person, isWalkUp: o.walkup, kind: o.kind, arms,
      engine: new Engine(ENGINE_CONFIG), ring: new Ring(), calSource: "auto", restTakenAt: 0, calibration: null, calibrating: false, cal: { mvc: [null, null, null, null] },
      armed: null, set: null, setNo: null, lastBatchId: 0, sets: [], source: o.source,
    };
    this.store.createSession({ session_id: sess.id, person: sess.person, is_walkup: sess.isWalkUp, kind: sess.kind, arms, source_session_id: o.source });
    return sess;
  }

  startSession(o: { person: string; walkup: boolean; kind: "live" | "fake"; arms?: Arm[] }) {
    if (this.replay) throw new HttpError(409, "A replay is running; stop it first.");
    return this.openSession(o);
  }
  /** No replay check: device ingest must never fail because a replay is on screen. */
  private openSession(o: { person: string; walkup: boolean; kind: "live" | "fake"; arms?: Arm[] }) {
    if (this.live) this.endLive();
    const sess = this.newSess(o);
    this.live = sess;
    if (!sess.isWalkUp) {
      const stored = this.store.lastCalibration(sess.person);
      const saved = stored ? floorMvc(stored) : null;
      if (saved) {
        sess.engine.setCalibration(saved);
        sess.calibration = saved;
        sess.calSource = "saved";
        this.persistCal(sess, saved);
        this.log(sess, "calibration", saved); // replay starts from the same values
        console.log(`[cal] ${sess.id} loaded ${sess.person}'s saved calibration: rest ${saved.rest.join("/")} mvc ${saved.mvc.join("/")}`);
      }
    }
    console.log(`[session] ${sess.id} ${sess.person}${sess.isWalkUp ? " (walk-up)" : ""} arms=${sess.arms.join("+")} kind=${sess.kind}`);
    // No set is armed here: a set starts only on Start set (dashboard S / MCP log_exercise).
    if (!this.replay) this.hub.send({ type: "session", session_id: sess.id, person: sess.person, walkup: sess.isWalkUp, arms: sess.arms });
    this.pushStatus();
    return sess;
  }

  /** Close the live session; Mike's (non-walk-up, live) day file is rewritten from SQLite. */
  endLive() {
    const s = this.live;
    if (!s) return;
    this.endCurrent(s, false);
    this.store.endSession(s.id);
    this.writeHistory(s);
    this.live = null;
  }
  private writeHistory(sess: Sess) {
    if (sess.kind !== "live" || sess.isWalkUp) return;
    try {
      const sets = this.store.todaySetEnds(sess.person);
      if (sets.length) writeTodayHistory(sets, { person: sess.person, setMeta: this.store.todaySetMeta(sess.person) });
    } catch (err) { console.error("[coach] writeTodayHistory failed:", errMsg(err)); }
  }

  /** Store a session's calibration (floored). Replay sessions never write. */
  private persistCal(sess: Sess, cal: Calibration) {
    if (sess.kind !== "replay") this.store.saveCalibration(sess.id, floorMvc(cal));
  }

  private log(sess: Sess, kind: string, payload: unknown) {
    if (sess.kind !== "replay") this.store.addEvent(sess.id, sess.lastBatchId, kind, payload);
  }

  private endCurrent(sess: Sess, rearm: boolean) {
    if (!sess.set) return;
    const ctx = sess.set;
    sess.set = null;
    let e: SetEndEvent | null = null;
    try { e = sess.engine.endSet(); } catch (err) { console.error("[engine] endSet failed:", errMsg(err)); }
    if (e) this.onSetEnd(sess, e, ctx);
    if (rearm) this.maybeRearm(sess);
  }

  private maybeRearm(sess: Sess) {
    if (sess.armed?.auto_next && !sess.calibrating && !sess.set) this.arm(sess, sess.armed);
  }

  /** Rest drifts (sweat, pad settling): re-measure it from the idle samples right before a set. */
  private autoRest(sess: Sess) {
    if (sess.calibrating || Date.now() - sess.ring.lastWall > 1500) return;
    if (Date.now() - sess.restTakenAt < 15_000) return; // measured at the countdown start
    const w = sess.ring.window(AUTO_REST.windowMs);
    if (w[0].length < AUTO_REST.minSamples) return;
    const base = sess.calibration ?? DEFAULT_CAL;
    const rest = base.rest.map((r, i) => {
      const est = Math.round(pctl(w[i], AUTO_REST.percentile));
      // Only plausible idle levels: below the RAW mid-scale trap and well under this channel's MVC.
      return est < 4000 && est < base.mvc[i] - 1500 && Math.abs(est - r) >= AUTO_REST.minChange ? est : r;
    });
    if (rest.every((r, i) => r === base.rest[i])) return;
    const cal: Calibration = { ...base, rest };
    sess.engine.setCalibration(cal);
    sess.calibration = cal;
    this.persistCal(sess, cal);
    this.hub.send({ type: "calibration", phase: "rest", rest, mvc: cal.mvc });
  }

  private arm(sess: Sess, tpl: SetTemplate) {
    this.autoRest(sess);
    const ctx: SetContext = { session_id: sess.id, set_id: newId("set"), person: sess.person, exercise: tpl.exercise, variant: tpl.variant, load_lb: tpl.load_lb, arms: tpl.arms };
    sess.engine.startSet(ctx);
    sess.set = ctx;
    sess.setNo = null;
  }

  private cmdStartSet(sess: Sess, tpl: SetTemplate) {
    this.log(sess, "set_start", tpl);
    sess.armed = tpl;
    this.endCurrent(sess, false);
    sess.calibrating = false;
    this.arm(sess, tpl);
  }
  private cmdStopSet(sess: Sess) {
    this.log(sess, "set_stop", null);
    sess.armed = null;
    this.endCurrent(sess, false);
  }

  private liveOrDefault() {
    if (this.replay) throw new HttpError(409, "A replay is running; stop it first.");
    return this.live ?? this.startSession({ person: "Mike", walkup: false, kind: "live" });
  }

  startSet(input: Partial<SetTemplate>) {
    const sess = this.liveOrDefault();
    const tpl: SetTemplate = { ...DEFAULT_SET, ...input, arms: input.arms ?? sess.arms };
    this.cmdStartSet(sess, tpl);
    this.pushStatus();
    return sess.set!;
  }
  /** Exercise/weight for the next set. Applies now if the armed set has no reps yet. */
  logExercise(input: Partial<SetTemplate>) {
    const sess = this.liveOrDefault();
    const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<SetTemplate>;
    const tpl: SetTemplate = { ...(sess.armed ?? { ...DEFAULT_SET, arms: sess.arms }), ...clean };
    if (sess.set && sess.setNo === null) { this.cmdStartSet(sess, tpl); this.pushStatus(); return { applies: "now" as const, template: tpl }; }
    this.log(sess, "set_next", tpl);
    sess.armed = tpl;
    this.pushStatus();
    return { applies: "next_set" as const, template: tpl };
  }
  /** Ask open dashboards to run their calibration flow (MCP start_session). */
  requestCalibration() { this.hub.send({ type: "calibrate_request" }); }
  get sessionPerson() { return this.active?.person ?? "Mike"; }

  stopSet() {
    const sess = this.liveOrDefault();
    this.cancelCountdown();
    this.cmdStopSet(sess);
    this.pushStatus();
  }

  // ------------------------------------------------------------------ hands-free start
  countdown: { endsAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Start set, hands-free: measure rest now (weights still down), count down, then arm. */
  startCountdown(input: Partial<SetTemplate>, ms = COUNTDOWN_MS) {
    const sess = this.liveOrDefault();
    if (sess.calibrating) throw new HttpError(409, "Calibrating; wait for it to finish.");
    this.cancelCountdown(false);
    this.endCurrent(sess, false);
    const tpl: SetTemplate = { ...DEFAULT_SET, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)), arms: input.arms ?? sess.arms };
    this.log(sess, "set_prepare", null);
    sess.restTakenAt = 0;
    this.autoRest(sess);
    sess.restTakenAt = Date.now();
    const endsAt = Date.now() + ms;
    this.countdown = {
      endsAt,
      timer: setTimeout(() => {
        this.countdown = null;
        if (this.live === sess && !this.replay) { this.cmdStartSet(sess, tpl); this.hub.send({ type: "countdown", phase: "go" }); }
        this.pushStatus();
      }, ms),
    };
    this.hub.send({ type: "countdown", phase: "start", ms, ends_at: endsAt });
    this.pushStatus();
    return { ends_at: endsAt, ms };
  }
  cancelCountdown(notify = true) {
    if (!this.countdown) return false;
    clearTimeout(this.countdown.timer);
    this.countdown = null;
    if (notify) this.hub.send({ type: "countdown", phase: "cancel" });
    return true;
  }

  // ------------------------------------------------------------------ calibration
  calBegin() {
    const sess = this.liveOrDefault();
    this.log(sess, "cal_begin", null);
    this.applyCalBegin(sess);
    this.hub.send({ type: "calibration", phase: "begin", arms: sess.arms });
    this.pushStatus();
    return { arms: sess.arms };
  }
  private applyCalBegin(sess: Sess) {
    sess.calibrating = true;
    sess.cal = { mvc: [null, null, null, null] };
    this.endCurrent(sess, false);
  }

  calCapture(step: "rest" | "mvc", ch: number | undefined, windowMs: number) {
    const sess = this.liveOrDefault();
    if (!sess.calibrating) throw new HttpError(409, "Call /calibrate/begin first.");
    if (Date.now() - sess.ring.lastWall > 1500) throw new HttpError(409, "No live data from the device in the last 1.5 s. Is the UNO streaming?");
    const w = sess.ring.window(windowMs);
    if (w[0].length < 20) throw new HttpError(409, `Only ${w[0].length} samples in the window; wait for the device.`);
    if (step === "rest") sess.cal.rest = w;
    else sess.cal.mvc[ch!] = w[ch!];
    const level = step === "rest" ? w.map(median) : [Math.round(pctl(w[ch!], MVC_PERCENTILE))];
    this.hub.send({ type: "calibration", phase: "captured", step, ch: ch ?? null, level, samples: w[0].length });
    return { step, ch: ch ?? null, samples: w[0].length, level };
  }

  calFinish() {
    const sess = this.liveOrDefault();
    if (!sess.calibrating || !sess.cal.rest) throw new HttpError(409, "Capture the rest window first.");
    const rest = sess.cal.rest;
    const len = rest[0].length;
    // Channels not flexed (unused arm on a walk-up): assume the ENV ceiling, like the Nov 13 bench test.
    const mvc = sess.cal.mvc.map(m => m ?? new Array(len).fill(ENV_CEILING));
    let cal: Calibration;
    try { cal = floorMvc(sess.engine.calibrate(rest, mvc, sess.arms)); }
    catch (e) { throw new HttpError(400, `Calibration failed: ${errMsg(e)}`); }
    this.persistCal(sess, cal);
    this.log(sess, "calibration", cal);
    sess.calSource = "calibrated";
    this.applyCalDone(sess, cal);
    this.hub.send({ type: "calibration", phase: "done", ...cal });
    this.pushStatus();
    return cal;
  }
  private applyCalDone(sess: Sess, cal: Calibration) {
    sess.engine.setCalibration(cal);
    sess.calibration = cal;
    sess.calibrating = false;
    this.maybeRearm(sess); // only re-arms when auto next is on (old sessions replay this way)
  }
  calCancel() {
    const sess = this.liveOrDefault();
    this.log(sess, "cal_cancel", null);
    sess.calibrating = false;
    this.maybeRearm(sess);
    this.hub.send({ type: "calibration", phase: "cancel" });
    this.pushStatus();
  }

  // ------------------------------------------------------------------ replay (demo fallback)
  startReplay(sourceId: string, speed = 1) {
    if (this.replay) throw new HttpError(409, "A replay is already running.");
    const src = this.store.getSession(sourceId);
    if (!src) throw new HttpError(404, `No session ${sourceId}.`);
    const batches = this.store.batchesFor(sourceId);
    if (!batches.length) throw new HttpError(400, `Session ${sourceId} has no stored batches.`);
    let events: Pick<EventRow, "after_batch_id" | "kind" | "payload">[] = this.store.eventsFor(sourceId);
    if (!events.some(e => e.kind === "set_start")) {
      const arms = JSON.parse(src.arms) as Arm[];
      events = [{ after_batch_id: 0, kind: "set_start", payload: JSON.stringify({ ...DEFAULT_SET, arms }) }, ...events];
    }
    if (this.live) this.endCurrent(this.live, false); // live reps pause during the replay
    const sess = this.newSess({ person: src.person, walkup: !!src.is_walkup, kind: "replay", arms: JSON.parse(src.arms), source: sourceId });
    const rp = { sess, source: sourceId, i: 0, n: batches.length, stop: false, speed: Math.max(0.25, Math.min(10, speed)) };
    this.replay = rp;
    console.log(`[replay] ${sourceId} -> ${sess.id}: ${batches.length} batches at ${rp.speed}x`);
    this.hub.send({ type: "replay", phase: "start", source: sourceId, session_id: sess.id, batches: batches.length });
    this.pushStatus();
    void this.runReplay(rp, batches, events);
    return { session_id: sess.id, source: sourceId, batches: batches.length, seconds: Math.round((batches.length * 0.2) / rp.speed) };
  }

  private applyEvent(sess: Sess, ev: { kind: string; payload: string }) {
    const p = JSON.parse(ev.payload);
    if (ev.kind === "set_start") { sess.armed = p; this.endCurrent(sess, false); sess.calibrating = false; this.arm(sess, p); }
    else if (ev.kind === "set_next") { sess.armed = p; }
    else if (ev.kind === "set_prepare") { sess.restTakenAt = 0; this.autoRest(sess); sess.restTakenAt = Date.now(); }
    else if (ev.kind === "set_stop") { sess.armed = null; this.endCurrent(sess, false); }
    else if (ev.kind === "cal_begin") { this.applyCalBegin(sess); this.hub.send({ type: "calibration", phase: "begin", arms: sess.arms, replay: true }); }
    else if (ev.kind === "calibration") { this.store.saveCalibration(sess.id, p); this.applyCalDone(sess, p); this.hub.send({ type: "calibration", phase: "done", ...p, replay: true }); }
    else if (ev.kind === "cal_cancel") { sess.calibrating = false; this.maybeRearm(sess); }
  }

  private async runReplay(rp: NonNullable<Pipeline["replay"]>, batches: { batch_id: number; batch: Batch }[], events: { after_batch_id: number; kind: string; payload: string }[]) {
    const { sess } = rp;
    let ei = 0;
    const t0 = performance.now();
    let target = 0;
    try {
      for (let i = 0; i < batches.length && !rp.stop; i++) {
        const { batch_id, batch } = batches[i];
        if (i > 0) {
          const gap = Math.max(0, Math.min(2000, batch.t0_ms - batches[i - 1].batch.t0_ms));
          target += gap / (rp.speed * (sess.calibrating ? 8 : 1)); // fast-forward through calibration

          const wait = t0 + target - performance.now();
          if (wait > 0) await sleep(wait);
        }
        while (ei < events.length && events[ei].after_batch_id < batch_id) this.applyEvent(sess, events[ei++]);
        rp.i = i + 1;
        this.process(sess, batch);
      }
      while (!rp.stop && ei < events.length) this.applyEvent(sess, events[ei++]);
      this.endCurrent(sess, false);
    } catch (e) {
      console.error("[replay] failed:", errMsg(e));
    } finally {
      this.store.endSession(sess.id);
      this.replay = null;
      if (this.live) this.maybeRearm(this.live);
      console.log(`[replay] ${rp.source} ${rp.stop ? "stopped" : "done"}`);
      this.hub.send({ type: "replay", phase: rp.stop ? "stopped" : "done", source: rp.source, session_id: sess.id });
      this.pushStatus();
    }
  }
  stopReplay() {
    if (!this.replay) return false;
    this.replay.stop = true;
    return true;
  }

  // ------------------------------------------------------------------ status
  status() {
    const s = this.active, now = Date.now();
    return {
      type: "status", now: new Date(now).toISOString(),
      mode: this.replay ? "replay" : "live",
      device: {
        streaming: now - this.lastBatchWall < 2000,
        last_batch_age_ms: this.lastBatchWall ? now - this.lastBatchWall : null,
        batches_per_s: Math.round((this.batchTimes.filter(t => t >= now - 5000).length / 5) * 10) / 10,
        heartbeat: this.lastHb ? { rssi: this.lastHb.rssi ?? null, queue: this.lastHb.queue ?? null, fw: this.lastHb.fw ?? null, uptime_ms: this.lastHb.uptime_ms ?? null, age_ms: now - this.lastHb.at } : null,
      },
      session: s ? { id: s.id, person: s.person, walkup: s.isWalkUp, kind: s.kind, arms: s.arms, calibrated: !!s.calibration, cal_source: s.calSource, mvc: s.calibration?.mvc ?? null, calibrating: s.calibrating, cal_problems: s.calibration?.problems ?? [], sets_done: s.sets.length } : null,
      set: s?.set ? { set_id: s.set.set_id, set_no: s.setNo, exercise: s.set.exercise, variant: s.set.variant, load_lb: s.set.load_lb ?? null, arms: s.set.arms } : null,
      armed: s?.armed ?? null,
      countdown_ms_left: this.countdown ? Math.max(0, this.countdown.endsAt - now) : null,
      replay: this.replay ? { source: this.replay.source, i: this.replay.i, n: this.replay.n, speed: this.replay.speed } : null,
      dashboards: this.hub.size,
    };
  }
  pushStatus() { this.hub.send(this.status()); }

  snapshot() {
    const s = this.active;
    return [this.status(), { type: "history", reps: s ? this.store.recentReps(s.id, 30).reverse() : [] }];
  }
}
