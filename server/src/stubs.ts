// THROWAWAY stand-ins for ② engine and ④ voice/coach, coded to the BUILD.md interfaces.
// Delete this file at merge and flip the imports in ./modules.ts.
import type { Hono } from "hono";

export const CH = { R_BI: 0, R_DELT: 1, L_BI: 2, L_DELT: 3 } as const;
export type Arm = "R" | "L";
export type Variant = "standing" | "preacher" | "hammer";
export interface Batch { device: string; seq: number; t0_ms: number; dt_ms: number; ch: number[][] }
export interface Calibration { rest: number[]; mvc: number[]; ok: boolean; problems: string[] }
export interface SetContext { session_id: string; set_id: string; person: string; exercise: string; variant: Variant; load_lb?: number; arms: Arm[] }
export interface LiveFrame { type: "live"; t_ms: number; pct: number[] }
export interface RepEvent { type: "rep"; set_id: string; arm: Arm; rep: number; start_ms: number; end_ms: number;
  peak_pct: number[]; mean_pct: number[]; delt_share: number; baseline_delt_share: number | null;
  cheat: boolean; cheat_reason: "delt_share_jump" | "delt_peak" | null; r_share: number | null; up_ms: number; down_ms: number }
export interface CoachDecision { next: "continue" | "stop_at_first_cheat_rest_longer" | "slow_the_tempo"; reason: string }
export interface SetEndEvent { type: "set_end"; set_id: string; reps: RepEvent[]; clean: number; cheats: number; first_cheat_rep: number | null; decision: CoachDecision }
export type EngineEvent = LiveFrame | RepEvent | SetEndEvent;

const CEIL = 14960;
const ARM_CH: Record<Arm, { bi: number; delt: number }> = { R: { bi: 0, delt: 1 }, L: { bi: 2, delt: 3 } };
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pctile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

interface Track { inRep: boolean; start: number; peakT: number; peakBi: number; sum: number[]; peak: number[]; n: number; lastEnd: number; reps: RepEvent[] }
const newTrack = (): Track => ({ inRep: false, start: 0, peakT: 0, peakBi: 0, sum: [0, 0, 0, 0], peak: [0, 0, 0, 0], n: 0, lastEnd: -Infinity, reps: [] });

/** Fake engine: simple hysteresis on the biceps, good enough to drive the dashboard. */
export class Engine {
  private cal: Calibration | null = null;
  private ctx: SetContext | null = null;
  private tracks: Record<Arm, Track> = { R: newTrack(), L: newTrack() };
  private lastRepT = 0;
  private lastT = -Infinity;
  private nextLive = -Infinity;
  constructor(_config?: Record<string, unknown>) {}

  calibrate(rest: number[][], mvc: number[][], arms?: Arm[]): Calibration {
    const used = new Set((arms ?? ["R", "L"]).flatMap(a => [ARM_CH[a].bi, ARM_CH[a].delt]));
    const r = rest.map(xs => pctile(xs, 0.5));
    const m = mvc.map(xs => pctile(xs, 0.95));
    const problems: string[] = [];
    m.forEach((v, i) => { if (used.has(i) && v - r[i] < 1000) problems.push(`ch${i}: flex barely above rest (${Math.round(v - r[i])}), check pads`); });
    const c = { rest: r, mvc: m.map((v, i) => (v - r[i] < 1000 ? CEIL : v)), ok: problems.length === 0, problems };
    this.setCalibration(c);
    return c;
  }
  setCalibration(c: Calibration) { this.cal = c; }
  startSet(ctx: SetContext) { this.ctx = ctx; this.tracks = { R: newTrack(), L: newTrack() }; this.lastRepT = this.lastT; }

  private pct(i: number, x: number) {
    if (!this.cal) return clamp(x / CEIL, 0, 1.5);
    return clamp((x - this.cal.rest[i]) / Math.max(1, this.cal.mvc[i] - this.cal.rest[i]), 0, 1.5);
  }

  ingest(b: Batch): EngineEvent[] {
    const out: EngineEvent[] = [];
    const n = Math.min(...b.ch.map(c => c.length));
    for (let i = 0; i < n; i++) {
      const t = b.t0_ms + i * b.dt_ms;
      if (t <= this.lastT) continue;
      this.lastT = t;
      const pct = [0, 1, 2, 3].map(k => this.pct(k, b.ch[k][i]));
      if (t >= this.nextLive) { out.push({ type: "live", t_ms: t, pct: pct.map(r3) }); this.nextLive = t + 50; }
      if (!this.ctx) continue;
      for (const arm of this.ctx.arms) this.step(arm, t, pct, out);
      const reps = this.tracks.R.reps.length + this.tracks.L.reps.length;
      const busy = this.ctx.arms.some(a => this.tracks[a].inRep);
      if (reps > 0 && !busy && t - this.lastRepT > 10_000) { const e = this.endSet(); if (e) out.push(e); }
    }
    return out;
  }

  private step(arm: Arm, t: number, pct: number[], out: EngineEvent[]) {
    const tr = this.tracks[arm], { bi, delt } = ARM_CH[arm];
    if (!tr.inRep) {
      if (pct[bi] >= 0.35 && t - tr.lastEnd >= 400) Object.assign(tr, { inRep: true, start: t, peakT: t, peakBi: 0, sum: [0, 0, 0, 0], peak: [0, 0, 0, 0], n: 0 });
      else return;
    }
    tr.n++;
    pct.forEach((v, k) => { tr.sum[k] += v; tr.peak[k] = Math.max(tr.peak[k], v); });
    if (pct[bi] > tr.peakBi) { tr.peakBi = pct[bi]; tr.peakT = t; }
    if (pct[bi] >= 0.15) return;
    tr.inRep = false;
    tr.lastEnd = t;
    if (t - tr.start < 600) return;
    const mean = tr.sum.map(s => s / tr.n);
    const share = mean[delt] / Math.max(1e-6, mean[delt] + mean[bi]);
    const base = tr.reps.length >= 2 ? (tr.reps[0].delt_share + tr.reps[1].delt_share) / 2 : null;
    const jump = base !== null && share > base + 0.15, peak = tr.peak[delt] > 0.5;
    const both = this.ctx!.arms.length === 2;
    const rep: RepEvent = {
      type: "rep", set_id: this.ctx!.set_id, arm, rep: tr.reps.length + 1, start_ms: tr.start, end_ms: t,
      peak_pct: tr.peak.map(r3), mean_pct: mean.map(r3), delt_share: r3(share), baseline_delt_share: base === null ? null : r3(base),
      cheat: jump || peak, cheat_reason: jump ? "delt_share_jump" : peak ? "delt_peak" : null,
      r_share: both ? r3(mean[0] / Math.max(1e-6, mean[0] + mean[2])) : null, up_ms: tr.peakT - tr.start, down_ms: t - tr.peakT,
    };
    tr.reps.push(rep);
    this.lastRepT = t;
    out.push(rep);
  }

  endSet(): SetEndEvent | null {
    if (!this.ctx) return null;
    const reps = [...this.tracks.R.reps, ...this.tracks.L.reps].sort((a, b) => a.end_ms - b.end_ms);
    const cheats = reps.filter(r => r.cheat);
    const set_id = this.ctx.set_id;
    this.ctx = null;
    return {
      type: "set_end", set_id, reps, clean: reps.length - cheats.length, cheats: cheats.length,
      first_cheat_rep: cheats.length ? Math.min(...cheats.map(r => r.rep)) : null,
      decision: cheats.length ? { next: "stop_at_first_cheat_rest_longer", reason: "delt took over" } : { next: "continue", reason: "all clean" },
    };
  }
}

// ---- ④ coach stand-ins
export interface CoachContext { profile: unknown; plan: unknown; lastDay: unknown; today: { sets: SetEndEvent[]; checkin?: { sleep: number; energy: number; soreness: number } }; person: string; isWalkUp: boolean }
export function buildCoachContext(input: { person: string; todaySets: SetEndEvent[]; checkin?: CoachContext["today"]["checkin"] }): CoachContext {
  return { profile: null, plan: null, lastDay: null, today: { sets: input.todaySets, checkin: input.checkin }, person: input.person, isWalkUp: input.person !== "Mike" };
}
export function pickCue(rep: RepEvent): string | null {
  if (rep.cheat) return "delt_took_over";
  return rep.rep <= 20 ? `rep_${rep.rep}` : "clean_rep";
}
export async function summarizeSet(_ctx: CoachContext, set: SetEndEvent): Promise<string> {
  return set.cheats ? `${set.clean} clean, then rep ${set.first_cheat_rep} the delt took over. Stop there next time.` : `${set.clean} clean reps. Nice set.`;
}
export async function answer(_ctx: CoachContext, _question: string): Promise<string> { return "(stub coach) Ask me again once the coach is merged."; }
export function writeTodayHistory(_sets: SetEndEvent[]): void {}

// ---- ④ voice stand-ins (routes absent until ④ merges)
export async function initVoice(_opts: { apiKey: string; cacheDir: string }): Promise<void> {}
export function registerVoiceRoutes(_app: Hono<any, any, any>): void {}
