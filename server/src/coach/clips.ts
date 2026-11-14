// Backup coach voice: a set summary stitched from CACHED Alnilam clips (pure code, no TTS call).
// Plays after the set-end sequence ("Set's done. Three cheat reps.") when the Gemini line is late.
import { setFacts } from "./facts.js";
import type { SetEndEvent } from "./types.js";

/** At most this many clips (~1 s each): about 8 s of speech. */
export const CLIP_SUMMARY_MAX = 8;

/** Clip keys this module may use (all defined in src/voice CLIPS). */
export const SUMMARY_CLIP_KEYS = [
  "word_and",
  "right_shoulder_took_over",
  "left_shoulder_took_over",
  "both_shoulders_took_over",
  "late_in_set",
  "from_the_start",
  "a_bit_loose",
  "same_weight_keep_going",
  "stop_first_cheat_next",
  "rest_longer",
  "slow_the_way_up",
  "pin_your_elbows",
  "getting_cleaner",
  "getting_sloppier",
  "learning_clean_rep",
  "all_clean",
  "no_cheats",
] as const;

const DECISION_CLIPS: Record<string, string[]> = {
  continue: ["same_weight_keep_going"],
  stop_at_first_cheat_rest_longer: ["stop_first_cheat_next", "rest_longer"],
  slow_the_tempo: ["slow_the_way_up"],
};

/**
 * The stitched summary, e.g. ["rep_4","word_and","rep_8","right_shoulder_took_over","stop_first_cheat_next","rest_longer"]
 * = "Rep four. And. Rep eight. Right shoulder took over. Stop at the first cheat next set. Rest longer."
 * The count isn't repeated (the set-end sequence just said it). `has(key)` skips clips that aren't cached.
 */
export function buildClipSummary(set: SetEndEvent, has: (key: string) => boolean = () => true): string[] {
  const f = setFacts(set);
  const out: string[] = [];
  const decision = DECISION_CLIPS[set.decision?.next] ?? DECISION_CLIPS.continue;
  const repRef = (ns: number[]) => {
    const refs = ns.filter((n) => n >= 1 && n <= 20).slice(0, 2);
    refs.forEach((n, i) => {
      if (i > 0) out.push("word_and");
      out.push(`rep_${n}`);
    });
  };

  if (f.total_reps === 0) return pick([...decision], has);
  if (f.cheats === 0) {
    if (f.reference_status === "learning") return pick(["learning_clean_rep", ...decision], has);
    if (f.loose_reps.length) {
      repRef(f.loose_reps);
      out.push("a_bit_loose");
    }
    return pick([...out, ...decision], has);
  }

  const cheats = f.reps.filter((r) => r.verdict === "cheat");
  const fatigue = f.cheat_pattern.startsWith("fatigue") || f.cheat_pattern === "late in the set";
  // Which reps: name up to 2 (the biggest swings first), or say when it happened for longer runs.
  if (fatigue && cheats.length >= 3) out.push("late_in_set");
  else if ((f.first_cheat_rep ?? 99) <= 2 && cheats.length >= 3) out.push("from_the_start");
  else repRef((f.big_swing_reps.length ? f.big_swing_reps : f.cheat_reps).slice(0, 2));
  // Which side.
  const arms = new Set(cheats.map((r) => r.arm));
  out.push(arms.size > 1 ? "both_shoulders_took_over" : arms.has("L") ? "left_shoulder_took_over" : "right_shoulder_took_over");
  // Big swings with a "continue" decision still get the form cue.
  if (f.big_swing_reps.length && set.decision?.next === "continue") out.push("pin_your_elbows");
  return pick([...out, ...decision], has);
}

function pick(keys: string[], has: (key: string) => boolean): string[] {
  return keys.filter((k) => has(k)).slice(0, CLIP_SUMMARY_MAX);
}

/** Summary voice: "auto" (Gemini if it's there within 4 s, else clips), "gemini" or "clips". Env LW_SUMMARY_VOICE. */
export type SummaryVoiceMode = "auto" | "gemini" | "clips";
export function summaryVoiceMode(): SummaryVoiceMode {
  const m = String(process.env.LW_SUMMARY_VOICE ?? "auto").trim().toLowerCase();
  return m === "gemini" || m === "clips" ? m : "auto";
}

/** Spread into the server's `coach` events: `{ ...coachVoiceExtras(e) }` -> { clips, voice_mode }. */
export function coachVoiceExtras(set: SetEndEvent): { clips: string[]; voice_mode: SummaryVoiceMode } {
  let clips: string[] = [];
  try {
    clips = buildClipSummary(set);
  } catch {
    /* never block the coach event */
  }
  return { clips, voice_mode: summaryVoiceMode() };
}
