// The ONLY place the server imports ② engine and ④ voice/coach.
export { Engine, CH } from "./engine/index.js";
export type { Arm, Variant, Batch, Calibration, SetContext, LiveFrame, RepEvent, CoachDecision, SetEndEvent, EngineEvent } from "./engine/index.js";
export { pickCue, pickCueSequence, pickSetEndCue, pickSetEndCueSequence, buildCoachContext, summarizeSet, summarizeSetDetail, answer, writeTodayHistory } from "./coach/index.js";
export type { CoachContext, SetMeta, SetDetail } from "./coach/index.js";
export { initVoice, registerVoiceRoutes, loadGeminiKey, DEFAULT_VOICE_CACHE, speak } from "./voice/index.js";
