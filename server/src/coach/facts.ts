import type { Arm, RepEvent, SetEndEvent } from "./types.js";

/** Channel indices per arm (BUILD.md channel map). */
export const ARM_CH: Record<Arm, { bi: number; delt: number }> = { R: { bi: 0, delt: 1 }, L: { bi: 2, delt: 3 } };

export const r2 = (x: number | null | undefined): number | null =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function repFacts(r: RepEvent) {
  const ch = ARM_CH[r.arm] ?? ARM_CH.R;
  return {
    rep: r.rep,
    arm: r.arm,
    cheat: r.cheat,
    cheat_reason: r.cheat_reason,
    delt_share: r2(r.delt_share),
    biceps_mean_pct_mvc: r2(r.mean_pct?.[ch.bi]),
    biceps_peak_pct_mvc: r2(r.peak_pct?.[ch.bi]),
    delt_peak_pct_mvc: r2(r.peak_pct?.[ch.delt]),
    r_share: r2(r.r_share),
    up_ms: Math.round(r.up_ms),
    down_ms: Math.round(r.down_ms),
  };
}

/** Numbers the coach may quote, computed by code so the LLM never does math. */
export function setFacts(set: SetEndEvent) {
  const reps = set.reps.map(repFacts);
  const cheatReps = set.reps.filter((r) => r.cheat);
  const cleanReps = set.reps.filter((r) => !r.cheat);
  const rShares = set.reps.map((r) => r.r_share).filter((x): x is number => x != null && Number.isFinite(x));
  return {
    set_id: set.set_id,
    total_reps: set.reps.length,
    clean: set.clean,
    cheats: set.cheats,
    cheat_reps: cheatReps.map((r) => r.rep),
    first_cheat_rep: set.first_cheat_rep,
    avg_delt_share: r2(avg(set.reps.map((r) => r.delt_share))),
    avg_delt_share_clean_reps: r2(avg(cleanReps.map((r) => r.delt_share))),
    avg_delt_share_cheat_reps: r2(avg(cheatReps.map((r) => r.delt_share))),
    avg_r_share: r2(avg(rShares)),
    decision: set.decision,
    reps,
  };
}

const DECISION_LINE: Record<string, string> = {
  continue: "Same weight, keep going.",
  stop_at_first_cheat_rest_longer: "Next set, stop at the first cheat and rest longer.",
  slow_the_tempo: "Slow the tempo next set.",
};

export function decisionLine(next: string): string {
  return DECISION_LINE[next] ?? "Same weight, keep going.";
}

/** Deterministic summary: used when Gemini is down or its line breaks a rule. */
export function fallbackSummary(set: SetEndEvent): string {
  const f = setFacts(set);
  const pct = (x: number | null) => (x == null ? "" : `${Math.round(x * 100)} percent`);
  let first: string;
  if (f.total_reps === 0) first = "No reps counted.";
  else if (f.cheats === 0) first = `${f.total_reps} reps, all clean, delt share ${pct(f.avg_delt_share)}.`;
  else
    first =
      `${f.total_reps} reps, ${f.cheats} cheat${f.cheats > 1 ? "s" : ""}` +
      (f.first_cheat_rep ? `, delt took over from rep ${f.first_cheat_rep}.` : ".");
  return `${first} ${decisionLine(set.decision?.next)}`;
}

/**
 * True if a line talks about changing the weight. The plan holds load constant (35 lb), so any
 * such line from the LLM is rejected and replaced with the code summary.
 */
export function mentionsLoadChange(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(same|hold|keep|stay at|stick with)\b[^.]{0,20}\b(weight|load|35)/.test(t)) {
    // "same weight" is allowed; still check for an explicit change elsewhere
    const stripped = t.replace(/\b(same|hold|keep|stay at|stick with)\b[^.]{0,20}\b(weight|load|35)[a-z ]*/g, "");
    return mentionsLoadChange(stripped);
  }
  return (
    /\b(add|adding|drop|dropping|increase|increasing|decrease|decreasing|lower|lowering|reduce|reducing|raise|raising|bump|bumping|change|changing)\b[^.]{0,25}\b(weight|load|lbs?|pounds|plates?|dumbbells?|band)\b/.test(t) ||
    /\b(go|going|move|moving|grab|try)\s+(a\s+)?(heavier|lighter)\b/.test(t) ||
    /\b(heavier|lighter)\s+(weight|dumbbells?|band|load)\b/.test(t) ||
    /\b\d+\s*(lb|lbs|pounds)\b/.test(t.replace(/\b35\s*(lb|lbs|pounds)\b/g, ""))
  );
}
