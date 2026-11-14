// Latency work: instant set-end clips, 25-word spoken cap, "faster than your usual" tempo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  fallbackDetail,
  fallbackSummary,
  pickSetEndCueSequence,
  setFacts,
  SPOKEN_MAX_WORDS,
  type RepEvent,
  type SetEndEvent,
} from "../src/coach/index.js";
import { CLIPS } from "../src/voice/index.js";

const load = (f: string) =>
  (JSON.parse(fs.readFileSync(new URL(`../src/coach/fixtures/${f}`, import.meta.url), "utf8")) as { sets: { set_end: SetEndEvent }[] }).sets.map(
    (s) => s.set_end,
  );
const [SET1, SET2] = load("real-session-s-1114-122526-r82.json");
const [CLEAN3] = load("real-session-s-1114-123449-zdw.json");
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

test("set-end clip sequences from the real sets; every key is a pre-generated clip", () => {
  assert.deepEqual(pickSetEndCueSequence(SET1), ["set_done", "three_cheats", "big_swing"]);
  assert.deepEqual(pickSetEndCueSequence(SET2), ["set_done", "many_cheats", "shoulder_late"]);
  assert.deepEqual(pickSetEndCueSequence(CLEAN3), ["set_done", "all_clean"]);
  assert.deepEqual(pickSetEndCueSequence({ ...CLEAN3, reps: CLEAN3.reps.slice(0, 2) }), ["set_done", "learning_clean_rep"]);
  assert.deepEqual(pickSetEndCueSequence({ ...CLEAN3, reps: [] }), ["set_done"]);
  const oneMild: SetEndEvent = { ...SET1, cheats: 1, reps: SET1.reps.map((r) => (r.rep === 5 ? r : { ...r, cheat: false })) };
  assert.deepEqual(pickSetEndCueSequence(oneMild), ["set_done", "one_cheat"]);
  for (const s of [SET1, SET2, CLEAN3, oneMild]) for (const k of pickSetEndCueSequence(s)) assert.ok(k in CLIPS, k);
  for (const k of ["all_clean", "one_cheat", "two_cheats", "three_cheats", "four_cheats", "many_cheats", "big_swing", "shoulder_late", "learning_clean_rep"])
    assert.ok(CLIPS[k] && words(CLIPS[k]) <= 7, k);
});

test("every code-written spoken line fits the 25-word cap", () => {
  assert.equal(SPOKEN_MAX_WORDS, 25);
  const variants: SetEndEvent[] = [SET1, SET2, CLEAN3, { ...CLEAN3, reps: CLEAN3.reps.slice(0, 2) }];
  for (const next of ["continue", "stop_at_first_cheat_rest_longer", "slow_the_tempo"] as const)
    for (const s of [SET1, SET2, CLEAN3]) variants.push({ ...s, decision: { next, reason: "" } });
  for (const s of variants) {
    const line = fallbackSummary(s);
    assert.ok(words(line) <= SPOKEN_MAX_WORDS, `${words(line)} words: ${line}`);
  }
});

test("'faster than your usual': up under 0.75 x the set median, separate from rushed (< 300 ms)", () => {
  const rep = (n: number, up_ms: number): RepEvent => ({
    ...CLEAN3.reps[2], rep: n, up_ms, cheat: false, cheat_reason: null,
  });
  const set: SetEndEvent = { ...CLEAN3, reps: [rep(1, 600), rep(2, 620), rep(3, 640), rep(4, 420), rep(5, 250), rep(6, 610)], clean: 6, cheats: 0 };
  const f = setFacts(set);
  assert.equal(f.tempo.median_up_ms, 605);
  assert.deepEqual(f.tempo.fast_up_reps, [5]); // rushed
  assert.deepEqual(f.tempo.faster_than_usual_reps, [4]); // 420 < 0.75 x 605
  assert.deepEqual(setFacts(SET1).tempo.faster_than_usual_reps, [10]); // 315 ms vs median 470; Mike's rep 5 (510 ms) was not fast
  const noRush: SetEndEvent = { ...set, reps: set.reps.filter((r) => r.rep !== 5) };
  assert.match(fallbackDetail(noRush).bullets.join(" "), /nothing rushed, but rep 4 came up faster than your usual/);
});

test("the spoken first sentence of every code line carries the point in <= 15 words", async () => {
  const { spokenPart } = await import("../src/voice/index.js");
  const learning = { ...CLEAN3, reps: CLEAN3.reps.slice(0, 2) };
  const expected: [SetEndEvent, RegExp][] = [
    [SET1, /^Reps 4 and 8: right shoulder at 9 and 7 times normal, that's a swing\.$/],
    [SET2, /^From rep 6 on, your right shoulder took over, 8 to 12 times normal\.$/],
    [CLEAN3, /^All 3 reps clean, shoulder in its normal range\.$/],
    [learning, /^Still learning your clean rep, so no calls yet\.$/],
  ];
  for (const [s, re] of expected) {
    const first = spokenPart(fallbackSummary(s));
    assert.match(first, re);
    assert.ok(words(first) <= 15, first);
  }
});

test("1-rep sets and small multiples read right (no 'All 1 reps', no '1 times')", async () => {
  const { fallbackDetail: fd, fallbackSummary: fs1 } = await import("../src/coach/index.js");
  const one: SetEndEvent = { ...CLEAN3, reps: [CLEAN3.reps[2]], clean: 1, cheats: 0 };
  assert.match(fs1(one), /^1 rep, clean, shoulder in its normal range\./);
  const d = fd(one);
  assert.equal(d.headline, "1 rep, clean");
  assert.match(d.bullets.join(" "), /The rep was clean: your shoulder stayed/);
  const all = [fs1(one), d.headline, ...d.bullets].join(" ");
  assert.doesNotMatch(all, /\b1 reps\b|\b1 cheats\b|\b1 sets\b|\b1 times\b/);
  const mild: SetEndEvent = { ...SET1, cheats: 1, reps: SET1.reps.map((r) => (r.rep === 5 ? { ...r, up_delt_ratio: 0.22 } : { ...r, cheat: false })) };
  assert.match(fs1(mild), /Rep 5: your right shoulder took over\./); // 1.4x: words, no number
});
