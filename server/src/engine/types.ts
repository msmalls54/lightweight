// Public types, exactly as in BUILD.md "② Signal engine API".

export const CH = { R_BI: 0, R_DELT: 1, L_BI: 2, L_DELT: 3 } as const;
export type Arm = "R" | "L";
export type Variant = "standing" | "preacher" | "hammer";

export interface Batch { device: string; seq: number; t0_ms: number; dt_ms: number; ch: number[][] }
/** Length-4 arrays, indexed by CH. */
export interface Calibration { rest: number[]; mvc: number[]; ok: boolean; problems: string[] }
export interface SetContext {
  session_id: string; set_id: string; person: string; exercise: string; variant: Variant; load_lb?: number; arms: Arm[];
}
/** ~20 Hz, %MVC 0..1.5 per channel. */
export interface LiveFrame { type: "live"; t_ms: number; pct: number[] }
export interface RepEvent {
  type: "rep"; set_id: string; arm: Arm; rep: number; start_ms: number; end_ms: number;
  peak_pct: number[]; mean_pct: number[]; delt_share: number; baseline_delt_share: number | null;
  cheat: boolean; cheat_reason: "delt_share_jump" | "delt_peak" | null; r_share: number | null; up_ms: number; down_ms: number;
}
/** Load NEVER changes (35 lb constant). */
export interface CoachDecision { next: "continue" | "stop_at_first_cheat_rest_longer" | "slow_the_tempo"; reason: string }
export interface SetEndEvent {
  type: "set_end"; set_id: string; reps: RepEvent[]; clean: number; cheats: number; first_cheat_rep: number | null; decision: CoachDecision;
}
export type EngineEvent = LiveFrame | RepEvent | SetEndEvent;

export const ARM_CH: Record<Arm, { bi: number; delt: number }> = {
  R: { bi: CH.R_BI, delt: CH.R_DELT },
  L: { bi: CH.L_BI, delt: CH.L_DELT },
};

export const CHANNEL_NAMES = ["R biceps (A0)", "R front delt (A1)", "L biceps (A2)", "L front delt (A3)"] as const;
