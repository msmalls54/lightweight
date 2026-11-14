// Public API of the signal engine (BUILD.md "② Signal engine API"). Pure TypeScript, no I/O.
export { CH } from "./types.js";
export type {
  Arm,
  Variant,
  Batch,
  Calibration,
  SetContext,
  LiveFrame,
  RepEvent,
  CoachDecision,
  SetEndEvent,
  EngineEvent,
} from "./types.js";
export { Engine } from "./engine.js";
// Needed to type the constructor argument / read the defaults.
export { DEFAULT_CONFIG } from "./config.js";
export type { EngineConfig, RepThresholds } from "./config.js";
