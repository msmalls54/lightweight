import { DEFAULT_CONFIG } from "../engine/index.js";
import { thresholdsFor } from "../engine/config.js";
import type { Arm, RepEvent, SetEndEvent, Variant } from "./types.js";

/** Channel indices per arm (BUILD.md channel map). */
export const ARM_CH: Record<Arm, { bi: number; delt: number }> = { R: { bi: 0, delt: 1 }, L: { bi: 2, delt: 3 } };

/** How the coach labels reps. Code labels them; the LLM only explains the label. */
export const DETAIL_CONFIG = {
  /** Cheat rep whose up-phase delt ratio is at least this many times the clean reference = a full swing. */
  bigSwingX: 4,
  /** A rep whose up phase is under this x the set's median = "faster than your usual". */
  fasterThanUsualX: 0.75,
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
  // "Faster than your usual": up phase under 0.75 x this set's median (but not already rushed).
  const med = ups.length ? median(ups)! : null;
  const fasterThanUsual = med == null ? [] : reps.filter((r) => !r.fast_up && r.up_ms > 0 && r.up_ms < DETAIL_CONFIG.fasterThanUsualX * med).map((r) => r.rep);
  const cheatUp = avg(cheatReps.map((r) => r.up_ms).filter((x) => x > 0));
  const cleanUp = avg(cleanReps.map((r) => r.up_ms).filter((x) => x > 0));

  // L vs R: only reps where BOTH biceps actually curled (peak >= the engine's rep threshold).
  // A one-arm rep has r_share ~1.0 or ~0.0, which is not an imbalance.
  const curled = (r: RepEvent) => (r.peak_pct?.[0] ?? 0) >= DEFAULT_CONFIG.hi && (r.peak_pct?.[2] ?? 0) >= DEFAULT_CONFIG.hi;
  const both = set.reps.filter((r) => r.r_share != null && Number.isFinite(r.r_share) && curled(r));
  const rAvg = avg(both.map((r) => r.r_share!));
  const biR = avg(both.map((r) => r.mean_pct?.[0]).filter((x): x is number => Number.isFinite(x)));
  const biL = avg(both.map((r) => r.mean_pct?.[2]).filter((x): x is number => Number.isFinite(x)));
  const balance =
    rAvg == null
      ? null
      : {
          reps_with_both_arms: both.map((r) => r.rep),
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
          reps_outside_40_60: both
            .filter((r) => r.r_share! < DETAIL_CONFIG.repBalanceLow || r.r_share! > DETAIL_CONFIG.repBalanceHigh)
            .map((r) => r.rep),
        };

  // Clean reference: the engine learns it from the first clean reps; until then it makes no calls.
  const learning = n > 0 && set.reps.every((r) => r.baseline_up_delt_ratio == null);
  const cleanX = cleanReps.map(upRatioX).filter((x): x is number => x != null);

  return {
    set_id: set.set_id,
    total_reps: n,
    clean: set.clean,
    cheats: set.cheats,
    all_clean: n > 0 && set.cheats === 0,
    /** "learning" = no clean reference yet (first reps of the first set): no calls possible. */
    reference_status: learning ? "learning" : "set",
    reference_reps: set.reps.filter((r) => r.baseline_up_delt_ratio == null).map((r) => r.rep),
    cheat_reps: cheatNos,
    big_swing_reps: byLabel("big_swing"),
    mild_cheat_reps: byLabel("mild_cheat"),
    near_miss_reps: byLabel("near_miss"),
    first_cheat_rep: set.first_cheat_rep,
    cheat_pattern,
    worst_rep: worst ? { rep: worst.rep, arm: worst.arm, up_delt_x_clean: worst.up_delt_x_clean } : null,
    /** Highest multiple among the clean reps (1.0 = exactly your normal shoulder help). */
    clean_reps_max_x: cleanX.length ? r1(Math.max(...cleanX)) : null,
    shoulder_in_normal_range: cleanX.every((x) => x < DETAIL_CONFIG.nearMissX),
    mean_clean_up_delt_ratio: r2(avg(cleanReps.map((r) => r.up_delt_ratio).filter((x): x is number => x != null))),
    avg_delt_share: r2(avg(set.reps.map((r) => r.delt_share))),
    avg_delt_share_clean_reps: r2(avg(cleanReps.map((r) => r.delt_share))),
    avg_delt_share_cheat_reps: r2(avg(cheatReps.map((r) => r.delt_share))),
    avg_r_share: r2(rAvg),
    tempo: {
      median_up_ms: ups.length ? Math.round(median(ups)!) : null,
      fast_up_threshold_ms: fastUpMs(variant),
      fast_up_reps: fastReps,
      /** Not rushed by the absolute rule, but under 0.75 x the set's median up time. */
      faster_than_usual_reps: fasterThanUsual,
      cheat_reps_avg_up_ms: cheatUp == null ? null : Math.round(cheatUp),
      clean_reps_avg_up_ms: cleanUp == null ? null : Math.round(cleanUp),
      cheats_came_with_fast_tempo: cheatReps.length > 0 && cheatReps.filter((r) => r.up_ms > 0 && r.up_ms < fastUpMs(variant)).length > cheatReps.length / 2,
    },
    balance,
    decision: set.decision,
    reps,
  };
}

/** Raw numbers the coach must never quote: whole-rep delt share and raw delt %MVC/ratios. */
const RAW_KEYS = new Set([
  "delt_share", "delt_peak_pct", "delt_peak_pct_mvc", "up_delt_ratio", "clean_reference_up_delt_ratio",
  "mean_clean_up_delt_ratio", "avg_delt_share", "avg_delt_share_clean_reps", "avg_delt_share_cheat_reps",
  "baseline_delt_share", "baseline_up_delt_ratio", "down_ms",
]);

const CHEAT_REASON_WORDS: Record<string, string> = { delt_share_jump: "shoulder_took_over", delt_peak: "shoulder_spike" };

/** What the LLM sees: setFacts minus raw delt numbers (talk relative to the lifter's clean reps). */
export function forLlm<T>(v: T): T {
  if (Array.isArray(v)) return v.map(forLlm) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (RAW_KEYS.has(k)) continue;
      // The engine's reason names ("delt_share_jump") would prime the model to quote a delt share.
      out[k] = k === "cheat_reason" && typeof x === "string" ? (CHEAT_REASON_WORDS[x] ?? "shoulder_took_over") : forLlm(x);
    }
    return out as T;
  }
  return v;
}

/** exercise + variant + load for a set (from the server's SetContext). */
export interface LiftKey {
  exercise?: string;
  variant?: string;
  load_lb?: number;
}

/** Same exercise, variant and load. Unknown exercise on either side = not comparable. */
export function sameLift(a: LiftKey | undefined, b: LiftKey | undefined): boolean {
  if (!a?.exercise || !b?.exercise) return false;
  const norm = (s?: string) => (s ?? "").trim().toLowerCase();
  return norm(a.exercise) === norm(b.exercise) && norm(a.variant) === norm(b.variant) && (a.load_lb ?? null) === (b.load_lb ?? null);
}

function xRange(reps: unknown): number[] | null {
  if (!Array.isArray(reps)) return null;
  const v = reps
    .filter((r) => r && (r as { cheat?: boolean }).cheat)
    .map((r) => (r as { up_delt_x_clean?: number }).up_delt_x_clean)
    .filter((x): x is number => typeof x === "number");
  return v.length ? [Math.round(Math.min(...v)), Math.round(Math.max(...v))] : null;
}

/**
 * The last history day, ONLY the sets with the same exercise + variant + load as `lift`.
 * null when nothing is like-for-like (then the coach must not compare).
 */
export function lastSessionFacts(lastDay: unknown, lift?: LiftKey) {
  if (!lastDay || typeof lastDay !== "object" || !lift) return null;
  const d = lastDay as { date?: string; sets?: Array<Record<string, unknown>> };
  if (!Array.isArray(d.sets)) return null;
  const sets = d.sets
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => sameLift(s as LiftKey, lift))
    .map(({ s, i }) => ({
      set: i + 1,
      reps: Array.isArray(s.reps) ? s.reps.length : null,
      cheats: (s.cheats as number) ?? null,
      first_cheat_rep: (s.first_cheat_rep as number) ?? null,
      cheat_reps_x_range: xRange(s.reps),
    }));
  return sets.length ? { date: d.date, exercise: lift.exercise, variant: lift.variant, load_lb: lift.load_lb, sets } : null;
}

/**
 * The last history day for Q&A, described relative to its own clean reps (never raw delt share).
 * Labelled with its lift so the coach doesn't compare it to a different one.
 */
export function historyBrief(lastDay: unknown) {
  if (!lastDay || typeof lastDay !== "object") return null;
  const d = lastDay as { date?: string; kind?: string; sets?: Array<Record<string, unknown>> };
  if (!Array.isArray(d.sets)) return null;
  // Bench files (Nov 13) have a strict set: express the other sets as multiples of it.
  const strict = d.sets.find((s) => /strict/i.test(String(s.style_instructed ?? "")));
  const ref = typeof strict?.avg_delt_share === "number" && strict.avg_delt_share > 0 ? strict.avg_delt_share : null;
  return {
    date: d.date,
    kind: d.kind,
    sets: d.sets.map((s, i) => ({
      set: i + 1,
      exercise: s.exercise ?? null,
      variant: s.variant ?? null,
      load_lb: s.load_lb ?? null,
      style: s.style_instructed ?? null,
      reps: Array.isArray(s.reps) ? s.reps.length : null,
      cheats: s.cheats ?? null,
      first_cheat_rep: s.first_cheat_rep ?? null,
      cheat_reps_x_range: xRange(s.reps),
      shoulder_vs_strict_set_x:
        ref && typeof s.avg_delt_share === "number" && s !== strict ? r1(s.avg_delt_share / ref) : null,
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

/** Shorter decision lines for the spoken summary (25-word cap). */
const DECISION_SHORT: Record<string, string> = {
  continue: "Same weight, keep going.",
  stop_at_first_cheat_rest_longer: "Next set, stop at the first cheat.",
  slow_the_tempo: "Slow it down next set.",
};

export function decisionShort(next: string): string {
  return DECISION_SHORT[next] ?? "Same weight, keep going.";
}

/** "1 rep", "3 reps" (also "1 set", "2 cheats"). */
export function plural(n: number | null | undefined, word: string): string {
  return `${n ?? 0} ${word}${n === 1 ? "" : "s"}`;
}

/** "4", "4 and 8", "4, 5 and 8" */
export function listReps(ns: number[]): string {
  if (ns.length <= 1) return ns.join("");
  return `${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`;
}

/** Multiples for a group of reps: "9 times", "9 and 7 times", "8 to 12 times" (unit "x" for the card). */
function multiples(rs: ReturnType<typeof repFacts>[], unit: "times" | "x"): string {
  const v = rs
    .map((r) => r.up_delt_x_clean)
    .filter((x): x is number => x != null)
    .map((x) => (x < 2 ? Math.round(x * 10) / 10 : Math.round(x))); // never "1 times"
  if (!v.length) return "";
  const u = unit === "x" ? "x" : " times";
  if (v.length === 1) return `${v[0]}${u}`;
  if (v.length === 2) return v[0] === v[1] ? `${v[0]}${u}` : `${v[0]} and ${v[1]}${u}`;
  const lo = Math.min(...v), hi = Math.max(...v);
  return lo === hi ? `${lo}${u}` : `${lo} to ${hi}${u}`;
}

/** Technique cue for a clean set (no numbers). */
export function cleanSetCue(f: ReturnType<typeof setFacts>): string {
  return f.tempo.fast_up_reps.length > f.total_reps / 2
    ? "Control the tempo: two seconds up, no bounce at the bottom."
    : "Same groove: elbows pinned, squeeze at the top.";
}

/** Spoken summary cap: ~25 words is about 8 s of speech. */
export const SPOKEN_MAX_WORDS = 25;

/** Deterministic spoken summary (<= 25 words): used when Gemini is down or its line breaks a rule. Never quotes delt share. */
export function fallbackSummary(set: SetEndEvent): string {
  const f = setFacts(set);
  const decision = decisionShort(set.decision?.next);
  if (f.total_reps === 0) return `No reps counted. ${decision}`;
  if (f.reference_status === "learning" && f.cheats === 0)
    return `Still learning your clean rep, so no calls yet. ${f.total_reps} rep${f.total_reps > 1 ? "s" : ""} in, keep them strict.`;
  if (f.cheats === 0)
    return `${f.total_reps === 1 ? "1 rep, clean" : `All ${f.total_reps} reps clean`}, shoulder in its normal range. ${cleanSetCue(f)} ${decision}`;
  const cheatsF = f.reps.filter((r) => r.verdict === "cheat");
  if (f.cheat_pattern.startsWith("fatigue") && cheatsF.length >= 3) {
    const m = multiples(cheatsF, "times");
    return `From rep ${f.first_cheat_rep} on, your ${side(cheatsF[0].arm)} shoulder took over${m ? `, ${m} normal` : ""}. ${decision}`;
  }
  const parts: string[] = [];
  const big = f.reps.filter((r) => r.label === "big_swing");
  const other = cheatsF.filter((r) => r.label !== "big_swing");
  if (big.length)
    parts.push(`Rep${big.length > 1 ? "s" : ""} ${listReps(big.map((r) => r.rep))}: ${side(big[0].arm)} shoulder at ${multiples(big, "times")} normal, that's a swing.`);
  if (other.length && (big.length || other.every((r) => r.up_delt_x_clean == null)))
    parts.push(`Rep${other.length > 1 ? "s" : ""} ${listReps(other.map((r) => r.rep))} ${big.length ? "smaller" : other.length > 1 ? "were cheats: your shoulder took over" : "was a cheat: your shoulder took over"}.`);
  else if (other.length)
    parts.push(`Rep${other.length > 1 ? "s" : ""} ${listReps(other.map((r) => r.rep))}: ${side(other[0].arm)} shoulder at ${multiples(other, "times")} normal.`);
  return `${parts.join(" ")} ${decision}`;
}

export interface FallbackDetailOptions {
  /** This set's lift; history is only compared when it matches. */
  lift?: LiftKey;
}

/** Deterministic dashboard card. Never quotes delt share; history only like-for-like. */
export function fallbackDetail(set: SetEndEvent, lastDay?: unknown, opts: FallbackDetailOptions = {}): SetDetail {
  const f = setFacts(set);
  const bullets: string[] = [];
  const big = f.reps.filter((r) => r.label === "big_swing");
  const mild = f.reps.filter((r) => r.label === "mild_cheat" || r.label === "cheat");
  const near = f.reps.filter((r) => r.label === "near_miss");
  if (f.reference_status === "learning")
    bullets.push(`Learning your clean rep: no calls until it has a clean reference.`);
  else if (f.reference_reps.length)
    bullets.push(`Rep${f.reference_reps.length > 1 ? "s" : ""} ${listReps(f.reference_reps)} set your clean reference; the other reps are judged against ${f.reference_reps.length > 1 ? "them" : "it"}.`);
  if (f.all_clean && f.reference_status === "set")
    bullets.push(`${f.total_reps === 1 ? "The rep was clean" : `All ${f.total_reps} reps clean`}: your shoulder stayed in its normal range on the way up.`);
  if (big.length)
    bullets.push(
      `Rep${big.length > 1 ? "s" : ""} ${listReps(big.map((r) => r.rep))}: ${side(big[0].arm)} shoulder did ${multiples(big, "x")} its normal share on the way up. Swing.`,
    );
  for (const r of mild)
    bullets.push(
      `Rep ${r.rep}: smaller cheat${r.up_delt_x_clean != null ? ` (${r.up_delt_x_clean}x its normal share)` : ""}; ${side(r.arm)} biceps peaked at ${r.biceps_peak_pct[r.arm]}% of max.`,
    );
  for (const r of near) bullets.push(`Rep ${r.rep}: near-miss at ${r.up_delt_x_clean}x normal, still counted clean.`);
  if (f.tempo.median_up_ms != null)
    bullets.push(
      f.tempo.fast_up_reps.length
        ? `Tempo: ${f.tempo.fast_up_reps.length} rep${f.tempo.fast_up_reps.length > 1 ? "s" : ""} came up in under ${f.tempo.fast_up_threshold_ms} ms (rep${f.tempo.fast_up_reps.length > 1 ? "s" : ""} ${listReps(f.tempo.fast_up_reps)}).`
        : f.tempo.faster_than_usual_reps.length
          ? `Tempo: nothing rushed, but rep${f.tempo.faster_than_usual_reps.length > 1 ? "s" : ""} ${listReps(f.tempo.faster_than_usual_reps)} came up faster than your usual.`
          : `Tempo: about ${(f.tempo.median_up_ms / 1000).toFixed(1)} s up per rep, nothing rushed.`,
    );
  if (f.balance)
    bullets.push(`L/R: right biceps did ${f.balance.right_biceps_share_pct}% of the curl work (target 45–55%), ${f.balance.verdict}.`);
  const last = lastSessionFacts(lastDay, opts.lift);
  if (last) {
    const s = last.sets.at(-1)!;
    bullets.push(`Vs ${last.date}, same lift: ${plural(s.cheats, "cheat")} in ${plural(s.reps, "rep")}; today ${f.cheats} in ${f.total_reps}.`);
  }
  const headline =
    f.total_reps === 0
      ? "No reps counted"
      : f.cheats === 0
        ? f.reference_status === "learning"
          ? `${f.total_reps} rep${f.total_reps > 1 ? "s" : ""} in, learning your clean rep`
          : f.total_reps === 1
            ? "1 rep, clean"
            : `All ${f.total_reps} reps clean`
        : `${plural(f.cheats, "cheat")} in ${plural(f.total_reps, "rep")}${f.first_cheat_rep ? `, first at rep ${f.first_cheat_rep}` : ""}`;
  const cue = big.length
    ? "Pin your elbows and keep your torso still; the moment your shoulder joins in, end the set."
    : f.cheats === 0
      ? cleanSetCue(f)
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

/** Mike's call (Nov 14): plain words, never "snitch". */
export function relabelSnitch(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/\bsnitch(es)?\b/gi, (_m, pl) => (pl ? "front delts" : "front delt"));
  if (Array.isArray(v)) return v.map(relabelSnitch);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relabelSnitch(x)]));
  return v;
}

/** Post-filter for model output: "snitch" -> "shoulder" ("the snitch front delt" -> "the front delt"). */
export function scrubSnitch(text: string): string {
  return text
    .replace(/\bsnitch(?:ing|ed|es)?\s+(?=(front\s+)?delts?\b)/gi, "")
    .replace(/\bsnitched\b/gi, "fired")
    .replace(/\bsnitching\b/gi, "firing")
    .replace(/\bsnitches\b/gi, "shoulders")
    .replace(/\bSnitch\b/g, "Shoulder")
    .replace(/\bsnitch\b/gi, "shoulder")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** True if the text quotes a raw delt/shoulder percentage or "delt share" (the coach talks in multiples of normal). */
export function mentionsRawShare(text: string): boolean {
  return /\bdelt share\b|\bshoulder share\b/i.test(text) || /\b(delts?|shoulders?)\b(?:(?!biceps)[^.]){0,30}?\b\d{1,3}\s*(percent|%)/i.test(text);
}

/** True if the text refers to a previous session (only allowed when like-for-like history exists). */
export function mentionsHistory(text: string): boolean {
  return /\b(yesterday|last (time|session|night|week)|previous session|nov(ember)?\.? 13|bench test)\b/i.test(text);
}
