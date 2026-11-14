// The signal engine: raw batches in, live frames / reps / set ends out. Pure code, no I/O.
// Code decides cheats; the LLM only explains them.

import { computeCalibration, effectiveScale, raiseMvc, toPct } from "./calibration.js";
import { resolveConfig, thresholdsFor, type EngineConfig, type RepThresholds } from "./config.js";
import {
  ARM_CH,
  type Arm,
  type Batch,
  type Calibration,
  type CoachDecision,
  type EngineEvent,
  type RepEvent,
  type SetContext,
  type SetEndEvent,
} from "./types.js";

interface Sample { t: number; pct: number[] }

/** What a clean rep looks like for one arm: the reference cheats are measured against. */
interface Ref { share: number; deltMean: number; deltPeak: number; upRatio: number }
interface ArmRep extends Ref { flagged: boolean }

interface SetState {
  ctx: SetContext;
  arms: Arm[];
  th: RepThresholds;
  reps: RepEvent[];
  /** Raw samples of this set (for autoRaiseMvc at set end). */
  raw: number[][];
  /** Per-arm rep history (reps where that arm worked), for the reference. */
  armReps: Record<Arm, ArmRep[]>;
  phase: "idle" | "rep";
  /** Samples since the biceps rose above lo (onset), while idle. */
  pre: Sample[];
  rep: Sample[];
  repPeak: number;
  /** Lowest signal since the last rep ended (where the next rep window starts). */
  valley: number;
  lastRepEndT: number | null;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const EPS = 1e-9;

/**
 * Up (concentric) phase of one arm: delt mean / biceps mean while the biceps climbs from
 * `from` x its peak to 90% of it. Not from the window start: on touch-and-go heavy reps the delt
 * is still busy with the previous rep's lowering at the bottom.
 */
function upRatio(w: Sample[], arm: Arm, biPeak: number, from: number): number {
  const { bi, delt } = ARM_CH[arm];
  let end = 0;
  while (end < w.length - 1 && w[end].pct[bi] < 0.9 * biPeak) end++;
  let start = end;
  while (start > 0 && w[start - 1].pct[bi] >= from * biPeak) start--;
  if (start === end) start = Math.max(0, end - 1); // at least 2 samples when there are 2
  let b = 0;
  let d = 0;
  for (let i = start; i <= end; i++) {
    b += w[i].pct[bi];
    d += w[i].pct[delt];
  }
  return b > EPS ? d / b : 0;
}

/** Could this be a clean rep's numbers? (Blatant by the no-reference rules = no.) */
function plausibleRef(r: Ref, th: RepThresholds): boolean {
  return r.upRatio <= th.fallbackUpRatio && r.share <= th.fallbackShareMax;
}

/** A reference measured under one calibration, expressed under another (biceps pct x kb, delt pct x kd). */
function rescaleRef(r: Ref, kb: number, kd: number): Ref {
  const d = r.deltMean;
  const b = r.share > EPS ? (d * (1 - r.share)) / r.share : 0;
  const d2 = d * kd;
  const b2 = b * kb;
  return {
    share: d2 + b2 > EPS ? d2 / (d2 + b2) : r.share,
    deltMean: d2,
    deltPeak: r.deltPeak * kd,
    upRatio: kb > EPS ? (r.upRatio * kd) / kb : r.upRatio,
  };
}

/**
 * Cheat call for one arm's rep, against that arm's clean reference (null = no clean reps yet).
 * - delt_share_jump ("delt took over"), any of:
 *   - up phase: delt/biceps mean ratio from onset to the biceps peak (the concentric half) is
 *     >= upRatioMult x the reference AND >= reference + upRatioJump. The main rule: a swing fires
 *     the delt on the way UP; a strict heavy rep only uses it on the way down (stabilizing), which
 *     dilutes any whole-rep number.
 *   - whole rep: delt share above the reference by > deltShareJump (band curls), or delt mean
 *     %MVC >= deltMeanRatio x the reference AND >= reference + deltMeanJump.
 * - delt_peak: delt peak above max(deltPeakMax, reference peak + deltPeakJump).
 * Without a reference only blatant reps are flagged: up ratio > fallbackUpRatio or share > fallbackShareMax.
 */
function judge(cur: Ref, ref: Ref | null, th: RepThresholds): RepEvent["cheat_reason"] {
  if (ref === null) {
    return cur.upRatio > th.fallbackUpRatio || cur.share > th.fallbackShareMax ? "delt_share_jump" : null;
  }
  if (cur.upRatio >= ref.upRatio * th.upRatioMult && cur.upRatio - ref.upRatio >= th.upRatioJump) return "delt_share_jump";
  if (cur.share > ref.share + th.deltShareJump) return "delt_share_jump";
  if (cur.deltMean >= ref.deltMean * th.deltMeanRatio && cur.deltMean - ref.deltMean >= th.deltMeanJump) return "delt_share_jump";
  if (cur.deltPeak > Math.max(th.deltPeakMax, ref.deltPeak + th.deltPeakJump)) return "delt_peak";
  return null;
}

export class Engine {
  private cfg: EngineConfig;
  private cal: Calibration | null = null;
  private scale: { rest: number[]; span: number[] };
  private set: SetState | null = null;
  private lastT = -Infinity;
  private lastDt = 5;
  private timeOffset = 0;
  private nextLiveT = -Infinity;
  private earlyStreak = { session: "", count: 0 };
  /** Clean reference per arm from earlier sets of this session, keyed by arm|exercise|variant|load. */
  private sessionRefs = { session: "", refs: new Map<string, Ref>() };

  constructor(config?: Partial<EngineConfig>) {
    this.cfg = resolveConfig(config);
    this.scale = effectiveScale(null, this.cfg);
  }

  /**
   * rest / mvc: 4 arrays of raw samples each (3 s windows; mvc[i] = muscle i's own max flex).
   * Applies the result immediately (bad channels fall back to defaults). `arms` limits which
   * channels are checked for problems (a one-arm walk-up has nothing on the other jacks).
   */
  calibrate(rest: number[][], mvc: number[][], arms?: Arm[]): Calibration {
    const c = computeCalibration(rest, mvc, this.cfg, arms);
    this.setCalibration(c);
    return c;
  }

  /**
   * Also rescales the clean references already learned this session (they're in %MVC), so raising
   * the MVC between sets (see raiseMvc) doesn't turn the next set's reps into false cheats.
   */
  setCalibration(c: Calibration): void {
    const old = this.scale;
    this.cal = { rest: [...c.rest], mvc: [...c.mvc], ok: c.ok, problems: [...c.problems] };
    this.scale = effectiveScale(this.cal, this.cfg);
    const k = old.span.map((s, i) => s / this.scale.span[i]); // new pct ~= old pct * k
    if (k.every((x) => Math.abs(x - 1) < 1e-9)) return;
    const scaleFor = (arm: Arm) => ({ kb: k[ARM_CH[arm].bi], kd: k[ARM_CH[arm].delt] });
    for (const [key, ref] of this.sessionRefs.refs) {
      const { kb, kd } = scaleFor(key[0] as Arm);
      this.sessionRefs.refs.set(key, rescaleRef(ref, kb, kd));
    }
    if (this.set) {
      for (const arm of ["R", "L"] as const) {
        const { kb, kd } = scaleFor(arm);
        this.set.armReps[arm] = this.set.armReps[arm].map((r) => ({ ...rescaleRef(r, kb, kd), flagged: r.flagged }));
      }
    }
  }

  /**
   * Raises the MVC from extra raw windows (e.g. the first strict set's samples) and applies it.
   * Same as setCalibration(raiseMvc(current, windows)). Returns the new calibration.
   */
  raiseMvc(windows: number[][][], percentile?: number): Calibration {
    const cur = this.cal ?? {
      rest: [0, 1, 2, 3].map(() => this.cfg.defaultRest),
      mvc: [0, 1, 2, 3].map(() => this.cfg.defaultMvc),
      ok: true,
      problems: [],
    };
    const c = raiseMvc(cur, windows, { percentile, config: this.cfg });
    this.setCalibration(c);
    return c;
  }

  getCalibration(): Calibration | null {
    return this.cal;
  }

  /** Starts a set. An unfinished set is dropped (call endSet first to keep it). */
  startSet(ctx: SetContext): void {
    const arms: Arm[] = ctx.arms.length > 0 ? [...new Set(ctx.arms)] : ["R"];
    this.set = {
      ctx,
      arms,
      th: thresholdsFor(this.cfg, ctx.variant),
      reps: [],
      armReps: { R: [], L: [] },
      raw: [[], [], [], []],
      phase: "idle",
      pre: [],
      rep: [],
      repPeak: 0,
      valley: Infinity,
      lastRepEndT: null,
    };
  }

  ingest(b: Batch): EngineEvent[] {
    const out: EngineEvent[] = [];
    const n = Math.min(...[0, 1, 2, 3].map((i) => b.ch[i]?.length ?? Infinity));
    if (!Number.isFinite(n) || n === 0) return out;
    const dt = b.dt_ms > 0 ? b.dt_ms : this.lastDt;
    // Device restarted (millis() went back a lot): rebase so time keeps moving forward.
    if (Number.isFinite(this.lastT) && b.t0_ms + this.timeOffset < this.lastT - this.cfg.timeResetMs) {
      this.timeOffset = this.lastT + dt - b.t0_ms;
    }
    for (let i = 0; i < n; i++) {
      const t = b.t0_ms + this.timeOffset + i * dt;
      if (t <= this.lastT) continue; // duplicate / overlapping batch
      this.lastT = t;
      this.lastDt = dt;
      // Detection and scoring use %MVC clamped only at detectPctMax (3): a too-low MVC must not
      // flatten every rep at the 1.5 display clamp. Live frames and reported values use pctMax.
      const pct = [0, 1, 2, 3].map((c) => {
        const raw = b.ch[c]?.[i];
        return raw === undefined ? 0 : toPct(raw, this.scale.rest[c], this.scale.span[c], this.cfg.detectPctMax);
      });
      if (t >= this.nextLiveT - 1e-6) {
        out.push({ type: "live", t_ms: t, pct: pct.map((p) => r3(Math.min(this.cfg.pctMax, p))) });
        this.nextLiveT = t + this.cfg.liveIntervalMs;
      }
      if (this.set) {
        if (this.cfg.autoRaiseMvc && this.set.raw[0].length < this.cfg.maxSetSamples) {
          for (let c = 0; c < 4; c++) {
            const raw = b.ch[c]?.[i];
            if (raw !== undefined) this.set.raw[c].push(raw);
          }
        }
        this.step({ t, pct }, out);
      }
    }
    return out;
  }

  /** Ends the current set. A rep still in progress is kept if it's long enough. */
  endSet(): SetEndEvent | null {
    const s = this.set;
    if (!s) return null;
    if (s.phase === "rep") this.finishRep(this.lastT + this.lastDt, null);
    return this.closeSet();
  }

  // ---------------------------------------------------------------- internals

  private signal(s: SetState, pct: number[]): number {
    let m = 0;
    for (const a of s.arms) m = Math.max(m, pct[ARM_CH[a].bi]);
    return m;
  }

  private step(x: Sample, out: EngineEvent[]): void {
    const s = this.set!;
    const { th } = s;
    const sig = this.signal(s, x.pct);

    if (s.phase === "rep") {
      s.rep.push(x);
      s.repPeak = Math.max(s.repPeak, sig);
      const endLevel = this.endLevel(s);
      if (sig < endLevel) {
        s.rep.pop(); // the end sample is not part of the rep
        this.finishRep(x.t, out);
      }
      return;
    }

    // idle. The next rep's window starts at the lowest point since the last rep (or where the
    // signal rose back above lo): under heavy continuous reps the biceps never fully relaxes.
    if (sig < th.lo) {
      s.pre = [];
      s.valley = sig;
    } else if (s.pre.length === 0 || sig <= s.valley) {
      s.pre = [x];
      s.valley = sig;
    } else {
      s.pre.push(x);
      while (s.pre.length > 1 && s.pre[0].t < x.t - this.cfg.maxPreOnsetMs) s.pre.shift();
    }
    // Within minGapMs of the last rep the start is deferred (not dropped): a rep that follows
    // straight on still counts once the gap has passed, a brief rebound doesn't.
    // A new rep must also rise restartRise above the valley, so a tail lingering near the end
    // level (or an MVC set too low, which lifts the valleys) doesn't start a fake rep.
    const startLevel = Math.max(th.hi, s.valley + th.restartRise);
    if (sig >= startLevel && (s.lastRepEndT === null || x.t - s.lastRepEndT >= th.minGapMs)) {
      s.phase = "rep";
      s.rep = s.pre;
      s.pre = [];
      s.repPeak = Math.max(...s.rep.map((p) => this.signal(s, p.pct)));
    }

    if (s.reps.length > 0 && s.lastRepEndT !== null && x.t - s.lastRepEndT >= this.cfg.autoEndMs) {
      out.push(this.closeSet());
    }
  }

  private endLevel(s: SetState): number {
    const { th } = s;
    return Math.max(th.lo, Math.min(th.endLevelMax, th.endPeakFrac * s.repPeak));
  }

  /** Closes the current rep window at endT (exclusive). Emits it into `out` if given. */
  private finishRep(endT: number, out: EngineEvent[] | null): void {
    const s = this.set!;
    const w = s.rep;
    s.phase = "idle";
    s.rep = [];
    s.pre = [];
    s.valley = Infinity;
    s.repPeak = 0;
    if (w.length === 0 || endT - w[0].t < s.th.minRepMs) return; // blip
    const ev = this.scoreRep(s, w, endT);
    s.reps.push(ev);
    s.lastRepEndT = endT;
    out?.push(ev);
  }

  private scoreRep(s: SetState, w: Sample[], endT: number): RepEvent {
    const { th } = s;
    const peak = [0, 0, 0, 0];
    const sum = [0, 0, 0, 0];
    for (const p of w) {
      for (let c = 0; c < 4; c++) {
        peak[c] = Math.max(peak[c], p.pct[c]);
        sum[c] += p.pct[c];
      }
    }
    const mean = sum.map((v) => v / w.length);

    const share = (a: Arm) => {
      const bi = mean[ARM_CH[a].bi];
      const de = mean[ARM_CH[a].delt];
      return bi + de > EPS ? de / (bi + de) : 0;
    };
    let working = s.arms.filter((a) => peak[ARM_CH[a].bi] >= th.hi);
    if (working.length === 0) working = [...s.arms];

    type Eval = { arm: Arm; cur: Ref; ref: Ref | null; reason: RepEvent["cheat_reason"] };
    const evals: Eval[] = working.map((arm) => {
      const cur: Ref = {
        share: share(arm),
        deltMean: mean[ARM_CH[arm].delt],
        deltPeak: peak[ARM_CH[arm].delt],
        upRatio: upRatio(w, arm, peak[ARM_CH[arm].bi], th.upPhaseFrom),
      };
      const ref = this.setRef(s, arm) ?? this.sessionRef(s.ctx, arm, th);
      return { arm, cur, ref, reason: judge(cur, ref, th) };
    });
    const cheating = evals.filter((e) => e.reason !== null);
    const pool = cheating.length > 0 ? cheating : evals;
    const pick = pool.reduce((a, b) => (b.cur.share > a.cur.share ? b : a));
    for (const e of evals) s.armReps[e.arm].push({ ...e.cur, flagged: e.reason !== null });

    // Tempo from the picked arm's biceps: onset -> first 90% of peak, last 90% of peak -> end.
    const bi = ARM_CH[pick.arm].bi;
    const top = 0.9 * peak[bi];
    let iUp = 0;
    while (iUp < w.length - 1 && w[iUp].pct[bi] < top) iUp++;
    let iDown = w.length - 1;
    while (iDown > 0 && w[iDown].pct[bi] < top) iDown--;

    const both = s.arms.includes("R") && s.arms.includes("L");
    const rl = mean[ARM_CH.R.bi] + mean[ARM_CH.L.bi];

    return {
      type: "rep",
      set_id: s.ctx.set_id,
      arm: pick.arm,
      rep: s.reps.length + 1,
      start_ms: w[0].t,
      end_ms: endT,
      peak_pct: peak.map((p) => r3(Math.min(this.cfg.pctMax, p))),
      mean_pct: mean.map((p) => r3(Math.min(this.cfg.pctMax, p))),
      delt_share: r3(pick.cur.share),
      baseline_delt_share: pick.ref === null ? null : r3(pick.ref.share),
      up_delt_ratio: r3(pick.cur.upRatio),
      baseline_up_delt_ratio: pick.ref === null ? null : r3(pick.ref.upRatio),
      cheat: pick.reason !== null,
      cheat_reason: pick.reason,
      r_share: both && rl > EPS ? r3(mean[ARM_CH.R.bi] / rl) : null,
      up_ms: Math.round(w[iUp].t - w[0].t),
      down_ms: Math.round(endT - w[iDown].t),
    };
  }

  /**
   * This set's reference for an arm: once the arm has done `baselineReps` reps, the per-feature
   * max over the unflagged ones among them (max, so a light warm-up rep 1 doesn't make rep 3 look
   * like a cheat). Null before that, or if all of them were flagged.
   */
  private setRef(s: SetState, arm: Arm): Ref | null {
    const first = s.armReps[arm].slice(0, s.th.baselineReps);
    if (first.length < s.th.baselineReps) return null;
    // A rep that would be a blatant cheat on its own is never the clean reference.
    const clean = first.filter((r) => !r.flagged && plausibleRef(r, s.th));
    if (clean.length === 0) return null;
    return {
      share: Math.max(...clean.map((r) => r.share)),
      deltMean: Math.max(...clean.map((r) => r.deltMean)),
      deltPeak: Math.max(...clean.map((r) => r.deltPeak)),
      upRatio: Math.max(...clean.map((r) => r.upRatio)),
    };
  }

  private refKey(ctx: SetContext, arm: Arm): string {
    return `${arm}|${ctx.exercise}|${ctx.variant}|${ctx.load_lb ?? ""}`;
  }

  /** The last clean reference for this arm + exercise + variant + load earlier in this session. */
  private sessionRef(ctx: SetContext, arm: Arm, th: RepThresholds): Ref | null {
    if (this.sessionRefs.session !== ctx.session_id) return null;
    const ref = this.sessionRefs.refs.get(this.refKey(ctx, arm)) ?? null;
    // After an MVC raise a reference can turn out blatant (a too-low MVC hid a delt-led rep): drop it.
    return ref && plausibleRef(ref, th) ? ref : null;
  }

  private closeSet(): SetEndEvent {
    const s = this.set!;
    this.set = null;
    if (this.sessionRefs.session !== s.ctx.session_id) this.sessionRefs = { session: s.ctx.session_id, refs: new Map() };
    for (const arm of s.arms) {
      const ref = this.setRef(s, arm);
      if (ref) this.sessionRefs.refs.set(this.refKey(s.ctx, arm), ref);
    }
    const reps = s.reps;
    const cheats = reps.filter((r) => r.cheat).length;
    const first = reps.find((r) => r.cheat)?.rep ?? null;
    const ev: SetEndEvent = {
      type: "set_end",
      set_id: s.ctx.set_id,
      reps,
      clean: reps.length - cheats,
      cheats,
      first_cheat_rep: first,
      decision: this.decide(s.ctx, reps, cheats, first),
    };
    // Self-calibrating MVC: a set with reps raises each channel's MVC to its own p99 (never lowers).
    // The refs saved above are rescaled by setCalibration, so the next set stays consistent.
    if (this.cfg.autoRaiseMvc && reps.length > 0 && s.raw[0].length > 0) {
      const before = this.cal?.mvc.join(",");
      const c = this.raiseMvc([s.raw], this.cfg.autoRaisePercentile);
      if (c.mvc.join(",") !== before) ev.calibration = c;
    }
    return ev;
  }

  /** Plan rules (data/coach/plan.json, values in config). Never a load change. */
  private decide(ctx: SetContext, reps: RepEvent[], cheats: number, first: number | null): CoachDecision {
    const cfg = this.cfg;
    const th = thresholdsFor(cfg, ctx.variant);
    if (this.earlyStreak.session !== ctx.session_id) this.earlyStreak = { session: ctx.session_id, count: 0 };
    if (reps.length === 0) return { next: "continue", reason: "No reps detected in this set." };

    const early = first !== null && first < cfg.earlyCheatBeforeRep;
    this.earlyStreak.count = early ? this.earlyStreak.count + 1 : 0;
    const streak = this.earlyStreak.count;
    const same = "Same weight.";

    if (cheats > cfg.maxCheatRepsPerSet) {
      const allows = `${cfg.maxCheatRepsPerSet} cheat rep${cfg.maxCheatRepsPerSet === 1 ? "" : "s"}`;
      return {
        next: "stop_at_first_cheat_rest_longer",
        reason: `${cheats} cheat reps (first at rep ${first}); the plan allows ${allows}. Next set, stop at the first cheat and rest longer. ${same}`,
      };
    }

    if (early && streak >= cfg.earlyCheatSetsInRow) {
      const sets = streak === 1 ? "" : ` in ${streak} sets in a row`;
      return {
        next: "stop_at_first_cheat_rest_longer",
        reason: `Delt took over at rep ${first}, before rep ${cfg.earlyCheatBeforeRep}${sets}. Next set: stop at the first cheat rep and rest longer. ${same}`,
      };
    }

    const fast = reps.filter((r) => r.up_ms < th.fastUpMs).length;
    if (reps.length >= cfg.minRepsForTempo && fast / reps.length > cfg.fastUpFraction) {
      return {
        next: "slow_the_tempo",
        reason: `${fast} of ${reps.length} reps came up in under ${th.fastUpMs} ms. Slow the lift: about 1 s up, 2 s down. ${same}`,
      };
    }

    const parts: string[] = [];
    if (cheats === 0) parts.push(`All ${reps.length} reps clean.`);
    else parts.push(`${reps.length - cheats} clean, ${cheats} cheat (first at rep ${first}).`);
    if (early) {
      parts.push(
        `Delt took over before rep ${cfg.earlyCheatBeforeRep}; if the next set does that too, stop at the first cheat and rest longer.`,
      );
    }
    parts.push(same);
    return { next: "continue", reason: parts.join(" ") };
  }
}
