import { DEFAULT_CONFIG } from "../engine/index.js";
import { thresholdsFor } from "../engine/config.js";
import type { RepEvent, SetEndEvent, Variant } from "./types.js";

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
  /**
   * The previous rep of the same set, for the 2-in-a-row imbalance rule. Optional: by default the
   * picker remembers each set's reps itself (keyed by set_id).
   */
  prevRep?: RepEvent | null;
}

type Side = "left_slacking" | "right_slacking";

/**
 * L/R imbalance for one rep, or null. Only when BOTH biceps actually curled (peak >= the engine's
 * rep threshold), the same guard as setFacts' balance: a one-arm rep has r_share ~0 or ~1, which is
 * not an imbalance.
 */
export function repImbalance(rep: RepEvent | null | undefined): Side | null {
  if (!rep || rep.r_share == null || !Number.isFinite(rep.r_share)) return null;
  const hi = DEFAULT_CONFIG.hi;
  if (!((rep.peak_pct?.[0] ?? 0) >= hi && (rep.peak_pct?.[2] ?? 0) >= hi)) return null;
  if (rep.r_share > CUE_CONFIG.rShareHigh) return "left_slacking";
  if (rep.r_share < CUE_CONFIG.rShareLow) return "right_slacking";
  return null;
}

/** set_id -> rep number -> that rep's imbalance (bounded). */
const seen = new Map<string, Map<number, Side | null>>();
function remember(rep: RepEvent, side: Side | null) {
  let m = seen.get(rep.set_id);
  if (!m) {
    if (seen.size > 50) seen.delete(seen.keys().next().value!);
    seen.set(rep.set_id, (m = new Map()));
  }
  m.set(rep.rep, side);
}

/** Test hook. */
export function _resetCueMemory(): void {
  seen.clear();
}

/**
 * The single clip key for an instant call-out after a rep. Pure code, never the LLM.
 * Priority: cheat > L/R imbalance (2 reps in a row, same side, both arms curled) > too fast up > rep count.
 */
export function pickCue(rep: RepEvent, opts: PickCueOptions = {}): string | null {
  if (!rep || rep.type !== "rep") return null;
  const side = repImbalance(rep);
  remember(rep, side);
  if (rep.cheat) return opts.variant === "preacher" ? "elbows_in" : "delt_took_over";
  if (side) {
    if (opts.prevRep !== undefined) {
      if (repImbalance(opts.prevRep) === side) return side;
    } else {
      // Once per streak: on the 2nd imbalanced rep in a row (same side), not again until it breaks.
      const m = seen.get(rep.set_id)!;
      let streak = 1;
      while (m.get(rep.rep - streak) === side) streak++;
      if (streak === 2) return side;
    }
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

const COUNT_CLIP = ["all_clean", "one_cheat", "two_cheats", "three_cheats", "four_cheats"];

/**
 * Instant, pre-generated set-end feedback (2–3 clips, ~3 s) to play the moment the set ends,
 * while the Gemini summary is still being written and spoken. Pure code.
 *   ["set_done", "all_clean"] | ["set_done", "learning_clean_rep"]
 *   ["set_done", "two_cheats", "big_swing"] | ["set_done", "many_cheats", "shoulder_late"]
 * Pass to LWAudio.playClip(keys): sequences starting with "set_done" wait their turn instead of
 * being dropped by the cooldown.
 */
export function pickSetEndCueSequence(set: SetEndEvent): string[] {
  const n = set.reps?.length ?? 0;
  if (!n) return ["set_done"];
  if (set.cheats === 0) {
    const learning = set.reps.every((r) => r.baseline_up_delt_ratio == null);
    return ["set_done", learning ? "learning_clean_rep" : "all_clean"];
  }
  const out = ["set_done", COUNT_CLIP[set.cheats] ?? "many_cheats"];
  const cheatNos = set.reps.filter((r) => r.cheat).map((r) => r.rep);
  const last = Math.max(...set.reps.map((r) => r.rep));
  const runToEnd = cheatNos.length >= 2 && cheatNos.every((c, i) => c === cheatNos[0] + i) && cheatNos.at(-1) === last;
  const bigSwing = set.reps.some((r) => {
    const b = r.baseline_up_delt_ratio;
    return r.cheat && r.up_delt_ratio != null && b != null && b > 0 && r.up_delt_ratio / b >= 4;
  });
  if (runToEnd) out.push("shoulder_late");
  else if (bigSwing) out.push("big_swing");
  return out;
}

/** Clip for the end of a set, from the engine's decision. */
export function pickSetEndCue(set: { cheats: number; reps: unknown[]; decision: { next: string } }): string {
  if (set.decision?.next === "stop_at_first_cheat_rest_longer") return "stop_and_rest";
  if (set.reps.length > 0 && set.cheats === 0) return "nice_set";
  return "set_done";
}
