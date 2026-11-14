// Mike's rule: say a shoulder multiple only when it's dramatic (>= 3x his clean reps, whole number).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildCoachContext,
  fallbackDetail,
  fallbackSummary,
  forLlm,
  mentionsSmallMultiple,
  sayableMultiple,
  setBrain,
  setFacts,
  summarizeSet,
  summarizeSetDetail,
  type SetEndEvent,
} from "../src/coach/index.js";

const DATA = fileURLToPath(new URL("../../data/coach/", import.meta.url));
const read = (f: string) => JSON.parse(fs.readFileSync(new URL(`../src/coach/fixtures/${f}`, import.meta.url), "utf8"));
const JR0 = read("real-set-1114-152057-jr0.json").set_end as SetEndEvent; // rep 4: left shoulder cheat at ~1.2x, rushed
const R82 = read("real-session-s-1114-122526-r82.json").sets[0].set_end as SetEndEvent; // reps 4 and 8 at 8.6x / 7.4x
const NUM = /\d+(\.\d+)?\s*(x|×|times?)\b|\b(one|two)\s+times?\b/i;

test("sayableMultiple: whole numbers from 3x up, nothing below", () => {
  assert.equal(sayableMultiple(1.24), null);
  assert.equal(sayableMultiple(2.9), null);
  assert.equal(sayableMultiple(3), 3);
  assert.equal(sayableMultiple(8.6), 9);
  assert.equal(sayableMultiple(null), null);
});

test("real set jr0 (rep 4 L cheat ~1.2x): every code line has no number, says it in words", () => {
  assert.equal(fallbackSummary(JR0), "Rep 4: your left shoulder took over, rushed up. Same weight, keep going.");
  const card = fallbackDetail(JR0);
  assert.doesNotMatch([card.headline, ...card.bullets, card.cue].join(" "), NUM);
  assert.match(card.bullets.join(" "), /Rep 4: smaller cheat, your left shoulder jumped in/);
  const f = forLlm(setFacts(JR0));
  assert.equal(f.reps[3].up_delt_x_clean, undefined); // Gemini can't quote it
  assert.equal(f.worst_rep?.up_delt_x_clean, undefined);
});

test("real set r82 set 1 (reps 4 and 8 at 7-9x): numbers kept, whole", () => {
  assert.match(fallbackSummary(R82), /^Reps 4 and 8: right shoulder at 9 and 7 times normal, that's a swing\./);
  const f = forLlm(setFacts(R82));
  assert.equal(f.reps[3].up_delt_x_clean, 9);
  assert.equal(f.reps[7].up_delt_x_clean, 7);
  assert.equal(f.reps[4].up_delt_x_clean, undefined); // rep 5 at 2.2x: stripped
});

test("output filter: '1 time normal' / '2 times' / decimals are rejected -> code line", async () => {
  for (const bad of ["left shoulder at 1 time normal", "2 times normal", "1.4x its normal share", "two times harder", "shoulder at 8.6 times normal"])
    assert.ok(mentionsSmallMultiple(bad), bad);
  for (const ok of ["right shoulder at 9 times normal", "Reps 4 and 8: swing", "3 times normal", "29 of 40 reps"]) assert.ok(!mentionsSmallMultiple(ok), ok);
  const ctx = buildCoachContext({ person: "Mike", todaySets: [JR0], dataDir: DATA });
  let seen = "";
  let sys = "";
  setBrain(async (sy, p) => ((sys = sy), (seen = p), "Rep 4 was a mild cheat: left shoulder at 1 time normal, rushed up. Same weight, keep going."));
  assert.equal(await summarizeSet(ctx, JR0), fallbackSummary(JR0)); // the live bug line is rejected
  assert.match(sys, /Mention a shoulder multiple only if the facts include one/);
  assert.doesNotMatch(seen, /"up_delt_x_clean"/);
  setBrain(async () => JSON.stringify({ headline: "One cheat", bullets: ["Rep 4: left shoulder at 1.2x normal.", "Tempo: rep 4 rushed.", "Balanced."], cue: "Slow the way up." }));
  assert.equal((await summarizeSetDetail(ctx, JR0)).source, "code");
  setBrain(undefined);
});
