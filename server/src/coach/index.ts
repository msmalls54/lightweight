// ④ Coach brain (BUILD.md). Code decides; Gemini 4 Hydrogen only phrases.
export { buildCoachContext, localDate, coachDir, type CoachContext, type Checkin } from "./context.js";
export { pickCue, pickCueSequence, pickSetEndCue, CUE_CONFIG, type PickCueOptions } from "./cues.js";
export { summarizeSet, summarizeSetDetail, answer, setBrain, geminiBrain, SYSTEM_PROMPT, SPOKEN_MAX_WORDS, type Brain, type BrainOptions } from "./brain.js";
export { writeTodayHistory, codeTakeaways, type SetMeta, type WriteHistoryOptions } from "./history.js";
export {
  setFacts, repFacts, labelRep, upRatioX, lastSessionFacts, historyBrief, sameLift, forLlm, fallbackSummary, fallbackDetail, cleanSetCue,
  mentionsLoadChange, mentionsMedical, mentionsRep, mentionsRawShare, mentionsHistory, namesAllReps, relabelSnitch, scrubSnitch,
  DETAIL_CONFIG, type SetDetail, type RepLabel, type LiftKey, type FallbackDetailOptions,
} from "./facts.js";
export type { RepEvent, SetEndEvent, CoachDecision, Arm, Variant } from "./types.js";
