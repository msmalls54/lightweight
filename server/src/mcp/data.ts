// Read models for the MCP tools. Aggregation stays here (SQLite + small loops), not in the widget.
import type { Store, SessionRow, SetRow } from "../store.js";
import type { RepEvent, SetEndEvent, SetContext, Arm } from "../modules.js";

const r2 = (x: number) => Math.round(x * 100) / 100;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const BI: Record<Arm, number> = { R: 0, L: 2 };

export interface RepView { set_no: number; rep: number; arm: Arm; cheat: boolean; reason: string | null; delt_share: number; baseline_delt_share: number | null;
  biceps_peak: number; delt_peak: number; biceps_mean: number; delt_mean: number; r_share: number | null; peak_pct: number[]; mean_pct: number[]; tempo_up_ms: number; tempo_down_ms: number }
export interface SetView { set_no: number; set_id: string; exercise: string; variant: string; load_lb: number | null; arms: Arm[]; finished: boolean;
  reps: number; clean: number; cheats: number; first_cheat_rep: number | null; decision: string | null; coach_line: string | null; avg_delt_share: number | null; r_share: number | null }

export function repView(setNo: number, r: RepEvent): RepView {
  const bi = BI[r.arm], de = bi + 1;
  return { set_no: setNo, rep: r.rep, arm: r.arm, cheat: r.cheat, reason: r.cheat ? (r.cheat_reason === "delt_peak" ? "delt spike" : "delt took over") : null,
    delt_share: r2(r.delt_share), baseline_delt_share: r.baseline_delt_share === null ? null : r2(r.baseline_delt_share),
    biceps_peak: r2(r.peak_pct[bi]), delt_peak: r2(r.peak_pct[de]), biceps_mean: r2(r.mean_pct[bi]), delt_mean: r2(r.mean_pct[de]),
    r_share: r.r_share === null ? null : r2(r.r_share), peak_pct: r.peak_pct.map(r2), mean_pct: r.mean_pct.map(r2), tempo_up_ms: Math.round(r.up_ms), tempo_down_ms: Math.round(r.down_ms) };
}

function setView(row: SetRow, reps: RepEvent[]): SetView {
  const ctx = JSON.parse(row.ctx) as SetContext;
  const end = row.summary ? (JSON.parse(row.summary) as SetEndEvent) : null;
  const byRep = new Map<number, boolean>();
  for (const r of reps) byRep.set(r.rep, (byRep.get(r.rep) ?? false) || r.cheat);
  const cheatReps = [...byRep].filter(([, c]) => c).map(([n]) => n);
  const rs = reps.map(r => r.r_share).filter((x): x is number => x !== null);
  return { set_no: row.set_no, set_id: row.set_id, exercise: ctx.exercise, variant: ctx.variant, load_lb: ctx.load_lb ?? null, arms: ctx.arms, finished: !!end,
    reps: byRep.size, clean: byRep.size - cheatReps.length, cheats: cheatReps.length, first_cheat_rep: cheatReps.length ? Math.min(...cheatReps) : null,
    decision: end?.decision ? `${end.decision.next}: ${end.decision.reason}` : null, coach_line: row.coach_line,
    avg_delt_share: reps.length ? r2(avg(reps.map(r => r.delt_share))) : null, r_share: rs.length ? r2(avg(rs)) : null };
}

/** Latest session that has at least one set (any kind, so a demo replay reads like live). */
export function resolveSession(store: Store, sessionId?: string): SessionRow | undefined {
  if (sessionId) return store.getSession(sessionId);
  return store.db.prepare(`SELECT s.* FROM sessions s WHERE EXISTS (SELECT 1 FROM sets t WHERE t.session_id=s.session_id)
    ORDER BY s.started_at DESC LIMIT 1`).get() as SessionRow | undefined;
}

export function sessionDetail(store: Store, sessionId?: string) {
  const s = resolveSession(store, sessionId);
  if (!s) return null;
  const sets = store.setsFor(s.session_id).map(row => {
    const reps = store.repsFor(row.set_id);
    return { view: setView(row, reps), reps };
  });
  return { session: { session_id: s.session_id, person: s.person, walkup: !!s.is_walkup, kind: s.kind, arms: JSON.parse(s.arms) as Arm[], started_at: s.started_at,
    calibrated: !!s.calibration, replay_of: s.source_session_id }, sets };
}
export type SessionDetail = NonNullable<ReturnType<typeof sessionDetail>>;

export function getReps(store: Store, a: { session_id?: string; set_no?: number; only_cheats?: boolean }) {
  const d = sessionDetail(store, a.session_id);
  if (!d) return null;
  const sets = d.sets.filter(s => a.set_no === undefined || s.view.set_no === a.set_no).map(s => ({
    ...s.view, rep_list: s.reps.map(r => repView(s.view.set_no, r)).filter(r => !a.only_cheats || r.cheat),
  }));
  return { session: d.session, sets };
}

/** Muscle-map payload: 4-channel %MVC for last rep / set / session, plus a per-rep scrubber. */
export function muscleMapView(store: Store, a: { session_id?: string; set_no?: number }) {
  const d = sessionDetail(store, a.session_id);
  if (!d || !d.sets.length) return null;
  const chosen = a.set_no === undefined ? d.sets[d.sets.length - 1] : d.sets.find(s => s.view.set_no === a.set_no);
  if (!chosen) return null;
  const peakAvg = (reps: RepEvent[]) => [0, 1, 2, 3].map(i => r2(avg(reps.map(r => r.peak_pct[i]))));
  const allReps = d.sets.flatMap(s => s.reps);
  const reps = chosen.reps.map(r => repView(chosen.view.set_no, r));
  return {
    person: d.session.person, session_id: d.session.session_id, walkup: d.session.walkup, replay_of: d.session.replay_of,
    set: chosen.view, arms: chosen.view.arms,
    views: { last_rep: chosen.reps.length ? chosen.reps[chosen.reps.length - 1].peak_pct.map(r2) : [0, 0, 0, 0], set: peakAvg(chosen.reps), session: peakAvg(allReps) },
    reps, sets: d.sets.map(s => s.view), selected_set_no: a.set_no ?? null,
  };
}
export type MuscleMapView = NonNullable<ReturnType<typeof muscleMapView>>;

export function compareArms(store: Store, sessionId?: string) {
  const d = sessionDetail(store, sessionId);
  if (!d) return null;
  const rows = d.sets.filter(s => s.view.arms.length === 2 && s.reps.length).map(s => {
    const right = s.reps.filter(r => r.arm === "R"), left = s.reps.filter(r => r.arm === "L");
    const rBi = avg(right.map(r => r.mean_pct[0])), lBi = avg(left.map(r => r.mean_pct[2]));
    const share = rBi + lBi > 0 ? rBi / (rBi + lBi) : null;
    return { set_no: s.view.set_no, exercise: s.view.exercise, r_biceps_mean: r2(rBi), l_biceps_mean: r2(lBi), r_share: share === null ? null : r2(share),
      flagged: share !== null && (share < 0.4 || share > 0.6), weaker: share === null ? null : share < 0.5 ? "right" : share > 0.5 ? "left" : "even",
      r_cheats: right.filter(r => r.cheat).length, l_cheats: left.filter(r => r.cheat).length };
  });
  const shares = rows.map(r => r.r_share).filter((x): x is number => x !== null);
  const overall = shares.length ? r2(avg(shares)) : null;
  return { session: d.session, sets: rows, overall_r_share: overall,
    weaker_arm: overall === null ? null : Math.abs(overall - 0.5) < 0.02 ? "even" : overall < 0.5 ? "right" : "left",
    rule: "R share = R biceps mean / (R + L biceps mean), %MVC per arm's own calibration. Flag outside 0.40-0.60." };
}

export function compareCurls(store: Store, sessionId?: string) {
  const d = sessionDetail(store, sessionId);
  if (!d) return null;
  const by = new Map<string, { exercise: string; variant: string; reps: RepEvent[]; sets: number }>();
  for (const s of d.sets) {
    const key = `${s.view.variant}|${s.view.exercise}`;
    const g = by.get(key) ?? { exercise: s.view.exercise, variant: s.view.variant, reps: [], sets: 0 };
    g.reps.push(...s.reps); g.sets++; by.set(key, g);
  }
  const variants = [...by.values()].map(g => {
    const bi = g.reps.map(r => r.peak_pct[BI[r.arm]]);
    const rs = g.reps.map(r => r.r_share).filter((x): x is number => x !== null);
    return { variant: g.variant, exercise: g.exercise, sets: g.sets, reps: g.reps.length, biceps_peak_pct_per_rep: r2(avg(bi)),
      cheat_rate: g.reps.length ? r2(g.reps.filter(r => r.cheat).length / g.reps.length) : 0, avg_delt_share: r2(avg(g.reps.map(r => r.delt_share))),
      r_share: rs.length ? r2(avg(rs)) : null };
  }).sort((a, b) => b.biceps_peak_pct_per_rep - a.biceps_peak_pct_per_rep);
  return { session: d.session, variants,
    note: "Same session and calibration only. Hammer curls recruit the forearm, which is not sensed: lower biceps %MVC means less biceps, not 'forearm took over'." };
}

/** Beat-the-agent scoreboard: per person today, how many reps the code flagged. */
export function challengeStatus(store: Store) {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const rows = store.db.prepare(`SELECT s.person, s.is_walkup, s.kind, COUNT(r.rep_id) AS rep_events, SUM(r.cheat) AS cheat_events,
      COUNT(DISTINCT r.set_id || ':' || r.rep) AS reps, COUNT(DISTINCT CASE WHEN r.cheat=1 THEN r.set_id || ':' || r.rep END) AS cheat_reps
    FROM reps r JOIN sessions s ON s.session_id=r.session_id WHERE r.created_at>=? AND s.kind='live'
    GROUP BY s.person, s.is_walkup ORDER BY cheat_reps ASC, reps DESC`).all(midnight.toISOString()) as
    { person: string; is_walkup: number; kind: string; reps: number; cheat_reps: number }[];
  return { players: rows.map(r => ({ person: r.person, walkup: !!r.is_walkup, reps: r.reps, cheats_caught: r.cheat_reps,
    clean_rate: r.reps ? r2((r.reps - r.cheat_reps) / r.reps) : null })),
    rule: "The code flags a cheat when the front delt takes over (delt share jump over the first-2-rep baseline, or a delt spike). Beat it = finish 5 reps with zero flags." };
}
