// MCP tools (CLAUDE.md "MCP tools"). Numbers come from code; the model only explains them.
import { z } from "zod";
import { object, widget, type MCPServer } from "mcp-use/server";
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { Store } from "../store.js";
import { HttpError, type Pipeline } from "../pipeline.js";
import { buildCoachContext } from "../modules.js";
import { REPO_ROOT } from "../paths.js";
import { getReps, muscleMapView, compareArms, compareCurls, challengeStatus, type MuscleMapView } from "./data.js";

export const SCOPE = "Readings are relative muscle activation (%MVC from this session's calibration, and shares between muscles). Not force, not muscle growth, not medical. The code decides which reps are cheats; explain its flags, never re-judge them.";
const STYLE = "Answer like a blunt gym coach in one or two short sentences.";
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const COACH_DIR = resolve(REPO_ROOT, "data", "coach");

const sessionArg = z.string().max(80).optional().describe("session_id from get_reps; default = the latest session with sets");
const setArg = z.number().int().positive().max(999).optional().describe("Set number within the session; default = the latest set");

const fail = (e: unknown) => object({ ok: false, error: e instanceof Error ? e.message : String(e) });
const pctS = (x: number) => `${Math.round(x * 100)}%`;

function mapMessage(v: MuscleMapView) {
  const s = v.set;
  const cheats = v.reps.filter(r => r.cheat);
  const cheatTxt = cheats.length ? `cheat reps: ${[...new Set(cheats.map(r => `${r.rep}${v.arms.length > 1 ? r.arm : ""}`))].join(", ")} (delt took over)` : "no cheat reps";
  const bal = s.r_share !== null ? `; R/L biceps share ${pctS(s.r_share)}/${pctS(1 - s.r_share)}` : "";
  return `${v.person}${v.walkup ? " (walk-up)" : ""}, set ${s.set_no}: ${s.exercise} ${s.variant}${s.load_lb != null ? ` ${s.load_lb} lb` : ""}, ${s.reps} reps, ${s.clean} clean, ${cheatTxt}; avg delt share ${s.avg_delt_share === null ? "n/a" : pctS(s.avg_delt_share)}${bal}.${s.coach_line ? ` Coach: ${s.coach_line}` : ""}`;
}

export function registerTools(server: MCPServer, store: Store, pipeline: Pipeline) {
  server.tool({
    name: "start_session",
    description: `Start a new lifting session for a person (default Mike). Walk-ups use one arm (R) by default. With calibrate=true the open dashboard runs the 15-20 s calibration (relax, then flex each muscle). ${SCOPE}`,
    schema: z.object({
      person: z.string().trim().min(1).max(60).default("Mike"),
      arms: z.array(z.enum(["R", "L"])).min(1).max(2).optional().describe("Arms with sensors on; default both for Mike, R for walk-ups"),
      walkup: z.boolean().default(false).describe("A visitor trying the beat-the-agent challenge (blank coach profile, no history)"),
      calibrate: z.boolean().default(true),
    }),
    annotations: RW,
  }, async a => {
    try {
      const s = pipeline.startSession({ person: a.person, walkup: a.walkup, kind: "live", arms: a.arms });
      if (a.calibrate) pipeline.requestCalibration();
      return object({ ok: true, session_id: s.id, person: s.person, arms: s.arms, walkup: s.isWalkUp,
        next: a.calibrate ? "Calibration prompt sent to the dashboard: relax 3 s, then flex each muscle 3 s." : "Set armed; start curling." });
    } catch (e) { return fail(e); }
  });

  server.tool({
    name: "log_exercise",
    description: "Set the exercise, curl variant and weight for the next set (e.g. 'standing dumbbell curl, 35 lb'). Applies immediately if the current set has no reps yet. Variants: standing (DB/barbell/band), preacher, hammer.",
    schema: z.object({
      exercise: z.string().trim().min(1).max(60).describe("e.g. 'dumbbell curl', 'band curl', 'EZ bar preacher curl'"),
      variant: z.enum(["standing", "preacher", "hammer"]).default("standing"),
      load_lb: z.number().min(0).max(500).optional(),
      arms: z.array(z.enum(["R", "L"])).min(1).max(2).optional(),
    }),
    annotations: RW,
  }, async a => {
    try { return object({ ok: true, ...pipeline.logExercise(a) }); } catch (e) { return fail(e); }
  });

  server.tool({
    name: "get_reps",
    description: `Read reps by session/set: per-rep %MVC (biceps and front delt peak/mean), delt_share, cheat flag and reason, R/L share, tempo; per-set clean/cheat counts and the coach line. Use it for 'which rep did I cheat?' and 'how was that set?'. ${SCOPE}`,
    schema: z.object({ session_id: sessionArg, set_no: setArg, only_cheats: z.boolean().default(false) }),
    annotations: RO,
  }, async a => {
    const r = getReps(store, a);
    return object(r ?? { ok: false, error: "No sets recorded yet." });
  });

  server.tool({
    name: "show_last_set",
    description: `Open the muscle map for the latest set (or a chosen set): front-body map with R/L biceps and R/L front delt shaded by %MVC (untracked muscles stay gray), a per-rep scrubber with cheat reps in red, and last-rep/set/session views. Refreshes live while showing the latest set. ${SCOPE} ${STYLE}`,
    schema: z.object({ session_id: sessionArg, set_no: setArg }),
    annotations: RO,
    widget: { name: "muscle-map", invoking: "Opening the muscle map…", invoked: "Muscle map shown" },
  }, async a => {
    const v = muscleMapView(store, a);
    if (!v) return widget({ props: { empty: true, mode: "set" }, message: a.set_no !== undefined || a.session_id ? `No set ${a.set_no ?? ""} found${a.session_id ? ` in session ${a.session_id}` : ""}.` : "No sets recorded yet. Start curling with the sensors on." });
    return widget({ props: { ...v, mode: "set" }, message: mapMessage(v) });
  });

  server.tool({
    name: "compare_arms",
    description: `Compare left vs right biceps across this session's bilateral sets: R share = R biceps mean / (R + L), flagged outside 40-60%; also cheat counts per arm. Shows the muscle map with the per-set balance. Answers 'which arm is weaker?'. ${SCOPE} ${STYLE}`,
    schema: z.object({ session_id: sessionArg }),
    annotations: RO,
    widget: { name: "muscle-map", invoking: "Comparing arms…", invoked: "Arm comparison shown" },
  }, async a => {
    const c = compareArms(store, a.session_id);
    const v = muscleMapView(store, { session_id: a.session_id });
    if (!c || !v) return widget({ props: { empty: true, mode: "arms" }, message: "No sets recorded yet." });
    const msg = c.sets.length
      ? `R/L biceps share over ${c.sets.length} bilateral set(s): ${c.overall_r_share === null ? "n/a" : `${pctS(c.overall_r_share)} right / ${pctS(1 - c.overall_r_share)} left`}; weaker arm: ${c.weaker_arm}. Per set: ${c.sets.map(s => `set ${s.set_no} ${s.r_share === null ? "n/a" : pctS(s.r_share)}${s.flagged ? " (flagged)" : ""}, cheats R${s.r_cheats}/L${s.l_cheats}`).join("; ")}.`
      : "No two-arm sets in this session, so there's no L/R comparison.";
    return widget({ props: { ...v, mode: "arms", arms_compare: c }, message: msg });
  });

  server.tool({
    name: "compare_curls",
    description: `Rank this session's curl variants (standing, preacher, hammer) by biceps %MVC per rep, cheat rate and L/R balance. Same session and calibration only. Hammer curls use the forearm, which is not sensed: say 'less biceps', never 'forearm took over'. ${SCOPE}`,
    schema: z.object({ session_id: sessionArg }),
    annotations: RO,
  }, async a => object(compareCurls(store, a.session_id) ?? { ok: false, error: "No sets recorded yet." }));

  server.tool({
    name: "challenge_status",
    description: "Beat-the-agent scoreboard for today: per person, reps done and how many the code caught as cheats. Beat it = 5 reps with zero flags.",
    schema: z.object({}),
    annotations: RO,
  }, async () => object(challengeStatus(store)));

  server.tool({
    name: "get_coach_context",
    description: `The coach's context packet: profile, plan rules, today's planned vs done sets, the last history day's takeaways and the live/last set. Read this before giving advice. Weights stay constant (35 lb); never recommend load changes. ${SCOPE}`,
    schema: z.object({ person: z.string().max(60).optional().describe("Default: the current session's person") }),
    annotations: RO,
  }, async a => {
    try {
      const person = a.person ?? pipeline.sessionPerson;
      return object(buildCoachContext({ person, todaySets: store.todaySetEnds(person), setMeta: store.todaySetMeta(person) }) as unknown as Record<string, unknown>);
    } catch (e) { return fail(e); }
  });

  server.tool({
    name: "get_history",
    description: "Day summaries from data/coach/history (default last 7 days), including the real Nov 13 bench test (strict ~10% vs swing ~46% delt share).",
    schema: z.object({ days: z.number().int().min(1).max(60).default(7) }),
    annotations: RO,
  }, async a => {
    const dir = resolve(COACH_DIR, "history");
    if (!existsSync(dir)) return object({ days: [] });
    const files = readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, a.days);
    const days = files.map(f => { try { return JSON.parse(readFileSync(resolve(dir, f), "utf8")); } catch { return { file: f, error: "unreadable" }; } });
    return object({ days });
  });

  server.tool({
    name: "update_plan",
    description: "Change today's planned reps/sets/targets in data/coach/plan.json, e.g. 'bump band curls to 12 reps'. Matches today's entry by exercise name (adds one if new). Only changes what you pass. Load is fixed (35 lb dumbbells) and cannot be changed here: progress means more clean reps, not more weight.",
    schema: z.object({
      exercise: z.string().trim().min(1).max(60),
      variant: z.enum(["standing", "preacher", "hammer"]).optional(),
      sets: z.number().int().min(1).max(20).optional(),
      target_reps: z.number().int().min(1).max(50).optional(),
      note: z.string().max(200).optional(),
      load_lb: z.unknown().optional().describe("Not allowed: load is fixed at 35 lb. Passing it is refused."),
    }),
    annotations: RW,
  }, async a => {
    if (a.load_lb !== undefined) return object({ ok: false, error: "Load is fixed at 35 lb (plan rule). update_plan changes reps, sets and targets only." });
    try {
      const file = resolve(COACH_DIR, "plan.json");
      const plan = JSON.parse(readFileSync(file, "utf8")) as { today?: { sessions?: Record<string, unknown>[] } };
      plan.today ??= {};
      plan.today.sessions ??= [];
      const key = a.exercise.toLowerCase();
      let entry = plan.today.sessions.find(s => String(s.exercise ?? "").toLowerCase() === key);
      const before = entry ? { ...entry } : null;
      if (!entry) { entry = { exercise: a.exercise }; plan.today.sessions.push(entry); }
      for (const k of ["variant", "sets", "target_reps", "note"] as const) if (a[k] !== undefined) entry[k] = a[k];
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(plan, null, 2) + "\n");
      renameSync(tmp, file);
      return object({ ok: true, before, after: entry });
    } catch (e) { return fail(e instanceof HttpError ? e : new Error(`Could not update plan: ${e instanceof Error ? e.message : e}`)); }
  });
}
