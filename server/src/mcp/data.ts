// Read models for the MCP tools. Aggregation stays here (SQLite + small loops), not in the widget.
import type { Store, SessionRow, SetRow } from "../store.js";
import type { RepEvent, SetEndEvent, SetContext, Arm } from "../modules.js";

import { setFacts, upRatioX, labelRep, mentionsRawShare, scrubSnitch, sayableMultiple } from "../modules.js";

const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const BI: Record<Arm, number> = { R: 0, L: 2 };

/** Said once in every tool result that carries raw numbers. */
export const RAW_NOTE = "The engine's verdict per arm is the call (clean / loose / cheat); its main signal is shoulder help on the way up as a multiple of this person's clean reps (shoulder_help_x is given only when it's 3× or more, as a whole number: say it then, e.g. '8 times normal'; when it's null, describe it in words, e.g. 'the shoulder jumped in' or 'a bit loose', never '1 time' or '2 times'). Raw effort (%MVC) is context only: under load the front delt often works at about half the biceps' level even on clean reps, so never call that 'the shoulders did half the work'.";

export interface RepView {
  set_no: number; rep: number; arm: Arm;
  /** The lead numbers: verdict + up-phase shoulder help vs this person's clean reps (null until 2 reps set the reference). */
  verdict: "clean" | "loose" | "cheat"; label: string; shoulder_help_x: number | null; reason: string | null; cheat: boolean; loose: boolean;
  /** Per working arm (bilateral reps), from the engine. */
  arms?: Partial<Record<Arm, { verdict: "clean" | "loose" | "cheat"; shoulder_help_x: number | null }>>;
  /** Both biceps curled on this rep (else it says nothing about L/R balance). */
  both_arms: boolean; r_share: number | null;
  tempo_up_ms: number; tempo_down_ms: number;
  raw_effort: { biceps_peak_pct: number; delt_peak_pct: number; biceps_mean_pct: number; delt_mean_pct: number; delt_share: number; peak_pct: number[]; mean_pct: number[] };
}
export interface Balance { r_share: number | null; reps_with_both_arms: number[]; verdict: string }
export interface SetView { set_no: number; set_id: string; exercise: string; variant: string; load_lb: number | null; arms: Arm[]; finished: boolean;
  reps: number; clean: number; cheats: number; first_cheat_rep: number | null; max_shoulder_help_x: number | null; decision: string | null;
  coach_line: string | null; balance: Balance; r_share: number | null }

const HI = 0.35; // engine rep threshold (DEFAULT_CONFIG.hi): a biceps "curled" on this rep at or above it
const bothCurled = (r: RepEvent) => (r.peak_pct?.[0] ?? 0) >= HI && (r.peak_pct?.[2] ?? 0) >= HI;

/** The ONE L/R balance rule (④'s setFacts): only reps where both biceps actually curled count. */
export function balanceOf(reps: RepEvent[]): Balance {
  const f = setFacts({ type: "set_end", set_id: "x", reps, clean: 0, cheats: 0, first_cheat_rep: null, decision: { next: "continue", reason: "" } } as SetEndEvent) as { balance?: { avg_r_share: number | null; reps_with_both_arms: number[]; verdict: string } | null };
  const b = f.balance;
  if (!b || b.avg_r_share == null) return { r_share: null, reps_with_both_arms: [], verdict: "one arm only: no balance" };
  return { r_share: b.avg_r_share, reps_with_both_arms: b.reps_with_both_arms, verdict: b.verdict };
}

/** Coach lines stored before the wording fix: hide raw-share claims, reword "snitch". */
export function cleanCoachLine(line: string | null): string | null {
  if (!line) return null;
  if (mentionsRawShare(line)) return null;
  return scrubSnitch(line);
}

/** The rep's verdict: the engine's per-arm verdicts when present (worst arm wins), else its loose flag, else the ratio. */
export function eventVerdict(r: RepEvent): "clean" | "loose" | "cheat" {
  const ad = r.arm_detail ? Object.values(r.arm_detail).filter(Boolean).map(d => d!.verdict) : [];
  if (ad.length) return ad.includes("cheat") ? "cheat" : ad.includes("loose") ? "loose" : "clean";
  if (r.cheat) return "cheat";
  if (r.loose) return "loose";
  const x = upRatioX(r);
  return x != null && x >= 1.2 ? "loose" : "clean";
}

// ④: shoulder_help_x only when dramatic (>= 3x, whole number); below that Claude describes it in words.
export function repView(setNo: number, r: RepEvent): RepView {
  const bi = BI[r.arm], de = bi + 1;
  const x = upRatioX(r);
  const verdict = eventVerdict(r);
  const arms = r.arm_detail ? Object.fromEntries(Object.entries(r.arm_detail).filter(([, d]) => d).map(([a, d]) => [a, {
    verdict: d!.verdict, shoulder_help_x: d!.ref_up_delt_ratio && d!.ref_up_delt_ratio > 0 ? sayableMultiple(d!.up_delt_ratio / d!.ref_up_delt_ratio) : null }])) : undefined;
  return { set_no: setNo, rep: r.rep, arm: r.arm, verdict, label: labelRep(r), shoulder_help_x: sayableMultiple(x), cheat: r.cheat, loose: verdict === "loose", arms,
    reason: r.cheat ? (r.cheat_reason === "delt_peak" ? "shoulder spike" : "shoulder took over on the way up") : null,
    both_arms: bothCurled(r), r_share: bothCurled(r) && r.r_share != null ? r2(r.r_share) : null,
    tempo_up_ms: Math.round(r.up_ms), tempo_down_ms: Math.round(r.down_ms),
    raw_effort: { biceps_peak_pct: r2(r.peak_pct[bi]), delt_peak_pct: r2(r.peak_pct[de]), biceps_mean_pct: r2(r.mean_pct[bi]), delt_mean_pct: r2(r.mean_pct[de]),
      delt_share: r2(r.delt_share), peak_pct: r.peak_pct.map(r2), mean_pct: r.mean_pct.map(r2) } };
}

function setView(row: SetRow, reps: RepEvent[]): SetView {
  const ctx = JSON.parse(row.ctx) as SetContext;
  const end = row.summary ? (JSON.parse(row.summary) as SetEndEvent) : null;
  const byRep = new Map<number, boolean>();
  for (const r of reps) byRep.set(r.rep, (byRep.get(r.rep) ?? false) || r.cheat);
  const cheatReps = [...byRep].filter(([, c]) => c).map(([n]) => n);
  const xs = reps.map(upRatioX).filter((x): x is number => x != null);
  const balance = balanceOf(reps);
  return { set_no: row.set_no, set_id: row.set_id, exercise: ctx.exercise, variant: ctx.variant, load_lb: ctx.load_lb ?? null, arms: ctx.arms, finished: !!end,
    reps: byRep.size, clean: byRep.size - cheatReps.length, cheats: cheatReps.length, first_cheat_rep: cheatReps.length ? Math.min(...cheatReps) : null,
    max_shoulder_help_x: xs.length ? r1(Math.max(...xs)) : null,
    decision: end?.decision ? `${end.decision.next}: ${end.decision.reason}` : null, coach_line: cleanCoachLine(row.coach_line),
    balance, r_share: balance.r_share };
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
  return { session: d.session, note: RAW_NOTE, sets };
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
    const bal = s.view.balance;
    const share = bal.r_share;
    return { set_no: s.view.set_no, exercise: s.view.exercise, r_share: share, reps_with_both_arms: bal.reps_with_both_arms, verdict: bal.verdict,
      flagged: share !== null && (share < 0.4 || share > 0.6),
      r_cheats: s.reps.filter(r => r.cheat && r.arm === "R").length, l_cheats: s.reps.filter(r => r.cheat && r.arm === "L").length };
  });
  const overallBal = balanceOf(d.sets.filter(s => s.view.arms.length === 2).flatMap(s => s.reps));
  const overall = overallBal.r_share;
  return { session: d.session, sets: rows, overall_r_share: overall, overall_verdict: overallBal.verdict,
    weaker_arm: overall === null ? null : Math.abs(overall - 0.5) < 0.02 ? "even" : overall < 0.5 ? "right" : "left",
    rule: "Right share = right biceps / (right + left), only over reps where BOTH biceps actually curled; one-arm reps say nothing about balance. Flag outside 40-60%." };
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
    return { variant: g.variant, exercise: g.exercise, sets: g.sets, reps: g.reps.length, biceps_peak_pct_per_rep: r2(avg(bi)),
      cheat_rate: g.reps.length ? r2(g.reps.filter(r => r.cheat).length / g.reps.length) : 0, balance: balanceOf(g.reps) };
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
    rule: "The code flags a cheat when the shoulder takes over on the way up (shoulder help at least 1.35x this person's clean reps). Beat it = finish 5 reps with zero flags." };
}
