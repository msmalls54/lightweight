// Today's workout for the dashboard timeline: exercise blocks -> sets -> per-rep verdicts + stored report cards.
import type { Store } from "./store.js";
import type { RepEvent, SetContext, SetEndEvent } from "./modules.js";
import { cleanCoachLine, eventVerdict } from "./mcp/data.js";

const r2 = (x: number) => Math.round(x * 100) / 100;

export interface WorkoutArm { arm: "R" | "L"; verdict: "clean" | "loose" | "cheat"; multiple: number | null }
/** arms: every working arm of the rep (a bilateral curl is ONE rep event with two arms), from the engine. */
export interface WorkoutRep { rep: number; arm: "R" | "L"; cheat: boolean; verdict: "clean" | "loose" | "cheat"; multiple: number | null; reason: string | null; arms?: WorkoutArm[] }
export interface WorkoutSet {
  kind: "sensed"; set_id: string; session_id: string; started_at: string; ended_at: string | null; live: boolean;
  set_no: number; reps: number; clean: number; cheats: number; first_cheat_rep: number | null;
  decision: SetEndEvent["decision"] | null; coach_line: string | null; detail: unknown | null; rep_list: WorkoutRep[];
}
export interface LoggedSet { kind: "logged"; id: number; logged_at: string; sets: number | null; reps: number | null; note: string | null }
export interface ExerciseBlock { key: string; exercise: string; variant: string; load_lb: number | null; last_at: string; items: (WorkoutSet | LoggedSet)[] }

/** up-phase shoulder help vs the clean reference, and the dashboard's verdict (the code's flag wins). */
export function repVerdict(r: RepEvent): { multiple: number | null; verdict: WorkoutRep["verdict"] } {
  const up = r.up_delt_ratio, base = r.baseline_up_delt_ratio;
  const multiple = up != null && base != null && base > 0 ? r2(up / base) : null;
  return { multiple, verdict: eventVerdict(r) };
}

export function repArms(r: RepEvent): WorkoutArm[] | undefined {
  if (!r.arm_detail) return undefined;
  const out: WorkoutArm[] = [];
  for (const arm of ["R", "L"] as const) {
    const d = r.arm_detail[arm];
    if (d) out.push({ arm, verdict: d.verdict, multiple: d.ref_up_delt_ratio && d.ref_up_delt_ratio > 0 ? r2(d.up_delt_ratio / d.ref_up_delt_ratio) : null });
  }
  return out.length ? out : undefined;
}

export function workoutToday(store: Store, person: string, activeSessionId?: string, liveSetId?: string) {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const since = midnight.toISOString();
  // Today's live, non-walk-up sessions for this person, plus whatever session is on screen (a replay or fake run).
  const rows = store.db.prepare(`SELECT t.* FROM sets t JOIN sessions s ON s.session_id=t.session_id
      WHERE t.started_at>=? AND ((s.person=? AND s.kind='live' AND s.is_walkup=0) OR s.session_id=?)
      ORDER BY t.started_at`).all(since, person, activeSessionId ?? "") as
    { set_id: string; session_id: string; ctx: string; started_at: string; ended_at: string | null; summary: string | null; coach_line: string | null; detail?: string | null }[];
  const blocks = new Map<string, ExerciseBlock>();
  const blockFor = (exercise: string, variant: string, load: number | null, at: string) => {
    const key = `${exercise.toLowerCase()}|${variant}|${load ?? ""}`;
    let b = blocks.get(key);
    if (!b) { b = { key, exercise, variant, load_lb: load, last_at: at, items: [] }; blocks.set(key, b); }
    if (at > b.last_at) b.last_at = at;
    return b;
  };
  for (const row of rows) {
    const ctx = JSON.parse(row.ctx) as SetContext;
    const end = row.summary ? (JSON.parse(row.summary) as SetEndEvent) : null;
    const reps = store.repsFor(row.set_id);
    const byRep = new Map<number, boolean>();
    for (const r of reps) byRep.set(r.rep, (byRep.get(r.rep) ?? false) || r.cheat);
    const cheatReps = [...byRep].filter(([, c]) => c).map(([n]) => n);
    const b = blockFor(ctx.exercise, ctx.variant, ctx.load_lb ?? null, row.started_at);
    b.items.push({
      kind: "sensed", set_id: row.set_id, session_id: row.session_id, started_at: row.started_at, ended_at: row.ended_at,
      live: !end && row.set_id === liveSetId, set_no: 0, reps: byRep.size, clean: byRep.size - cheatReps.length, cheats: cheatReps.length,
      first_cheat_rep: cheatReps.length ? Math.min(...cheatReps) : null, decision: end?.decision ?? null, coach_line: cleanCoachLine(row.coach_line),
      detail: row.detail ? JSON.parse(row.detail) : null,
      rep_list: reps.map(r => ({ rep: r.rep, arm: r.arm, cheat: r.cheat, reason: r.cheat_reason, ...repVerdict(r), arms: repArms(r) })),
    });
  }
  for (const l of store.loggedToday(person, since)) {
    blockFor(l.exercise, l.variant, l.load_lb, l.logged_at).items.push({ kind: "logged", id: l.id, logged_at: l.logged_at, sets: l.sets, reps: l.reps, note: l.note });
  }
  const out = [...blocks.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
  for (const b of out) {
    b.items.sort((x, y) => ((x.kind === "sensed" ? x.started_at : x.logged_at) < (y.kind === "sensed" ? y.started_at : y.logged_at) ? -1 : 1));
    let n = 0;
    for (const it of b.items) if (it.kind === "sensed") it.set_no = ++n;
    b.items.reverse(); // newest first
  }
  const sensed = out.flatMap(b => b.items).filter((i): i is WorkoutSet => i.kind === "sensed");
  return {
    person, date: since.slice(0, 10),
    totals: { sets: sensed.filter(s => !s.live && s.reps > 0).length, reps: sensed.reduce((a, s) => a + s.reps, 0), cheats: sensed.reduce((a, s) => a + s.cheats, 0) },
    blocks: out,
  };
}
