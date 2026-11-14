import { DEFAULT_CONFIG } from "../engine/index.js";
import { thresholdsFor } from "../engine/config.js";
import type { RepEvent, Variant } from "./types.js";

/** Call-out thresholds (code decides; the voice just says it). */
export const CUE_CONFIG = {
  /** r_share = R_bi / (R_bi + L_bi). Outside this band = one side slacking (CLAUDE.md: 0.40–0.60). */
  rShareLow: 0.4,
  rShareHigh: 0.6,
  maxCountedRep: 20,
};

export interface PickCueOptions {
  /** Preacher cheats are elbows lifting off the pad -> "elbows_in". Others -> "delt_took_over". */
  variant?: Variant;
}

/**
 * The single clip key for an instant call-out after a rep. Pure code, never the LLM.
 * Priority: cheat > L/R imbalance > too fast up > rep count.
 */
export function pickCue(rep: RepEvent, opts: PickCueOptions = {}): string | null {
  if (!rep || rep.type !== "rep") return null;
  if (rep.cheat) return opts.variant === "preacher" ? "elbows_in" : "delt_took_over";
  if (rep.r_share != null && Number.isFinite(rep.r_share)) {
    if (rep.r_share > CUE_CONFIG.rShareHigh) return "left_slacking";
    if (rep.r_share < CUE_CONFIG.rShareLow) return "right_slacking";
  }
  // Same "very fast up" definition the engine uses for slow_the_tempo (per variant, default 300 ms).
  const fastUpMs = thresholdsFor(DEFAULT_CONFIG, opts.variant ?? "standing").fastUpMs;
  if (rep.up_ms > 0 && rep.up_ms < fastUpMs) return "slow_it_down";
  if (rep.rep >= 1 && rep.rep <= CUE_CONFIG.maxCountedRep) return `rep_${rep.rep}`;
  return "clean_rep";
}

/**
 * The full stitched call-out, e.g. ["rep_6", "delt_took_over"] -> "Rep six. Your delt took over."
 * Pass straight to `LWAudio.playClip(keys)`.
 */
export function pickCueSequence(rep: RepEvent, opts: PickCueOptions = {}): string[] {
  const cue = pickCue(rep, opts);
  if (!cue) return [];
  if (cue.startsWith("rep_") || cue === "clean_rep") return [cue];
  const n = rep.rep >= 1 && rep.rep <= CUE_CONFIG.maxCountedRep ? [`rep_${rep.rep}`] : [];
  return [...n, cue];
}

/** Clip for the end of a set, from the engine's decision. */
export function pickSetEndCue(set: { cheats: number; reps: unknown[]; decision: { next: string } }): string {
  if (set.decision?.next === "stop_at_first_cheat_rest_longer") return "stop_and_rest";
  if (set.reps.length > 0 && set.cheats === 0) return "nice_set";
  return "set_done";
}
