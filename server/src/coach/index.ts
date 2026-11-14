// ④ Coach brain (BUILD.md). Code decides; Gemini 4 Hydrogen only phrases.
export { buildCoachContext, localDate, coachDir, type CoachContext, type Checkin } from "./context.js";
export { pickCue, pickCueSequence, pickSetEndCue, CUE_CONFIG, type PickCueOptions } from "./cues.js";
export { summarizeSet, answer, setBrain, geminiBrain, SYSTEM_PROMPT, type Brain } from "./brain.js";
export { writeTodayHistory, codeTakeaways, type SetMeta, type WriteHistoryOptions } from "./history.js";
export { setFacts, fallbackSummary, mentionsLoadChange } from "./facts.js";
export type { RepEvent, SetEndEvent, CoachDecision, Arm, Variant } from "./types.js";
