// Workout-level coach: "so far today" across all sets, while Mike is mid-workout.
// Code computes every number and picks the one thing to fix; Gemini only phrases it.
import type { CoachContext } from "./context.js";
import { listReps, plural, sameLift, setFacts, type LiftKey } from "./facts.js";
import type { Arm, SetEndEvent } from "./types.js";

/** A set counts toward trends only with at least this many reps (shorter ones are test/warm-up blips). */
export const WORKING_SET_MIN_REPS = 3;
/** Fatigue ("took over late") is judged only on sets at least this long. */
export const LONG_SET_MIN_REPS = 6;
/** Spoken workout update ("how's my workout going?"): at most this many words. */
export const WORKOUT_SPOKEN_MAX_WORDS = 20;

export interface LoggedLift {
  exercise: string;
  variant?: string | null;
  load_lb?: number | null;
  sets?: number | null;
  reps?: number | null;
  note?: string | null;
}

/** What summarizeSession reads. Defaults: sets from ctx.today.sets + ctx.today.setMeta, no logged lifts. */
export interface WorkoutInput {
  /** Sensed sets today, oldest first, each with its lift (exercise/variant/load). */
  sets?: { set: SetEndEvent; lift?: LiftKey }[];
  /** Lifts logged by hand, not sensed (sets x reps x load only). */
  logged?: LoggedLift[];
}

/** The "Workout so far" card. */
export interface SessionSummary {
  headline: string;
  /** 3–5 bullets: trend, fatigue, which arm, best set, logged lifts. */
  bullets: string[];
  /** The one thing to focus on for the rest of the session. */
  focus_next: string;
  /** <= 20 words, for the speaker ("how's my workout going?"). */
  spoken: string;
  totals: { sets: number; working_sets: number; reps: number; clean: number; cheats: number };
  /** "gemini" when Hydrogen wrote the words, "code" for the fallback. */
  source: "gemini" | "code";
}

const side = (a: Arm) => (a === "R" ? "right" : "left");
const liftLabel = (l?: LiftKey) =>
  l?.exercise ? `${l.exercise}${l.load_lb ? ` ${l.load_lb} lb` : ""}` : "curls";

export function workoutInputFromContext(ctx: CoachContext, extra: WorkoutInput = {}): Required<WorkoutInput> {
  const sets = extra.sets ?? ctx.today.sets.map((set) => ({ set, lift: ctx.today.setMeta?.[set.set_id] }));
  return { sets, logged: extra.logged ?? [] };
}

export interface ExerciseFacts {
  exercise: string | null;
  variant: string | null;
  load_lb: number | null;
  label: string;
  sets: number;
  working_sets: number;
  short_sets: number;
  reps: number;
  clean: number;
  cheats: number;
  cheats_per_working_set: { set: number; reps: number; cheats: number; cheat_reps: number[] }[];
  trend: "cleaner" | "sloppier" | "steady" | "one working set so far";
  last_working_set_clean: boolean | null;
  /** First cheat rep in each set of LONG_SET_MIN_REPS+ reps. */
  first_cheat_rep_long_sets: { set: number; rep: number }[];
  fatigue_sets: number[];
  cheat_arm: Arm | "both" | null;
  cheat_arm_counts: { R: number; L: number };
  worst_multiple: number | null;
  best_set: { set: number; reps: number; cheats: number } | null;
  fast_up_reps: number;
  fast_up_share: number;
  latest_balance: { right_biceps_share_pct: number | null; verdict: string } | null;
  latest_decision: SetEndEvent["decision"] | null;
}

export interface WorkoutFacts {
  totals: SessionSummary["totals"];
  exercises: ExerciseFacts[];
  logged: { exercise: string; variant: string | null; load_lb: number | null; sets: number | null; reps: number | null; sensed: false }[];
  focus: { key: string; text: string };
}

/** Everything the workout card may say, computed by code. */
export function workoutFacts(input: Required<WorkoutInput>): WorkoutFacts {
  type G = { lift?: LiftKey; label: string; sets: { set: SetEndEvent; f: ReturnType<typeof setFacts> }[] };
  const groups: G[] = [];
  for (const { set, lift } of input.sets) {
    let g = groups.find((x) => (x.lift && lift ? sameLift(x.lift, lift) : !x.lift && !lift));
    if (!g) groups.push((g = { lift, label: liftLabel(lift), sets: [] }));
    g.sets.push({ set, f: setFacts(set, lift?.variant as never) });
  }

  const exercises = groups.map((g): ExerciseFacts => {
    const all = g.sets.map((s, i) => ({ n: i + 1, ...s }));
    const working = all.filter((s) => s.f.total_reps >= WORKING_SET_MIN_REPS);
    const reps = all.reduce((a, s) => a + s.f.total_reps, 0);
    const cheats = all.reduce((a, s) => a + s.f.cheats, 0);
    const rate = (s: (typeof working)[number]) => s.f.cheats / Math.max(1, s.f.total_reps);
    const first = working[0], last = working.at(-1);
    const trend =
      working.length < 2
        ? "one working set so far"
        : rate(last!) - rate(first!) <= -0.15
          ? "cleaner"
          : rate(last!) - rate(first!) >= 0.15
            ? "sloppier"
            : "steady";
    // Which arm's shoulder cheats (bilateral reps carry the cheating arm).
    const armCount = { R: 0, L: 0 };
    for (const s of all) for (const r of s.set.reps) if (r.cheat) armCount[r.arm]++;
    const totalArm = armCount.R + armCount.L;
    const cheat_arm =
      totalArm === 0 ? null : armCount.R / totalArm >= 0.75 ? "R" : armCount.L / totalArm >= 0.75 ? "L" : "both";
    // Fatigue: where the shoulder first took over in the longer working sets.
    const firstCheats = working
      .filter((s) => s.f.total_reps >= LONG_SET_MIN_REPS && s.f.first_cheat_rep != null)
      .map((s) => ({ set: s.n, rep: s.f.first_cheat_rep! }));
    const fatigueSets = working.filter((s) => s.f.cheat_pattern.startsWith("fatigue")).map((s) => s.n);
    // Best set: the longest all-clean set if it's a real set (5+ reps), else the most clean reps.
    const cleanLong = working.filter((s) => s.f.cheats === 0 && s.f.total_reps >= 5).sort((a, b) => b.f.total_reps - a.f.total_reps);
    const best = cleanLong[0] ?? [...working].sort((a, b) => b.f.total_reps - b.f.cheats - (a.f.total_reps - a.f.cheats) || rate(a) - rate(b))[0];
    const fastReps = working.reduce((a, s) => a + s.f.tempo.fast_up_reps.length, 0);
    const workingReps = working.reduce((a, s) => a + s.f.total_reps, 0);
    const lastBalance = [...working].reverse().find((s) => s.f.balance)?.f.balance ?? null;
    return {
      exercise: g.lift?.exercise ?? null,
      variant: g.lift?.variant ?? null,
      load_lb: g.lift?.load_lb ?? null,
      label: g.label,
      sets: all.length,
      working_sets: working.length,
      short_sets: all.length - working.length,
      reps,
      clean: reps - cheats,
      cheats,
      cheats_per_working_set: working.map((s) => ({ set: s.n, reps: s.f.total_reps, cheats: s.f.cheats, cheat_reps: s.f.cheat_reps })),
      trend,
      last_working_set_clean: last ? last.f.cheats === 0 : null,
      first_cheat_rep_long_sets: firstCheats,
      fatigue_sets: fatigueSets,
      cheat_arm,
      cheat_arm_counts: armCount,
      worst_multiple: Math.max(0, ...working.map((s) => s.f.worst_rep?.up_delt_x_clean ?? 0)) || null,
      best_set: best ? { set: best.n, reps: best.f.total_reps, cheats: best.f.cheats } : null,
      fast_up_reps: fastReps,
      fast_up_share: workingReps ? Math.round((fastReps / workingReps) * 100) / 100 : 0,
      latest_balance: lastBalance ? { right_biceps_share_pct: lastBalance.right_biceps_share_pct, verdict: lastBalance.verdict } : null,
      latest_decision: working.at(-1)?.set.decision ?? all.at(-1)?.set.decision ?? null,
    };
  });

  const totals = {
    sets: exercises.reduce((a, e) => a + e.sets, 0),
    working_sets: exercises.reduce((a, e) => a + e.working_sets, 0),
    reps: exercises.reduce((a, e) => a + e.reps, 0),
    clean: exercises.reduce((a, e) => a + e.clean, 0),
    cheats: exercises.reduce((a, e) => a + e.cheats, 0),
  };
  const logged = input.logged.map((l) => ({
    exercise: l.exercise,
    variant: l.variant ?? null,
    load_lb: l.load_lb ?? null,
    sets: l.sets ?? null,
    reps: l.reps ?? null,
    sensed: false as const,
  }));
  return { totals, exercises, logged, focus: pickFocus(exercises) };
}

/** The one thing to fix for the rest of the session. Code decides; the LLM may only phrase it. */
export function pickFocus(exercises: ExerciseFacts[]): WorkoutFacts["focus"] {
  const e = [...exercises].sort((a, b) => b.reps - a.reps)[0];
  if (!e || e.reps === 0) return { key: "start", text: "Get a working set in: clean reps, elbows pinned." };
  const arm = e.cheat_arm === "R" || e.cheat_arm === "L" ? side(e.cheat_arm) : null;
  const late = e.first_cheat_rep_long_sets.length > 0 && e.first_cheat_rep_long_sets.every((x) => x.rep >= 4);
  if (e.cheats > 0 && late)
    return {
      key: "stop_at_first_cheat",
      text: `End each set at the first cheat: your ${arm ? `${arm} ` : ""}shoulder takes over late in the set.`,
    };
  if (e.cheats > 0 && arm) return { key: `pin_${e.cheat_arm}`, text: `Pin your ${arm} elbow and keep that shoulder down on every rep.` };
  if (e.cheats > 0) return { key: "stop_at_first_cheat", text: "End each set at the first cheat; no swinging to finish reps." };
  if (e.fast_up_share > 0.4) return { key: "slow_up", text: "Slow the way up: two full seconds, no bounce at the bottom." };
  const b = e.latest_balance?.verdict ?? "";
  if (/left doing more/.test(b)) return { key: "balance_R", text: "Make the right biceps match the left: squeeze it at the top." };
  if (/right doing more/.test(b)) return { key: "balance_L", text: "Make the left biceps match the right: squeeze it at the top." };
  return { key: "keep_groove", text: "Keep the groove: same tempo, elbows pinned, every rep clean." };
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Code-written "Workout so far" card (also the fallback when Gemini is down or breaks a rule). */
export function fallbackSession(input: Required<WorkoutInput>): SessionSummary {
  const w = workoutFacts(input);
  const t = w.totals;
  const bullets: string[] = [];
  for (const e of w.exercises.slice(0, 2)) {
    const seq = e.cheats_per_working_set.map((s) => s.cheats).join(", ");
    bullets.push(
      `${cap(e.label)}: ${plural(e.sets, "set")}, ${e.clean} of ${plural(e.reps, "rep")} clean${e.working_sets > 1 ? `; cheats per working set ${seq}` : ""}.`,
    );
    if (e.working_sets > 1)
      bullets.push(
        e.trend === "cleaner"
          ? `Trend: cleaner as you go${e.last_working_set_clean ? ", and your last set was clean" : ""}.`
          : e.trend === "sloppier"
            ? "Trend: sloppier as you go: fatigue is setting in."
            : `Trend: steady${e.last_working_set_clean ? ", last set clean" : ""}.`,
      );
    if (e.cheat_arm === "R" || e.cheat_arm === "L") {
      const n = e.cheat_arm_counts[e.cheat_arm];
      bullets.push(`${n} of ${e.cheats} cheat${e.cheats === 1 ? "" : "s"} came from your ${side(e.cheat_arm)} shoulder.`);
    }
    const longs = e.first_cheat_rep_long_sets.filter((x) => x.rep >= 4);
    if (longs.length) bullets.push(`Fatigue: in your longer sets the shoulder took over from rep ${listReps(longs.map((x) => x.rep))}.`);
    if (e.best_set && e.working_sets > 1)
      bullets.push(`Best set: set ${e.best_set.set}, ${plural(e.best_set.reps, "rep")}${e.best_set.cheats ? `, ${plural(e.best_set.cheats, "cheat")}` : ", all clean"}.`);
  }
  const loggedBullets: string[] = [];
  for (const l of w.logged.slice(0, 2))
    loggedBullets.push(`Also logged: ${l.exercise}${l.sets && l.reps ? ` ${l.sets}x${l.reps}` : ""}${l.load_lb ? ` at ${l.load_lb} lb` : ""} (no sensors).`);
  if (bullets.length < 3 && t.working_sets === 0) bullets.push("No working set yet (3+ reps): trends start after your first full set.");
  const headline =
    t.reps === 0
      ? "No sensed sets yet today"
      : `${plural(t.working_sets || t.sets, t.working_sets ? "working set" : "set")} so far: ${t.clean} of ${plural(t.reps, "rep")} clean`;
  const spoken = clampWords(
    t.reps === 0 ? `No sets yet. ${w.focus.text}` : `${t.clean} of ${plural(t.reps, "rep")} clean so far. ${shortFocus(w.focus.key)}`,
    WORKOUT_SPOKEN_MAX_WORDS,
  );
  const all = [...bullets.slice(0, 5 - loggedBullets.length), ...loggedBullets];
  return { headline, bullets: all, focus_next: w.focus.text, spoken, totals: t, source: "code" };
}

/** Short spoken version of each focus (keeps the spoken line within 20 words). */
function shortFocus(key: string): string {
  return (
    {
      stop_at_first_cheat: "Rest of the session: end each set at the first cheat.",
      pin_R: "Rest of the session: pin that right elbow.",
      pin_L: "Rest of the session: pin that left elbow.",
      slow_up: "Rest of the session: slow the way up.",
      balance_R: "Rest of the session: make the right biceps work.",
      balance_L: "Rest of the session: make the left biceps work.",
      keep_groove: "Keep that groove.",
      start: "Get a working set in.",
    } as Record<string, string>
  )[key] ?? "Keep it clean.";
}

function clampWords(s: string, max: number): string {
  const w = s.split(/\s+/).filter(Boolean);
  return w.length <= max ? s : w.slice(0, max).join(" ").replace(/[,:;]$/, "") + ".";
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export { words as _words };
