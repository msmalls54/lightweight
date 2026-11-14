// Backup coach voice: set summaries stitched from cached Alnilam clips (pure code).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildClipSummary, CLIP_SUMMARY_MAX, coachVoiceExtras, summaryVoiceMode, SUMMARY_CLIP_KEYS, type SetEndEvent } from "../src/coach/index.js";
import { CLIPS, missingClips } from "../src/voice/index.js";

const load = (f: string) =>
  (JSON.parse(fs.readFileSync(new URL(`../src/coach/fixtures/${f}`, import.meta.url), "utf8")) as { sets: { set_end: SetEndEvent }[] }).sets.map((s) => s.set_end);
const [SET1, SET2] = load("real-session-s-1114-122526-r82.json");
const [CLEAN3] = load("real-session-s-1114-123449-zdw.json");
const say = (keys: string[]) => keys.map((k) => CLIPS[k]).join(" ");

test("real sets -> stitched summaries (count is left to the set-end sequence)", () => {
  assert.deepEqual(buildClipSummary(SET1), ["rep_4", "word_and", "rep_8", "right_shoulder_took_over", "stop_first_cheat_next", "rest_longer"]);
  assert.equal(say(buildClipSummary(SET1)), "Rep four. And Rep eight. Right shoulder took over. Stop at the first cheat next set. Rest longer.");
  assert.deepEqual(buildClipSummary(SET2), ["late_in_set", "right_shoulder_took_over", "stop_first_cheat_next", "rest_longer"]);
  assert.deepEqual(buildClipSummary(CLEAN3), ["same_weight_keep_going"]);
  assert.deepEqual(buildClipSummary({ ...CLEAN3, reps: CLEAN3.reps.slice(0, 2) }), ["learning_clean_rep", "same_weight_keep_going"]);
  const loose: SetEndEvent = { ...CLEAN3, reps: CLEAN3.reps.map((r) => (r.rep === 3 ? { ...r, loose: true } : r)) };
  assert.deepEqual(buildClipSummary(loose), ["rep_3", "a_bit_loose", "same_weight_keep_going"]);
  const swingContinue: SetEndEvent = { ...SET1, decision: { next: "continue", reason: "" } };
  assert.deepEqual(buildClipSummary(swingContinue).slice(-2), ["pin_your_elbows", "same_weight_keep_going"]);
  const left: SetEndEvent = { ...SET1, reps: SET1.reps.map((r) => ({ ...r, arm: "L" as const })) };
  assert.ok(buildClipSummary(left).includes("left_shoulder_took_over"));
});

test("<= 8 clips, every key is a real clip, missing clips are skipped", () => {
  for (const s of [SET1, SET2, CLEAN3]) {
    const k = buildClipSummary(s);
    assert.ok(k.length <= CLIP_SUMMARY_MAX);
    for (const key of k) assert.ok(key in CLIPS, key);
  }
  for (const k of SUMMARY_CLIP_KEYS) assert.ok(k in CLIPS, k);
  assert.deepEqual(buildClipSummary(SET1, (k) => k !== "word_and" && k !== "rep_8"), ["rep_4", "right_shoulder_took_over", "stop_first_cheat_next", "rest_longer"]);
  assert.ok(Array.isArray(missingClips(fs.mkdtempSync(`${process.cwd()}/.cache-test-`))));
});

test("LW_SUMMARY_VOICE: gemini by default; clips when set; extras for the coach event; log line", async () => {
  const { voiceLogLine } = await import("../src/voice/index.js");
  const old = process.env.LW_SUMMARY_VOICE;
  delete process.env.LW_SUMMARY_VOICE;
  assert.equal(summaryVoiceMode(), "gemini");
  process.env.LW_SUMMARY_VOICE = "CLIPS";
  assert.equal(summaryVoiceMode(), "clips");
  process.env.LW_SUMMARY_VOICE = "auto";
  assert.equal(summaryVoiceMode(), "gemini");
  delete process.env.LW_SUMMARY_VOICE;
  assert.deepEqual(coachVoiceExtras(SET2), { clips: ["late_in_set", "right_shoulder_took_over", "stop_first_cheat_next", "rest_longer"], voice_mode: "gemini" });
  if (old !== undefined) process.env.LW_SUMMARY_VOICE = old;
  assert.equal(voiceLogLine({ set_id: "set-9", tier: "gemini", ms: 3400 }), "[voice] set set-9: gemini 3.4 s");
  assert.equal(voiceLogLine({ set_id: "set-9", tier: "clips", ms: 16100, reason: "gemini failed (timeout)" }), "[voice] set set-9: gemini failed (timeout) -> clips 16.1 s");
});
