// Richer coach facts + summarizeSetDetail, on Mike's real live set (Nov 14, s-1114-122526-r82).
// Mike: set 1 reps 4 and 8 were intended swings; rep 5 "kind of activated because I was going fast".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  answer,
  buildCoachContext,
  fallbackDetail,
  fallbackSummary,
  mentionsMedical,
  mentionsRep,
  setBrain,
  setFacts,
  summarizeSet,
  summarizeSetDetail,
  type SetEndEvent,
} from "../src/coach/index.js";

const DATA = fileURLToPath(new URL("../../data/coach/", import.meta.url));
const FX = JSON.parse(
  fs.readFileSync(new URL("../src/coach/fixtures/real-session-s-1114-122526-r82.json", import.meta.url), "utf8"),
) as { sets: { set_end: SetEndEvent }[] };
const SET1 = FX.sets[0].set_end;
const SET2 = FX.sets[1].set_end;
const ctx = (sets: SetEndEvent[] = [SET1]) => buildCoachContext({ person: "Mike", todaySets: sets, dataDir: DATA });

test("real set 1: code labels the intended swings, the mild cheat and the near-miss", () => {
  const f = setFacts(SET1);
  assert.deepEqual(f.cheat_reps, [4, 5, 8]);
  assert.deepEqual(f.big_swing_reps, [4, 8]);
  assert.deepEqual(f.mild_cheat_reps, [5]);
  assert.deepEqual(f.near_miss_reps, [9]);
  assert.deepEqual(f.worst_rep, { rep: 4, arm: "R", up_delt_x_clean: 8.6 });
  assert.equal(f.reps[3].up_delt_x_clean, 8.6);
  assert.equal(f.reps[7].up_delt_x_clean, 7.4);
  assert.equal(f.reps[4].biceps_peak_pct.R, 46); // rep 5: right biceps barely worked
  assert.deepEqual(f.tempo.fast_up_reps, []); // no rep came up under 300 ms
  assert.equal(f.tempo.cheats_came_with_fast_tempo, false);
  assert.equal(f.cheat_pattern, "scattered");
  assert.equal(f.balance?.right_biceps_share_pct, 41);
  assert.match(f.balance!.verdict, /left doing more/);
});

test("real set 2: fatigue pattern from rep 6", () => {
  const f = setFacts(SET2);
  assert.deepEqual(f.cheat_reps, [6, 7, 8, 9, 10]);
  assert.match(f.cheat_pattern, /^fatigue/);
  assert.deepEqual(f.tempo.fast_up_reps, [1, 4, 7]);
  assert.match(fallbackSummary(SET2), /^From rep 6 on, your right shoulder took over, 8 to 12 times normal\. Next set, stop at the first cheat\.$/);
});

test("fallback spoken line names every cheat rep and the why", () => {
  assert.equal(
    fallbackSummary(SET1),
    "Reps 4 and 8: right shoulder at 9 and 7 times normal, that's a swing. Rep 5 smaller. Next set, stop at the first cheat.",
  );
});

test("fallback detail card covers reference, cheats, near-miss, tempo, L/R, cue; no unlike history", () => {
  const d = fallbackDetail(SET1, ctx().lastDay, { lift: { exercise: "dumbbell curl", variant: "standing", load_lb: 35 } });
  assert.equal(d.source, "code");
  assert.equal(d.headline, "3 cheats in 10 reps, first at rep 4");
  assert.ok(d.bullets.length >= 4 && d.bullets.length <= 6, String(d.bullets.length));
  const all = d.bullets.join("\n");
  assert.match(all, /Reps 1 and 2 set your clean reference/);
  assert.match(all, /Reps 4 and 8: right shoulder did 9 and 7x its normal share/);
  assert.match(all, /Rep 5: smaller cheat, your right shoulder jumped in; right biceps peaked at 46% of max/); // 2.2x: no number
  assert.match(all, /Rep 9: near-miss/);
  assert.match(all, /nothing rushed/);
  assert.match(all, /right biceps did 41%/);
  assert.doesNotMatch(all, /2026-11-13|delt share/); // Nov 13 was band curls: not like-for-like
  assert.ok(d.cue.length > 10);
  assert.equal(d.decision.next, "stop_at_first_cheat_rest_longer");
});

test("summarizeSet: per-rep table reaches the brain; a line missing a cheat rep is rejected", async () => {
  let seen = "";
  setBrain(async (_s, p) => {
    seen = p;
    return "Reps 4 and 8: your right shoulder fired 8 times harder than your clean reps, that's a swing. Stop at the first cheat and rest longer.";
  });
  assert.equal(await summarizeSet(ctx(), SET1), fallbackSummary(SET1)); // rep 5 missing
  assert.match(seen, /"up_delt_x_clean":9\b/); // whole number for Gemini
  assert.match(seen, /"big_swing_reps":\[4,8\]/);
  assert.match(seen, /"near_miss_reps":\[9\]/);
  assert.match(seen, /"fast_up_reps":\[\]/);
  assert.match(seen, /Name every cheat rep by number \(4, 5, 8\)/);

  const good = "Reps 4 and 8: your right shoulder fired 8 times harder than clean, a swing. Rep 5 was smaller. Stop at the first cheat.";
  setBrain(async () => good);
  assert.equal(await summarizeSet(ctx(), SET1), good);

  setBrain(async () => good + " And another thing that goes on and on and on.");
  assert.equal(await summarizeSet(ctx(), SET1), good); // trimmed to whole sentences within 25 words
  setBrain(async () => "Reps 4, 5 and 8 were cheats where your right shoulder did far more of the work than it does on any of your clean reps today, so watch it.");
  assert.equal(await summarizeSet(ctx(), SET1), fallbackSummary(SET1)); // one 30-word sentence: can't trim

  setBrain(async () => "Reps 4, 5 and 8 cheated. That shoulder strain will get you injured.");
  assert.equal(await summarizeSet(ctx(), SET1), fallbackSummary(SET1));
  setBrain(undefined);
});

test("summarizeSetDetail: parses Gemini JSON, rejects rule breaks", async () => {
  const card = {
    headline: "Two big swings and one sneaky cheat",
    bullets: [
      "Reps 4 and 8: right front delt fired 9 and 7 times your clean reps on the way up, a full swing.",
      "Rep 5: smaller cheat, your shoulder jumped in, with the right biceps only at 46 percent.",
      "Rep 9 was a near-miss, the shoulder crept up.",
      "Tempo was steady at about half a second up; nothing rushed.",
      "Right biceps did 41 percent of the work: left side carried more.",
    ],
    cue: "Elbows pinned, torso still; stop the set the moment the shoulder joins in.",
  };
  let opts: unknown;
  setBrain(async (_s, _p, o) => {
    opts = o;
    return "```json\n" + JSON.stringify(card) + "\n```";
  });
  const d = await summarizeSetDetail(ctx(), SET1);
  assert.deepEqual(opts, { json: true });
  assert.equal(d.source, "gemini");
  assert.equal(d.headline, card.headline);
  assert.deepEqual(d.bullets, card.bullets);
  assert.equal(d.cue, card.cue);
  assert.equal(d.decision.next, "stop_at_first_cheat_rest_longer");

  setBrain(async () => JSON.stringify({ ...card, cue: "Go lighter next set." }));
  assert.equal((await summarizeSetDetail(ctx(), SET1)).source, "code");
  setBrain(async () => JSON.stringify({ ...card, bullets: card.bullets.slice(1) })); // reps 4 and 8 no longer named anywhere
  assert.equal((await summarizeSetDetail(ctx(), SET1)).source, "code");
  setBrain(async () => "not json at all");
  assert.equal((await summarizeSetDetail(ctx(), SET1)).source, "code");
  setBrain(async () => {
    throw new Error("down");
  });
  assert.deepEqual(await summarizeSetDetail(ctx(), SET1), fallbackDetail(SET1, ctx().lastDay));
  setBrain(undefined);
});

test("answer() gets the same rich facts for every set today", async () => {
  let seen = "";
  setBrain(async (_s, p) => {
    seen = p;
    return "Reps 4, 5 and 8 in set one.";
  });
  await answer(ctx([SET1, SET2]), "Which rep did I cheat?");
  assert.match(seen, /"set_no":1/);
  assert.match(seen, /"set_no":2/);
  assert.match(seen, /"up_delt_x_clean":12\b/);
  assert.match(seen, /"right_biceps_share_pct":41/);
  assert.doesNotMatch(seen, /delt_share|"delt_peak/);
  setBrain(undefined);
});

test("mentionsRep / mentionsMedical", () => {
  assert.ok(mentionsRep("Reps 4 and 8: swing", 8));
  assert.ok(mentionsRep("rep five was close", 5));
  assert.ok(!mentionsRep("fired 8x harder", 8));
  assert.ok(!mentionsRep("fired 8.6 times", 6));
  assert.ok(mentionsMedical("that will strain your rotator cuff"));
  assert.ok(!mentionsMedical("your delt took over"));
});

test("namesAllReps accepts lists, ranges and 'from rep N on'", async () => {
  const { namesAllReps } = await import("../src/coach/facts.js");
  const all = [6, 7, 8, 9, 10];
  assert.ok(namesAllReps("Reps 6 through 10 were swings", all, 10));
  assert.ok(namesAllReps("reps six to ten", all, 10));
  assert.ok(namesAllReps("From rep 6 on, your right shoulder took over", all, 10));
  assert.ok(namesAllReps("Rep 6-10 swung", all, 10));
  assert.ok(namesAllReps("Reps 4 and 8, rep 5 mild", [4, 5, 8], 10));
  assert.ok(!namesAllReps("Reps 4 and 8 fired 8 to 12 times", [4, 5, 8], 10));
  assert.ok(!namesAllReps("Reps 6 and 10", all, 10));
});
