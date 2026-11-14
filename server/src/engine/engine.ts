// The signal engine: raw batches in, live frames / reps / set ends out. Pure code, no I/O.
// Code decides cheats; the LLM only explains them.

import { computeCalibration, effectiveScale, toPct } from "./calibration.js";
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

interface SetState {
  ctx: SetContext;
  arms: Arm[];
  th: RepThresholds;
  reps: RepEvent[];
  /** delt_share history per arm (reps where that arm worked), for the baseline. */
  shares: Record<Arm, number[]>;
  phase: "idle" | "rep";
  /** Samples since the biceps rose above lo (onset), while idle. */
  pre: Sample[];
  rep: Sample[];
  repPeak: number;
  armed: boolean;
  lastEndLevel: number;
  lastRepEndT: number | null;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const EPS = 1e-9;

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

  setCalibration(c: Calibration): void {
    this.cal = { rest: [...c.rest], mvc: [...c.mvc], ok: c.ok, problems: [...c.problems] };
    this.scale = effectiveScale(this.cal, this.cfg);
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
      shares: { R: [], L: [] },
      phase: "idle",
      pre: [],
      rep: [],
      repPeak: 0,
      armed: true,
      lastEndLevel: this.cfg.lo,
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
      const pct = [0, 1, 2, 3].map((c) => {
        const raw = b.ch[c]?.[i];
        return raw === undefined ? 0 : toPct(raw, this.scale.rest[c], this.scale.span[c], this.cfg.pctMax);
      });
      if (t >= this.nextLiveT - 1e-6) {
        out.push({ type: "live", t_ms: t, pct: pct.map(r3) });
        this.nextLiveT = t + this.cfg.liveIntervalMs;
      }
      if (this.set) this.step({ t, pct }, out);
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

    // idle
    if (!s.armed && sig < s.lastEndLevel) s.armed = true;
    if (sig >= th.lo) {
      s.pre.push(x);
      while (s.pre.length > 1 && s.pre[0].t < x.t - this.cfg.maxPreOnsetMs) s.pre.shift();
    } else {
      s.pre = [];
    }
    if (s.armed && sig >= th.hi) {
      if (s.lastRepEndT !== null && x.t - s.lastRepEndT < th.minGapMs) {
        s.armed = false; // too soon after the last rep: same movement, ignore until it drops again
      } else {
        s.phase = "rep";
        s.rep = s.pre.length > 0 ? s.pre : [x];
        s.pre = [];
        s.repPeak = Math.max(...s.rep.map((p) => this.signal(s, p.pct)));
      }
    }

    if (s.reps.length > 0 && s.lastRepEndT !== null && x.t - s.lastRepEndT >= this.cfg.setEndGapMs) {
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
    const endLevel = this.endLevel(s);
    s.phase = "idle";
    s.rep = [];
    s.pre = [];
    s.repPeak = 0;
    s.lastEndLevel = endLevel;
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

    type Eval = { arm: Arm; share: number; baseline: number | null; reason: RepEvent["cheat_reason"] };
    const evals: Eval[] = working.map((arm) => {
      const sh = share(arm);
      const prior = s.shares[arm];
      const baseline =
        prior.length >= th.baselineReps
          ? Math.min(th.baselineCap, prior.slice(0, th.baselineReps).reduce((x, y) => x + y, 0) / th.baselineReps)
          : null;
      const ref = baseline ?? th.baselineCap;
      const reason: RepEvent["cheat_reason"] =
        sh > ref + th.deltShareJump ? "delt_share_jump" : peak[ARM_CH[arm].delt] > th.deltPeakMax ? "delt_peak" : null;
      return { arm, share: sh, baseline, reason };
    });
    const cheating = evals.filter((e) => e.reason !== null);
    const pool = cheating.length > 0 ? cheating : evals;
    const pick = pool.reduce((a, b) => (b.share > a.share ? b : a));
    for (const e of evals) s.shares[e.arm].push(e.share);

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
      peak_pct: peak.map(r3),
      mean_pct: mean.map(r3),
      delt_share: r3(pick.share),
      baseline_delt_share: pick.baseline === null ? null : r3(pick.baseline),
      cheat: pick.reason !== null,
      cheat_reason: pick.reason,
      r_share: both && rl > EPS ? r3(mean[ARM_CH.R.bi] / rl) : null,
      up_ms: Math.round(w[iUp].t - w[0].t),
      down_ms: Math.round(endT - w[iDown].t),
    };
  }

  private closeSet(): SetEndEvent {
    const s = this.set!;
    this.set = null;
    const reps = s.reps;
    const cheats = reps.filter((r) => r.cheat).length;
    const first = reps.find((r) => r.cheat)?.rep ?? null;
    return {
      type: "set_end",
      set_id: s.ctx.set_id,
      reps,
      clean: reps.length - cheats,
      cheats,
      first_cheat_rep: first,
      decision: this.decide(s.ctx, reps, cheats, first),
    };
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
    if (cheats > cfg.maxCheatRepsPerSet) parts.push(`Plan allows ${cfg.maxCheatRepsPerSet} cheat rep per set.`);
    if (early) {
      parts.push(
        `Delt took over before rep ${cfg.earlyCheatBeforeRep}; if the next set does that too, stop at the first cheat and rest longer.`,
      );
    }
    parts.push(same);
    return { next: "continue", reason: parts.join(" ") };
  }
}
