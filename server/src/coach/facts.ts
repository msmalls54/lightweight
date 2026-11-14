import { DEFAULT_CONFIG } from "../engine/index.js";
import { thresholdsFor } from "../engine/config.js";
import type { Arm, RepEvent, SetEndEvent, Variant } from "./types.js";

/** Channel indices per arm (BUILD.md channel map). */
export const ARM_CH: Record<Arm, { bi: number; delt: number }> = { R: { bi: 0, delt: 1 }, L: { bi: 2, delt: 3 } };

/** How the coach labels reps. Code labels them; the LLM only explains the label. */
export const DETAIL_CONFIG = {
  /** Cheat rep whose up-phase delt ratio is at least this many times the clean reference = a full swing. */
  bigSwingX: 4,
  /** Clean rep at or above this multiple = a near-miss worth mentioning. */
  nearMissX: 1.5,
  /** Set-level balance verdict uses the plan target (plan.json: R/L biceps share 0.45–0.55). */
  balanceLow: 0.45,
  balanceHigh: 0.55,
  /** Per-rep imbalance flag (CLAUDE.md: outside 0.40–0.60), same as the live call-out. */
  repBalanceLow: 0.4,
  repBalanceHigh: 0.6,
};

export const r2 = (x: number | null | undefined): number | null =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
const r1 = (x: number | null | undefined): number | null =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10;
const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (x: number | null) => (x == null ? null : Math.round(x * 100));
const side = (a: Arm) => (a === "R" ? "right" : "left");

export type RepLabel = "big_swing" | "mild_cheat" | "cheat" | "near_miss" | "clean";

/** Up-phase delt ratio as a multiple of the clean reference (null before a reference exists). */
export function upRatioX(r: RepEvent): number | null {
  const base = r.baseline_up_delt_ratio;
  if (r.up_delt_ratio == null || base == null || !(base > 0)) return null;
  return r.up_delt_ratio / base;
}

export function labelRep(r: RepEvent): RepLabel {
  const x = upRatioX(r);
  if (r.cheat) return x == null ? "cheat" : x >= DETAIL_CONFIG.bigSwingX ? "big_swing" : "mild_cheat";
  return x != null && x >= DETAIL_CONFIG.nearMissX ? "near_miss" : "clean";
}

function fastUpMs(variant?: Variant): number {
  return thresholdsFor(DEFAULT_CONFIG, variant ?? "standing").fastUpMs;
}

export function repFacts(r: RepEvent, variant?: Variant) {
  const ch = ARM_CH[r.arm] ?? ARM_CH.R;
  const x = upRatioX(r);
  return {
    rep: r.rep,
    /** Bilateral reps: the cheating arm if any, else the arm with the higher delt share. */
    arm: r.arm,
    verdict: r.cheat ? "cheat" : "clean",
    label: labelRep(r),
    cheat_reason: r.cheat_reason,
    /** Front delt vs biceps on the way up, as a multiple of this set's clean reps (8.5 = 8.5x harder). */
    up_delt_x_clean: r1(x),
    up_delt_ratio: r2(r.up_delt_ratio),
    clean_reference_up_delt_ratio: r2(r.baseline_up_delt_ratio ?? null),
    delt_share: r2(r.delt_share),
    biceps_peak_pct: { R: pct(r.peak_pct?.[0] ?? null), L: pct(r.peak_pct?.[2] ?? null) },
    delt_peak_pct: { R: pct(r.peak_pct?.[1] ?? null), L: pct(r.peak_pct?.[3] ?? null) },
    biceps_mean_pct_mvc: r2(r.mean_pct?.[ch.bi]),
    biceps_peak_pct_mvc: r2(r.peak_pct?.[ch.bi]),
    delt_peak_pct_mvc: r2(r.peak_pct?.[ch.delt]),
    r_share: r2(r.r_share),
    up_ms: Math.round(r.up_ms),
    /** Rough: last 90%-of-peak sample -> rep end. Not the whole lowering; don't judge the negative from it. */
    down_ms: Math.round(r.down_ms),
    fast_up: r.up_ms > 0 && r.up_ms < fastUpMs(variant),
  };
}

/** Numbers the coach may quote, computed by code so the LLM never does math. */
export function setFacts(set: SetEndEvent, variant?: Variant) {
  const reps = set.reps.map((r) => repFacts(r, variant));
  const cheatReps = set.reps.filter((r) => r.cheat);
  const cleanReps = set.reps.filter((r) => !r.cheat);
  const rShares = set.reps.map((r) => r.r_share).filter((x): x is number => x != null && Number.isFinite(x));
  const byLabel = (l: RepLabel) => reps.filter((r) => r.label === l).map((r) => r.rep);
  const withX = reps.filter((r) => r.up_delt_x_clean != null);
  const worst = withX.length ? withX.reduce((a, b) => (b.up_delt_x_clean! > a.up_delt_x_clean! ? b : a)) : null;
  const n = set.reps.length;

  // Timing pattern of the cheats.
  const cheatNos = cheatReps.map((r) => r.rep);
  const lastRep = n ? Math.max(...set.reps.map((r) => r.rep)) : 0;
  const runToEnd = cheatNos.length > 0 && cheatNos.every((c, i) => c === cheatNos[0] + i) && cheatNos.at(-1) === lastRep;
  const cheat_pattern =
    cheatNos.length === 0
      ? "none"
      : runToEnd && cheatNos.length >= 2
        ? "fatigue: every rep from the first cheat to the end"
        : cheatNos.every((c) => c > n / 2)
          ? "late in the set"
          : "scattered";

  // Tempo.
  const ups = set.reps.map((r) => r.up_ms).filter((x) => x > 0);
  const fastReps = reps.filter((r) => r.fast_up).map((r) => r.rep);
  const cheatUp = avg(cheatReps.map((r) => r.up_ms).filter((x) => x > 0));
  const cleanUp = avg(cleanReps.map((r) => r.up_ms).filter((x) => x > 0));

  // L vs R (both arms on: r_share filled).
  const rAvg = avg(rShares);
  const biR = avg(set.reps.map((r) => r.mean_pct?.[0]).filter((x): x is number => Number.isFinite(x)));
  const biL = avg(set.reps.map((r) => r.mean_pct?.[2]).filter((x): x is number => Number.isFinite(x)));
  const balance =
    rAvg == null
      ? null
      : {
          avg_r_share: r2(rAvg),
          right_biceps_share_pct: pct(rAvg),
          verdict:
            rAvg > DETAIL_CONFIG.balanceHigh
              ? "right doing more (left slacking)"
              : rAvg < DETAIL_CONFIG.balanceLow
                ? "left doing more (right slacking)"
                : "balanced",
          r_biceps_mean_pct: pct(biR),
          l_biceps_mean_pct: pct(biL),
          reps_outside_40_60: reps
            .filter((r) => r.r_share != null && (r.r_share < DETAIL_CONFIG.repBalanceLow || r.r_share > DETAIL_CONFIG.repBalanceHigh))
            .map((r) => r.rep),
        };

  return {
    set_id: set.set_id,
    total_reps: n,
    clean: set.clean,
    cheats: set.cheats,
    cheat_reps: cheatNos,
    big_swing_reps: byLabel("big_swing"),
    mild_cheat_reps: byLabel("mild_cheat"),
    near_miss_reps: byLabel("near_miss"),
    first_cheat_rep: set.first_cheat_rep,
    cheat_pattern,
    worst_rep: worst ? { rep: worst.rep, arm: worst.arm, up_delt_x_clean: worst.up_delt_x_clean } : null,
    mean_clean_up_delt_ratio: r2(avg(cleanReps.map((r) => r.up_delt_ratio).filter((x): x is number => x != null))),
    avg_delt_share: r2(avg(set.reps.map((r) => r.delt_share))),
    avg_delt_share_clean_reps: r2(avg(cleanReps.map((r) => r.delt_share))),
    avg_delt_share_cheat_reps: r2(avg(cheatReps.map((r) => r.delt_share))),
    avg_r_share: r2(rAvg),
    tempo: {
      median_up_ms: ups.length ? Math.round(median(ups)!) : null,
      fast_up_threshold_ms: fastUpMs(variant),
      fast_up_reps: fastReps,
      cheat_reps_avg_up_ms: cheatUp == null ? null : Math.round(cheatUp),
      clean_reps_avg_up_ms: cleanUp == null ? null : Math.round(cleanUp),
      cheats_came_with_fast_tempo: cheatReps.length > 0 && cheatReps.filter((r) => r.up_ms > 0 && r.up_ms < fastUpMs(variant)).length > cheatReps.length / 2,
    },
    balance,
    decision: set.decision,
    reps,
  };
}

/** Compact comparison to the last history day (works for the Nov 13 bench file and writeTodayHistory files). */
export function lastSessionFacts(lastDay: unknown) {
  if (!lastDay || typeof lastDay !== "object") return null;
  const d = lastDay as { date?: string; kind?: string; sets?: Array<Record<string, unknown>> };
  if (!Array.isArray(d.sets)) return null;
  return {
    date: d.date,
    kind: d.kind,
    sets: d.sets.map((s, i) => ({
      set: i + 1,
      label: (s.style_instructed as string) ?? (s.exercise as string) ?? null,
      avg_delt_share: r2(s.avg_delt_share as number),
      cheats: (s.cheats as number) ?? null,
      first_cheat_rep: (s.first_cheat_rep as number) ?? null,
      reps: Array.isArray(s.reps) ? s.reps.length : null,
    })),
  };
}

const DECISION_LINE: Record<string, string> = {
  continue: "Same weight, keep going.",
  stop_at_first_cheat_rest_longer: "Next set, stop at the first cheat and rest longer, same weight.",
  slow_the_tempo: "Slow the tempo next set, same weight.",
};

export function decisionLine(next: string): string {
  return DECISION_LINE[next] ?? "Same weight, keep going.";
}

/** "4", "4 and 8", "4, 5 and 8" */
export function listReps(ns: number[]): string {
  if (ns.length <= 1) return ns.join("");
  return `${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`;
}

/** Multiples for a group of reps: "9 times", "9 and 7 times", "8 to 12 times" (unit "x" for the card). */
function multiples(rs: ReturnType<typeof repFacts>[], unit: "times" | "x"): string {
  const v = rs.map((r) => r.up_delt_x_clean).filter((x): x is number => x != null).map((x) => Math.round(x));
  if (!v.length) return "";
  const u = unit === "x" ? "x" : " times";
  if (v.length === 1) return `${v[0]}${u}`;
  if (v.length === 2) return v[0] === v[1] ? `${v[0]}${u}` : `${v[0]} and ${v[1]}${u}`;
  const lo = Math.min(...v), hi = Math.max(...v);
  return lo === hi ? `${lo}${u}` : `${lo} to ${hi}${u}`;
}

/** Deterministic spoken summary: used when Gemini is down or its line breaks a rule. */
export function fallbackSummary(set: SetEndEvent): string {
  const f = setFacts(set);
  if (f.total_reps === 0) return `No reps counted. ${decisionLine(set.decision?.next)}`;
  if (f.cheats === 0) return `${f.total_reps} reps, all clean. ${decisionLine(set.decision?.next)}`;
  const parts: string[] = [];
  const cheatsF = f.reps.filter((r) => r.verdict === "cheat");
  if (f.cheat_pattern.startsWith("fatigue") && cheatsF.length >= 3) {
    const m = multiples(cheatsF, "times");
    return `From rep ${f.first_cheat_rep} on, your ${side(cheatsF[0].arm)} shoulder took over${m ? `, ${m} harder than your clean reps` : ""}. ${decisionLine(set.decision?.next)}`;
  }
  const big = f.reps.filter((r) => r.label === "big_swing");
  const other = f.reps.filter((r) => r.verdict === "cheat" && r.label !== "big_swing");
  if (big.length) {
    const arm = side(big[0].arm);
    parts.push(
      `Rep${big.length > 1 ? "s" : ""} ${listReps(big.map((r) => r.rep))}: your ${arm} shoulder fired ${multiples(big, "times")} harder than your clean reps, that's a swing.`,
    );
  }
  if (other.length && !big.length && other.every((r) => r.up_delt_x_clean == null)) {
    // No clean reference yet: explain with the whole-rep delt share instead of a multiple.
    const share = Math.round(avg(other.map((r) => r.delt_share ?? 0))! * 100);
    parts.push(`Rep${other.length > 1 ? "s" : ""} ${listReps(other.map((r) => r.rep))}: your delt took over, ${share} percent delt share.`);
  } else if (other.length) {
    parts.push(
      `Rep${other.length > 1 ? "s" : ""} ${listReps(other.map((r) => r.rep))} ${other.length > 1 ? `were ${big.length ? "smaller " : ""}cheats` : `was a ${big.length ? "smaller " : ""}cheat`}${other.some((r) => r.up_delt_x_clean != null) ? ` at ${multiples(other, "times")}` : ""}.`,
    );
  }
  return `${parts.join(" ")} ${decisionLine(set.decision?.next)}`;
}

/** Deterministic dashboard card. */
export function fallbackDetail(set: SetEndEvent, lastDay?: unknown): SetDetail {
  const f = setFacts(set);
  const bullets: string[] = [];
  const big = f.reps.filter((r) => r.label === "big_swing");
  const mild = f.reps.filter((r) => r.label === "mild_cheat" || r.label === "cheat");
  const near = f.reps.filter((r) => r.label === "near_miss");
  if (big.length)
    bullets.push(
      `Rep${big.length > 1 ? "s" : ""} ${listReps(big.map((r) => r.rep))}: ${side(big[0].arm)} front delt worked ${multiples(big, "x")} as hard as on your clean reps on the way up. Swing.`,
    );
  for (const r of mild)
    bullets.push(
      `Rep ${r.rep}: smaller cheat${r.up_delt_x_clean != null ? ` (${r.up_delt_x_clean}x clean)` : ""}; ${side(r.arm)} biceps peaked at ${r.biceps_peak_pct[r.arm]}%.`,
    );
  for (const r of near) bullets.push(`Rep ${r.rep}: near-miss at ${r.up_delt_x_clean}x clean, still counted clean.`);
  if (f.tempo.median_up_ms != null)
    bullets.push(
      f.tempo.fast_up_reps.length
        ? `Tempo: ${f.tempo.fast_up_reps.length} rep${f.tempo.fast_up_reps.length > 1 ? "s" : ""} came up in under ${f.tempo.fast_up_threshold_ms} ms (reps ${listReps(f.tempo.fast_up_reps)}).`
        : `Tempo: about ${(f.tempo.median_up_ms / 1000).toFixed(1)} s up per rep, nothing rushed.`,
    );
  if (f.balance)
    bullets.push(
      `L/R: right biceps did ${f.balance.right_biceps_share_pct}% of the curl work (target 45–55%), ${f.balance.verdict}; average effort R ${f.balance.r_biceps_mean_pct}% vs L ${f.balance.l_biceps_mean_pct}%.`,
    );
  const last = lastSessionFacts(lastDay);
  if (last?.sets.length && f.avg_delt_share_clean_reps != null)
    bullets.push(
      `Vs ${last.date}: ${last.sets.map((s) => `${s.label ?? `set ${s.set}`} ${pct(s.avg_delt_share)}%`).join(", ")} delt share; today clean reps ${pct(f.avg_delt_share_clean_reps)}%${f.avg_delt_share_cheat_reps != null ? `, cheats ${pct(f.avg_delt_share_cheat_reps)}%` : ""}.`,
    );
  const headline =
    f.cheats === 0
      ? `${f.total_reps} reps, all clean`
      : `${f.cheats} cheat${f.cheats > 1 ? "s" : ""} in ${f.total_reps} reps${f.first_cheat_rep ? `, first at rep ${f.first_cheat_rep}` : ""}`;
  const cue = big.length
    ? "Pin your elbows and keep your torso still; the moment your shoulder joins in, end the set."
    : f.tempo.fast_up_reps.length > f.total_reps / 2
      ? "Two full seconds up on every rep."
      : decisionLine(set.decision?.next);
  return { headline, bullets: bullets.slice(0, 6), cue, decision: set.decision, source: "code" };
}

export interface SetDetail {
  headline: string;
  bullets: string[];
  cue: string;
  /** The engine's decision, verbatim (the card should show it). */
  decision: SetEndEvent["decision"];
  /** "gemini" when Hydrogen wrote the words, "code" for the fallback. */
  source: "gemini" | "code";
}

const NUM_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

const wordToNum = (w: string): number | null => {
  const i = NUM_WORDS.indexOf(w.toLowerCase());
  if (i >= 0) return i;
  const n = Number(w);
  return Number.isInteger(n) ? n : null;
};
const NUM = `(\\d+|${NUM_WORDS.join("|")})`;

/**
 * True if the text names every rep in `reps`: one by one ("4, 5 and 8"), as a range ("6 through 10",
 * "6-10") or as "from rep 6 on" (up to `lastRep`).
 */
export function namesAllReps(text: string, reps: number[], lastRep: number): boolean {
  const t = text.toLowerCase();
  const named = new Set<number>();
  for (const m of t.matchAll(new RegExp(`\\b${NUM}\\s*(?:through|to|thru|-|–|—)\\s*${NUM}\\b(?!\\s*(?:x\\b|times))`, "g"))) {
    const a = wordToNum(m[1]), b = wordToNum(m[2]);
    if (a != null && b != null && b >= a && b - a < 30) for (let i = a; i <= b; i++) named.add(i);
  }
  for (const m of t.matchAll(new RegExp(`\\bfrom rep ${NUM}\\s*(?:on|onwards?|to the end)\\b`, "g"))) {
    const a = wordToNum(m[1]);
    if (a != null) for (let i = a; i <= lastRep; i++) named.add(i);
  }
  return reps.every((n) => named.has(n) || mentionsRep(t, n));
}

/** True if the text names rep `n` (digits or a number word). */
export function mentionsRep(text: string, n: number): boolean {
  const t = text.toLowerCase();
  if (new RegExp(`(^|[^\\d.])${n}(?![\\d.]*x)(?!\\d)`).test(t)) return true;
  const w = NUM_WORDS[n];
  return !!w && new RegExp(`\\b${w}\\b`).test(t);
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

/** Words that must never reach the speaker (claim scope: not medical). */
export function mentionsMedical(text: string): boolean {
  return /\b(injur\w*|pain|tendon\w*|tendinitis|strain(ed)?|sprain\w*|diagnos\w*|medical|doctor|physio\w*|rotator cuff|impingement|inflamm\w*)\b/i.test(text);
}
