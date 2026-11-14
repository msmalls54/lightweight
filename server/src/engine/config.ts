// Every threshold the signal engine uses lives here. Tune these, not the logic.
// Values in %MVC are fractions (0.35 = 35% of that channel's calibrated max).

import type { Variant } from "./types.js";

/** Thresholds that may differ per curl variant (see `variantOverrides`). */
export interface RepThresholds {
  /** Rep starts when the active biceps crosses UP through this (%MVC). */
  hi: number;
  /** Rep ends when the active biceps drops below this (%MVC)... */
  lo: number;
  /**
   * ...or below `endPeakFrac * rep peak`, whichever is higher, capped at `endLevelMax`.
   * Ends hard reps on the way down instead of waiting out the slow envelope decay.
   */
  endPeakFrac: number;
  endLevelMax: number;
  /** A new rep starts at max(hi, valley since the last rep + restartRise). */
  restartRise: number;
  /** Reps shorter than this (onset above `lo` → end) are discarded as blips. */
  minRepMs: number;
  /** After a rep ends, a new rep can't start for this long (refractory). */
  minGapMs: number;
  /** Up phase = biceps climbing from this fraction of its rep peak to 90% of it. */
  upPhaseFrom: number;
  /** Cheat (main rule): up-phase delt/biceps ratio at least this many times the reference... */
  upRatioMult: number;
  /** ...and at least this much above it (both must hold). */
  upRatioJump: number;
  /** No reference yet: flag an up-phase delt/biceps ratio above this. */
  fallbackUpRatio: number;
  /** Cheat: delt_share above the clean reference by more than this. */
  deltShareJump: number;
  /** Cheat: delt mean %MVC at least this many times the reference... */
  deltMeanRatio: number;
  /** ...and at least this much above it (both must hold). */
  deltMeanJump: number;
  /** Cheat: delt peak %MVC above max(deltPeakMax, reference peak + deltPeakJump). */
  deltPeakMax: number;
  deltPeakJump: number;
  /**
   * Reference = per-feature max over the unflagged reps among the arm's first N reps of the set.
   * Before that: the last clean reference from an earlier set (same session, exercise, variant, load).
   */
  baselineReps: number;
  /** No reference yet (first reps of the session): flag only a delt share above this. */
  fallbackShareMax: number;
  /** Up phase (onset → 90% of peak) faster than this counts as "very fast". */
  fastUpMs: number;
}

export interface EngineConfig extends RepThresholds {
  /** Rest/MVC used before calibration (raw 14-bit ENV). */
  defaultRest: number;
  defaultMvc: number;
  /** %MVC clamp for live frames and reported peak/mean values. */
  pctMax: number;
  /** %MVC clamp for detection and scoring (higher, so a too-low MVC doesn't flatten reps). */
  detectPctMax: number;
  /** After a set with reps, raise each channel's MVC to the set's own percentile (raise-only). */
  autoRaiseMvc: boolean;
  autoRaisePercentile: number;
  /** Raw samples kept per set for autoRaiseMvc (200 Hz x 5 min). */
  maxSetSamples: number;
  /** Calibration: reject a channel whose (mvc - rest) is below this (raw counts). */
  minMvcSpan: number;
  /** Calibration: rest above this means the channel isn't relaxed or is on RAW (sits ~8150). */
  restMax: number;
  /** Calibration: MVC = this percentile of the flex window (robust to spikes). */
  mvcPercentile: number;
  /** Live frames: one per this many ms of sample time (~20 Hz). */
  liveIntervalMs: number;
  /** A set auto-ends after this long without a rep (only once it has at least one rep). */
  autoEndMs: number;
  /** Max pre-onset samples kept while the biceps hovers between lo and hi. */
  maxPreOnsetMs: number;
  /** Device time jumping back more than this = device restart; rebase the timeline. */
  timeResetMs: number;
  // CoachDecision, values from data/coach/plan.json rules (copied here, no file I/O).
  /** plan.rules.fatigue_signal: "delt takes over before rep 6". */
  earlyCheatBeforeRep: number;
  /** plan.rules.fatigue_signal: "...in two sets in a row". Set to 1 to fire on the first such set. */
  earlyCheatSetsInRow: number;
  /** plan.rules.max_cheat_reps_per_set: more cheat reps than this → stop_at_first_cheat_rest_longer. */
  maxCheatRepsPerSet: number;
  /** slow_the_tempo when more than this fraction of reps have a very fast up phase. */
  fastUpFraction: number;
  /** ...and the set has at least this many reps. */
  minRepsForTempo: number;
  /** Per-variant threshold overrides. */
  variantOverrides: Partial<Record<Variant, Partial<RepThresholds>>>;
}

export const DEFAULT_CONFIG: EngineConfig = {
  // Rep detection (tuned on data/coach/history/raw/2026-11-13-bench.csv).
  hi: 0.35,
  lo: 0.15,
  // End at 30% of the rep peak, between 0.15 and 0.4. Up to 0.4 because a too-low biceps MVC
  // (FLEX hold < curls) lifts the valleys between heavy reps to ~0.3.
  endPeakFrac: 0.3,
  endLevelMax: 0.4,
  restartRise: 0.2,
  // Spec says ~0.6 s. The real swing rep 2 (Nov 13) is only 0.50 s above lo, so 0.4 s.
  minRepMs: 400,
  minGapMs: 400,
  // Cheat flag (tuned on the Nov 13 band CSV and the two Nov 14 35 lb CSVs).
  upPhaseFrom: 0.3,
  upRatioMult: 1.35,
  upRatioJump: 0.15,
  fallbackUpRatio: 1.2,
  deltShareJump: 0.15,
  deltMeanRatio: 1.5,
  deltMeanJump: 0.15,
  deltPeakMax: 0.5,
  deltPeakJump: 0.4,
  baselineReps: 2,
  fallbackShareMax: 0.6,
  fastUpMs: 300,

  defaultRest: 550,
  defaultMvc: 14960,
  pctMax: 1.5,
  detectPctMax: 3,
  autoRaiseMvc: true,
  autoRaisePercentile: 0.99,
  maxSetSamples: 60_000,
  minMvcSpan: 1000,
  restMax: 4000,
  mvcPercentile: 0.95,
  liveIntervalMs: 50,
  autoEndMs: 10_000,
  maxPreOnsetMs: 3000,
  timeResetMs: 2000,

  earlyCheatBeforeRep: 6,
  earlyCheatSetsInRow: 2,
  maxCheatRepsPerSet: 1,
  fastUpFraction: 0.5,
  minRepsForTempo: 3,

  variantOverrides: {},
};

export function resolveConfig(partial?: Partial<EngineConfig>): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    variantOverrides: { ...DEFAULT_CONFIG.variantOverrides, ...partial?.variantOverrides },
  };
}

/** Thresholds for one set: base config + that variant's overrides. */
export function thresholdsFor(cfg: EngineConfig, variant: Variant): RepThresholds {
  const o = cfg.variantOverrides[variant] ?? {};
  return {
    hi: o.hi ?? cfg.hi,
    lo: o.lo ?? cfg.lo,
    endPeakFrac: o.endPeakFrac ?? cfg.endPeakFrac,
    endLevelMax: o.endLevelMax ?? cfg.endLevelMax,
    restartRise: o.restartRise ?? cfg.restartRise,
    minRepMs: o.minRepMs ?? cfg.minRepMs,
    minGapMs: o.minGapMs ?? cfg.minGapMs,
    upPhaseFrom: o.upPhaseFrom ?? cfg.upPhaseFrom,
    upRatioMult: o.upRatioMult ?? cfg.upRatioMult,
    upRatioJump: o.upRatioJump ?? cfg.upRatioJump,
    fallbackUpRatio: o.fallbackUpRatio ?? cfg.fallbackUpRatio,
    deltShareJump: o.deltShareJump ?? cfg.deltShareJump,
    deltMeanRatio: o.deltMeanRatio ?? cfg.deltMeanRatio,
    deltMeanJump: o.deltMeanJump ?? cfg.deltMeanJump,
    deltPeakMax: o.deltPeakMax ?? cfg.deltPeakMax,
    deltPeakJump: o.deltPeakJump ?? cfg.deltPeakJump,
    baselineReps: o.baselineReps ?? cfg.baselineReps,
    fallbackShareMax: o.fallbackShareMax ?? cfg.fallbackShareMax,
    fastUpMs: o.fastUpMs ?? cfg.fastUpMs,
  };
}
