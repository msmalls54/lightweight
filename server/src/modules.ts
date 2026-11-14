// The ONLY place the server imports ② engine and ④ voice/coach.
// At merge: point each line at the real module, then delete ./stubs.ts.
export { Engine, CH } from "./stubs.js"; // -> "./engine/index.js"
export type { Arm, Variant, Batch, Calibration, SetContext, LiveFrame, RepEvent, CoachDecision, SetEndEvent, EngineEvent } from "./stubs.js"; // -> "./engine/index.js"
export { pickCue, buildCoachContext, summarizeSet, answer, writeTodayHistory } from "./stubs.js"; // -> "./coach/index.js"
export type { CoachContext } from "./stubs.js"; // -> "./coach/index.js"
export { initVoice, registerVoiceRoutes } from "./stubs.js"; // -> "./voice/index.js"
