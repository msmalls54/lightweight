// Local copy of the engine types from BUILD.md "② Signal engine API".
// TODO(merge): replace this file's body with `export type { ... } from "../engine/index.js";`
export type Arm = "R" | "L";
export type Variant = "standing" | "preacher" | "hammer";

export interface RepEvent {
  type: "rep";
  set_id: string;
  arm: Arm;
  rep: number;
  start_ms: number;
  end_ms: number;
  peak_pct: number[];
  mean_pct: number[];
  delt_share: number;
  baseline_delt_share: number | null;
  cheat: boolean;
  cheat_reason: "delt_share_jump" | "delt_peak" | null;
  r_share: number | null;
  up_ms: number;
  down_ms: number;
}

/** Load NEVER changes (35 lb constant). */
export interface CoachDecision {
  next: "continue" | "stop_at_first_cheat_rest_longer" | "slow_the_tempo";
  reason: string;
}

export interface SetEndEvent {
  type: "set_end";
  set_id: string;
  reps: RepEvent[];
  clean: number;
  cheats: number;
  first_cheat_rep: number | null;
  decision: CoachDecision;
}
