// The engine's "loose" verdict (fatigue creep, not a cheat) and the maxed-out shoulder sensor hint.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  _resetCueMemory,
  buildCoachContext,
  fallbackDetail,
  fallbackSummary,
  isLoose,
  labelRep,
  pickCue,
  pickCueSequence,
  pickSetEndCueSequence,
  setBrain,
  setFacts,
  summarizeSet,
  summarizeSetDetail,
  type SetEndEvent,
} from "../src/coach/index.js";
import { CLIPS } from "../src/voice/index.js";

const DATA = fileURLToPath(new URL("../../data/coach/", import.meta.url));
const R82 = JSON.parse(fs.readFileSync(new URL("../src/coach/fixtures/real-session-s-1114-122526-r82.json", import.meta.url), "utf8"));
const SET1 = R82.sets[0].set_end as SetEndEvent;
// Mike's real set 1 as the tuned engine now calls it: rep 5 (his "loose" rep) is loose, not a cheat.
const LOOSE5: SetEndEvent = {
  ...SET1,
  cheats: 2,
  clean: 8,
  reps: SET1.reps.map((r) => (r.rep === 5 ? { ...r, cheat: false, cheat_reason: null, loose: true } : r)),
};
const ONLY_LOOSE: SetEndEvent = {
  ...SET1,
  cheats: 0,
  clean: 10,
  first_cheat_rep: null,
  decision: { next: "continue", reason: "" },
  reps: SET1.reps.map((r) =>
    r.rep === 5 ? { ...r, cheat: false, cheat_reason: null, arm_detail: { R: { verdict: "loose" } } } : { ...r, cheat: false, cheat_reason: null },
  ) as SetEndEvent["reps"],
};
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

test("loose comes from the engine (rep.loose or arm_detail verdict); a cheat always wins", () => {
  const r = LOOSE5.reps[4];
  assert.equal(isLoose(r), true);
  assert.equal(labelRep(r), "loose");
  assert.equal(isLoose(ONLY_LOOSE.reps[4]), true); // via arm_detail
  assert.equal(isLoose({ ...r, cheat: true }), false);
  assert.equal(labelRep({ ...r, cheat: true }), "mild_cheat");
  const f = setFacts(LOOSE5);
  assert.deepEqual(f.cheat_reps, [4, 8]);
  assert.deepEqual(f.mild_cheat_reps, []);
  assert.deepEqual(f.loose_reps, [5]);
});

test("call-outs: a loose rep never gets a cheat call-out, only one gentle cue per set", () => {
  _resetCueMemory();
  const cues = LOOSE5.reps.map((r) => pickCueSequence(r));
  assert.deepEqual(cues[3], ["rep_4", "delt_took_over"]);
  assert.deepEqual(cues[4], ["rep_5", "a_bit_loose"]);
  assert.ok(!cues[4].includes("delt_took_over"));
  _resetCueMemory();
  const twoLoose = [5, 6].map((n) => pickCue({ ...LOOSE5.reps[4], rep: n, set_id: "lz", r_share: 0.5 }));
  assert.deepEqual(twoLoose, ["a_bit_loose", "rep_6"]); // once per set
  for (const k of ["a_bit_loose", "no_cheats"]) assert.ok(CLIPS[k], k);
  assert.deepEqual(pickSetEndCueSequence(ONLY_LOOSE), ["set_done", "no_cheats"]); // not "every rep clean"
});

test("summaries: loose is 'a bit loose', never a cheat; mild-cheat wording only for engine cheats", async () => {
  const line = fallbackSummary(LOOSE5);
  assert.equal(line, "Reps 4 and 8: right shoulder at 9 and 7 times normal, that's a swing. Next set, stop at the first cheat.");
  const only = fallbackSummary(ONLY_LOOSE);
  assert.match(only, /^10 reps, no cheats; rep 5 a bit loose\./);
  assert.ok(words(only) <= 25);
  const d = fallbackDetail(LOOSE5);
  assert.match(d.bullets.join(" "), /Rep 5: a bit loose, the shoulder crept up as you tired\. Not a cheat\./);
  assert.doesNotMatch(d.bullets.join(" "), /Rep 5: smaller cheat/);
  assert.equal(fallbackDetail(ONLY_LOOSE).headline, "10 reps, no cheats, 1 loose rep");
  let seen = "";
  setBrain(async (_s, p) => ((seen = p), "Reps 4 and 8: right shoulder at 8 times normal. Next set, stop at the first cheat."));
  await summarizeSet(buildCoachContext({ person: "Mike", todaySets: [LOOSE5], dataDir: DATA }), LOOSE5);
  assert.match(seen, /"loose_reps":\[5\]/);
  assert.match(seen, /"label":"loose"/);
  setBrain(undefined);
});

test("maxed-out shoulder sensor: one card bullet (text only), never in the prompt or the spoken line", async () => {
  const sat: SetEndEvent = { ...LOOSE5, delt_saturated: ["R"] };
  const d = fallbackDetail(sat);
  assert.equal(d.bullets.at(-1), "Your right shoulder sensor is reading maxed out: move that pad a finger-width toward the outside of the shoulder.");
  assert.ok(d.bullets.length <= 6);
  assert.match(fallbackDetail({ ...sat, delt_saturated: ["R", "L"] }).bullets.at(-1)!, /^Both shoulder sensors are reading maxed out/);
  assert.doesNotMatch(fallbackSummary(sat), /sensor/i);
  const card = { headline: "Two swings", bullets: ["Reps 4 and 8: big swings.", "Rep 5 a bit loose.", "Tempo steady."], cue: "Pin your elbows." };
  let seen = "";
  setBrain(async (_s, p) => ((seen = p), JSON.stringify(card)));
  const g = await summarizeSetDetail(buildCoachContext({ person: "Mike", todaySets: [sat], dataDir: DATA }), sat);
  assert.equal(g.source, "gemini");
  assert.deepEqual(g.bullets, [...card.bullets, "Your right shoulder sensor is reading maxed out: move that pad a finger-width toward the outside of the shoulder."]);
  assert.doesNotMatch(seen, /delt_saturated/);
  setBrain(undefined);
});
