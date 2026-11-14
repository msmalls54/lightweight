// ④ Coach brain (BUILD.md). Code decides; Gemini 4 Hydrogen only phrases.
export { buildCoachContext, localDate, coachDir, type CoachContext, type Checkin } from "./context.js";
export { pickCue, pickCueSequence, pickSetEndCue, pickSetEndCueSequence, repImbalance, _resetCueMemory, CUE_CONFIG, type PickCueOptions } from "./cues.js";
export { summarizeSet, summarizeSetDetail, summarizeSession, isWorkoutQuestion, answer, setBrain, geminiBrain, SYSTEM_PROMPT, type Brain, type BrainOptions } from "./brain.js";
export { writeTodayHistory, codeTakeaways, type SetMeta, type WriteHistoryOptions } from "./history.js";
export {
  setFacts, repFacts, labelRep, isLoose, sensorBullet, withSensorBullet, upRatioX, lastSessionFacts, historyBrief, sameLift, forLlm, fallbackSummary, fallbackDetail, cleanSetCue, decisionShort, SPOKEN_MAX_WORDS,
  mentionsLoadChange, mentionsMedical, mentionsRep, mentionsRawShare, mentionsHistory, namesAllReps, relabelSnitch, scrubSnitch,
  DETAIL_CONFIG, type SetDetail, type RepLabel, type LiftKey, type FallbackDetailOptions,
} from "./facts.js";
export type { RepEvent, SetEndEvent, CoachDecision, Arm, Variant } from "./types.js";
export {
  workoutFacts, workoutInputFromContext, fallbackSession, pickFocus, WORKING_SET_MIN_REPS, LONG_SET_MIN_REPS, WORKOUT_SPOKEN_MAX_WORDS,
  type SessionSummary, type WorkoutInput, type LoggedLift, type WorkoutFacts, type ExerciseFacts,
} from "./session.js";
export { buildClipSummary, coachVoiceExtras, summaryVoiceMode, CLIP_SUMMARY_MAX, SUMMARY_CLIP_KEYS, type SummaryVoiceMode } from "./clips.js";
