// batch -> store -> engine.ingest -> events -> SSE (+ pickCue). Also sets, calibration and replay.
import { Engine, coachVoiceExtras, pickCueSequence, pickSetEndCueSequence, buildCoachContext, summarizeSet, summarizeSetDetail, summarizeSession, writeTodayHistory, speak, spokenPart,
  type SessionSummary, type LoggedLift,
  type Arm, type Batch, type Calibration, type EngineEvent, type RepEvent, type SetContext, type SetEndEvent, type Variant } from "./modules.js";
import type { Store, SessionKind, EventRow } from "./store.js";
import type { Hub } from "./hub.js";
import type { Heartbeat } from "./schemas.js";

export const ENV_CEILING = 14960;
export interface SetTemplate { exercise: string; variant: Variant; load_lb?: number; arms: Arm[]; auto_next: boolean }
export const DEFAULT_SET: Omit<SetTemplate, "arms"> = { exercise: "dumbbell curl", variant: "standing", load_lb: 35, auto_next: false };
/** Live run Nov 14: 10 s pauses split real sets, and 0.95 of a short flex under-read the biceps MVC.
 *  The engine also raises the MVC to p99 of each finished set (autoRaiseMvc, on by default). */
// Hands-free sets: a set ends autoEndMs after the last rep, so putting the weights down ends it.
// Nov 14 (s-1114-151942-af0): with 5-8 s of delivery lag, reps ~8-10 s apart auto-ended a set after 4 reps:
// 15 s, and the dashboard shows "set ends in N s" once SET_IDLE_WARN_MS have passed without a rep.
export const ENGINE_CONFIG = { autoEndMs: 15_000, mvcPercentile: 0.99 } as const;
export const SET_IDLE_WARN_MS = 8_000;
/** A device time this far behind the newest sample seen = the UNO rebooted (its clock restarted), not a resend. */
const DEVICE_RESET_MS = 60_000;
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
  /** Device time (ms) of the current set's last rep end, for the "set ends in N s" warning. */
  lastRepEndT?: number | null;
}

/** Per device: the newest sample time ingested (device ms), and the smallest receive-minus-device offset. */
interface DeviceTrack { endT: number; minOffset: number; lagMs: number; at: number }

/**
 * Coalesced POSTs and resends: drop the part of a batch that was already ingested (by device time, so a
 * repeated coalesced POST, or one that overlaps an earlier one, never feeds the same samples twice).
 * Returns the remaining batch, null if nothing new, and whether the device clock restarted.
 */
export function trimIngested(b: Batch & { n_batches?: number }, endT: number | null): { batch: Batch | null; reset: boolean } {
  const n = b.ch[0]?.length ?? 0;
  const bEnd = b.t0_ms + n * b.dt_ms;
  if (endT === null || n === 0) return { batch: n ? b : null, reset: false };
  if (b.t0_ms < endT - DEVICE_RESET_MS && bEnd < endT - DEVICE_RESET_MS) return { batch: b, reset: true };
  const skip = Math.max(0, Math.round((endT - b.t0_ms) / b.dt_ms));
  if (skip >= n) return { batch: null, reset: false };
  if (skip === 0) return { batch: b, reset: false };
  const per = b.n_batches && b.n_batches > 1 ? n / b.n_batches : 0;
  return {
    batch: { ...b, seq: b.seq + (per ? Math.floor(skip / per) : 0), t0_ms: b.t0_ms + skip * b.dt_ms, ch: b.ch.map(c => c.slice(skip)) },
    reset: false,
  };
}

export class Pipeline {
  live: Sess | null = null;
  replay: { sess: Sess; source: string; i: number; n: number; stop: boolean; speed: number } | null = null;
  /** Receive time + sample count of each stored POST in the last 5 s (a coalesced POST holds several batches). */
  private batchTimes: { t: number; n: number }[] = [];
  private lastBatchWall = 0;
  private lastHb: (Heartbeat & { at: number }) | null = null;
  private statusTimer = setInterval(() => this.hub.send(this.status()), 1000);

  constructor(private store: Store, private hub: Hub) {
    this.statusTimer.unref?.();
    this.quiet = store.getSetting("quiet") === "1"; // Quiet mode survives a server restart
  }

  get active() { return this.replay?.sess ?? this.live; }

  // ------------------------------------------------------------------ device input
  private devices = new Map<string, DeviceTrack>();

  ingest(b0: Batch & { n_batches?: number }): { duplicate: boolean; samples?: number } {
    // Guard: real hardware never feeds a fake-device session. A non-fake device with no open session,
    // or with a fake one open, gets a fresh live session for Mike (even while a replay is playing).
    const realDevice = !b0.device.startsWith("lw-fake");
    const sess = this.live && !(realDevice && this.live.kind !== "live")
      ? this.live
      : this.openSession({ person: "Mike", walkup: false, kind: realDevice ? "live" : "fake" });
    const dev = this.devices.get(b0.device);
    const { batch, reset } = trimIngested(b0, dev ? dev.endT : null);
    if (!batch) return { duplicate: true };
    const b: Batch = { device: batch.device, seq: batch.seq, t0_ms: batch.t0_ms, dt_ms: batch.dt_ms, ch: batch.ch };
    const id = this.store.saveBatch(sess.id, b);
    if (id === null) return { duplicate: true };
    sess.lastBatchId = id;
    const now = Date.now();
    // Device lag = receive time - device time of the newest sample, relative to the smallest seen
    // (the clocks' fixed offset cancels out). A reboot restarts the device clock: start over.
    const endT = b.t0_ms + b.ch[0].length * b.dt_ms, offset = now - endT;
    const minOffset = !dev || reset ? offset : Math.min(dev.minOffset, offset);
    this.devices.set(b.device, { endT: Math.max(reset || !dev ? endT : dev.endT, endT), minOffset, lagMs: offset - minOffset, at: now });
    this.lastBatchWall = now;
    this.batchTimes.push({ t: now, n: b.ch[0].length });
    while (this.batchTimes.length && this.batchTimes[0].t < now - 5000) this.batchTimes.shift();
    if (!this.replay) this.process(sess, b); // while a replay drives the dashboard, live batches are only stored
    return { duplicate: false, samples: b.ch[0].length };
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
    this.setIdleTick(sess, b.t0_ms + b.ch[0].length * b.dt_ms);
  }

  /** Once SET_IDLE_WARN_MS pass without a rep, tell the dashboard when the engine will end the set (device time). */
  private setIdleTick(sess: Sess, nowT: number) {
    if (!sess.set || sess.lastRepEndT == null) return;
    const idle = nowT - sess.lastRepEndT;
    if (idle >= SET_IDLE_WARN_MS) this.hub.send({ type: "set_idle", set_id: sess.set.set_id, idle_ms: Math.round(idle), ends_in_ms: Math.max(0, Math.round(ENGINE_CONFIG.autoEndMs - idle)) });
  }

  private handle(sess: Sess, e: EngineEvent) {
    if (e.type === "live") this.hub.send(e);
    else if (e.type === "rep") { sess.lastRepEndT = e.end_ms; this.onRep(sess, e); }
    else if (e.type === "set_end") {
      sess.lastRepEndT = null;
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
    let cue: string[] | null = null;
    if (!short) try { cue = pickSetEndCueSequence(e); } catch (err) { console.error("[coach] pickSetEndCueSequence failed:", errMsg(err)); }
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

  /**
   * Set end (>= 3 reps): the spoken line and the detailed "Set N report" run in parallel. Text goes to the
   * dashboards as soon as it exists; TTS (5-17 s) runs once on the server afterwards, then `coach_audio`
   * tells the speaker tab to play it (its /voice/say hits the server's TTS cache).
   */
  private async coach(sess: Sess, e: SetEndEvent) {
    const fallback = e.cheats ? "stop_and_rest" : "nice_set";
    const setNo = sess.setNo ?? null;
    let ctx: ReturnType<typeof buildCoachContext>;
    try {
      const todaySets = sess.kind === "live" && !sess.isWalkUp ? this.store.todaySetEnds(sess.person) : sess.sets;
      // setMeta lets the coach compare like with like against history (same exercise/variant/load).
      const setMeta = { ...this.store.todaySetMeta(sess.person), ...this.store.sessionSetMeta(sess.id) };
      ctx = buildCoachContext({ person: sess.person, todaySets, setMeta });
    } catch (err) {
      console.error("[coach] context failed:", errMsg(err));
      this.hub.send({ type: "coach", set_id: e.set_id, text: null, fallback_clip: fallback, ...coachVoiceExtras(e) });
      this.hub.send({ type: "coach_audio", set_id: e.set_id, ok: false, fallback_clip: fallback });
      return;
    }
    const detail = withTimeout(summarizeSetDetail(ctx, e), 15_000)
      .then(d => { this.store.saveSetDetail(e.set_id, d); this.hub.send({ type: "set_detail", set_id: e.set_id, set_no: setNo, detail: d }); })
      .catch(err => console.error("[coach] summarizeSetDetail failed:", errMsg(err)));
    try {
      const text = await withTimeout(summarizeSet(ctx, e), 12_000);
      this.store.saveCoachLine(e.set_id, text);
      console.log(`[coach] ${sess.person} set ${e.set_id}: ${text}`);
      this.hub.send({ type: "coach", set_id: e.set_id, text, fallback_clip: fallback, audio: "pending", ...coachVoiceExtras(e) });
      try {
        // Only the first sentence is spoken (④'s spokenPart); the full line stays on screen.
        const spoken = spokenPart(text);
        await withTimeout(speak(spoken), 30_000);
        this.hub.send({ type: "coach_audio", set_id: e.set_id, ok: true, text, spoken });
      } catch (err) {
        console.error("[voice] summary TTS failed:", errMsg(err));
        this.hub.send({ type: "coach_audio", set_id: e.set_id, ok: false, fallback_clip: fallback, error: /timed out|timeout/i.test(errMsg(err)) ? "timeout" : "error" });
      }
    } catch (err) {
      console.error("[coach] summarizeSet failed:", errMsg(err));
      this.hub.send({ type: "coach", set_id: e.set_id, text: null, fallback_clip: fallback, ...coachVoiceExtras(e) });
      this.hub.send({ type: "coach_audio", set_id: e.set_id, ok: false, fallback_clip: fallback });
    }
    await detail;
    if (sess.kind === "live" && !sess.isWalkUp) void this.refreshWorkoutSummary(sess.person);
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
  /** Tell dashboards to refresh the workout timeline (e.g. a lift was logged without sensors). */
  notifyWorkout(person = this.sessionPerson) { this.hub.send({ type: "workout" }); void this.refreshWorkoutSummary(person); }

  // ------------------------------------------------------------------ workout summary (④ summarizeSession)
  private summaryCache = new Map<string, { key: string; value: Promise<SessionSummary> }>();
  /** Today's workout for a person, summarised by the coach. Cached per (person, last finished set, logged count). */
  workoutSummary(person: string): Promise<SessionSummary> {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const since = midnight.toISOString();
    const logged = this.store.loggedToday(person, since);
    const key = `${person}|${this.store.lastSetIdToday(person, since) ?? "-"}|${logged.length}`;
    const hit = this.summaryCache.get(person);
    if (hit && hit.key === key) return hit.value;
    const ctx = buildCoachContext({ person, todaySets: this.store.todaySetEnds(person), setMeta: this.store.todaySetMeta(person) });
    const lifts: LoggedLift[] = logged.map(l => ({ exercise: l.exercise, variant: l.variant, load_lb: l.load_lb, sets: l.sets, reps: l.reps, note: l.note }));
    const value = withTimeout(summarizeSession(ctx, { logged: lifts }), 15_000);
    value.catch(() => this.summaryCache.delete(person)); // never cache a timeout
    this.summaryCache.set(person, { key, value });
    return value;
  }
  /** Recompute after a set or a logged lift and push it to the dashboards. */
  async refreshWorkoutSummary(person: string) {
    try {
      const summary = await this.workoutSummary(person);
      this.hub.send({ type: "workout_summary", person, summary });
    } catch (err) { console.error("[coach] summarizeSession failed:", errMsg(err)); }
  }
  /** For the workout timeline: the session on screen and its running set. */
  get activeIds() { const s = this.active; return { session: s?.id, set: s?.set?.set_id, person: s && !s.isWalkUp ? s.person : "Mike" }; }

  stopSet() {
    const sess = this.liveOrDefault();
    this.cancelCountdown();
    this.cmdStopSet(sess);
    this.pushStatus();
  }

  // ------------------------------------------------------------------ quiet mode
  /** Quiet mode: every dashboard plays no audio at all and the hands-free loop never auto-starts. */
  quiet = false;
  setQuiet(on: boolean) {
    this.quiet = on;
    this.store.setSetting("quiet", on ? "1" : "0");
    this.hub.send({ type: "quiet", on });
    this.pushStatus();
    return { quiet: on };
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
          const prev = batches[i - 1].batch;
          const prevDur = (prev.ch[0]?.length ?? 0) * prev.dt_ms; // a coalesced batch can span several seconds
          const gap = Math.max(0, Math.min(Math.max(2000, prevDur + 200), batch.t0_ms - prev.t0_ms));
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
  /** Lag of the most recently heard device (null when none in the last 10 s, or in replay). */
  private deviceLag(now: number): number | null {
    if (this.replay) return null;
    let best: DeviceTrack | null = null;
    for (const d of this.devices.values()) if (!best || d.at > best.at) best = d;
    return best && now - best.at < 10_000 ? best.lagMs : null;
  }

  status() {
    const s = this.active, now = Date.now();
    return {
      type: "status", now: new Date(now).toISOString(),
      mode: this.replay ? "replay" : "live",
      device: {
        // Coalesced POSTs arrive up to ~1.6 s of data apart (+ RTT): don't flicker to "silent" between them.
        streaming: now - this.lastBatchWall < 4000,
        last_batch_age_ms: this.lastBatchWall ? now - this.lastBatchWall : null,
        lag_ms: this.deviceLag(now),
        // 40-sample batch equivalents per second (5.0 = every sample arriving), whatever the POST coalescing.
        batches_per_s: Math.round((this.batchTimes.filter(x => x.t >= now - 5000).reduce((a, x) => a + x.n, 0) / 5 / 40) * 10) / 10,
        heartbeat: this.lastHb ? { rssi: this.lastHb.rssi ?? null, queue: this.lastHb.queue ?? null, fw: this.lastHb.fw ?? null, uptime_ms: this.lastHb.uptime_ms ?? null, age_ms: now - this.lastHb.at,
          dropped: this.lastHb.dropped ?? null, post_rtt_ms: this.lastHb.post_rtt_ms ?? null, post_rtt_max_ms: this.lastHb.post_rtt_max_ms ?? null, coalesce_max: this.lastHb.coalesce_max ?? null } : null,
      },
      session: s ? { id: s.id, person: s.person, walkup: s.isWalkUp, kind: s.kind, arms: s.arms, calibrated: !!s.calibration, cal_source: s.calSource, mvc: s.calibration?.mvc ?? null, calibrating: s.calibrating, cal_problems: s.calibration?.problems ?? [], sets_done: s.sets.length } : null,
      set: s?.set ? { set_id: s.set.set_id, set_no: s.setNo, exercise: s.set.exercise, variant: s.set.variant, load_lb: s.set.load_lb ?? null, arms: s.set.arms } : null,
      armed: s?.armed ?? null,
      quiet: this.quiet,
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
