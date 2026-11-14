// Workout-level coach ("Workout so far") on Mike's real Nov 14 sets.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  answer,
  buildCoachContext,
  fallbackSession,
  isWorkoutQuestion,
  mentionsRawShare,
  setBrain,
  summarizeSession,
  workoutFacts,
  workoutInputFromContext,
  type LiftKey,
  type SetEndEvent,
} from "../src/coach/index.js";

const DATA = fileURLToPath(new URL("../../data/coach/", import.meta.url));
const FX = JSON.parse(fs.readFileSync(new URL("../src/coach/fixtures/real-day-2026-11-14-mike.json", import.meta.url), "utf8")) as {
  sets: { set_end: SetEndEvent; lift: LiftKey }[];
};
const SETS = FX.sets.map((s) => ({ set: s.set_end, lift: s.lift }));
const LOGGED = [{ exercise: "lat pulldown", variant: "cable", load_lb: 120, sets: 3, reps: 10 }];
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const ctx = () =>
  buildCoachContext({
    person: "Mike",
    todaySets: SETS.map((s) => s.set),
    dataDir: DATA,
    setMeta: Object.fromEntries(SETS.map((s) => [s.set.set_id, s.lift])),
  });

test("workoutFacts on the real day: trend, fatigue, arm, best set, focus", () => {
  const w = workoutFacts({ sets: SETS, logged: LOGGED });
  assert.deepEqual(w.totals, { sets: 11, working_sets: 6, reps: 40, clean: 29, cheats: 11 });
  const e = w.exercises[0];
  assert.equal(w.exercises.length, 1);
  assert.equal(e.label, "dumbbell curl 35 lb");
  assert.deepEqual(e.cheats_per_working_set.map((s) => s.cheats), [1, 0, 0, 3, 5, 0]);
  assert.equal(e.trend, "cleaner");
  assert.equal(e.last_working_set_clean, true);
  assert.deepEqual(e.first_cheat_rep_long_sets, [{ set: 9, rep: 4 }, { set: 10, rep: 6 }]);
  assert.equal(e.cheat_arm, "R");
  assert.deepEqual(e.cheat_arm_counts, { R: 10, L: 1 });
  assert.deepEqual(e.best_set, { set: 9, reps: 10, cheats: 3 });
  assert.equal(w.focus.key, "stop_at_first_cheat");
  assert.equal(w.logged[0].sensed, false);
});

test("sets group by lift; a different load is its own block", () => {
  const other = SETS.slice(-3).map((s) => ({ ...s, lift: { ...s.lift, load_lb: 25 } }));
  const w = workoutFacts({ sets: [...SETS.slice(0, -3), ...other], logged: [] });
  assert.deepEqual(w.exercises.map((e) => e.label), ["dumbbell curl 35 lb", "dumbbell curl 25 lb"]);
});

test("code card: 3-5 bullets incl. logged lift, focus, spoken <= 20 words, no raw share", () => {
  const s = fallbackSession({ sets: SETS, logged: LOGGED });
  assert.equal(s.source, "code");
  assert.equal(s.headline, "6 working sets so far: 29 of 40 reps clean");
  assert.ok(s.bullets.length >= 3 && s.bullets.length <= 5, String(s.bullets.length));
  const all = s.bullets.join(" ");
  assert.match(all, /Trend: cleaner as you go, and your last set was clean/);
  assert.match(all, /10 of 11 cheats came from your right shoulder/);
  assert.match(all, /Also logged: lat pulldown 3x10 at 120 lb \(no sensors\)/);
  assert.match(s.focus_next, /End each set at the first cheat: your right shoulder takes over late/);
  assert.equal(s.spoken, "29 of 40 reps clean so far. Rest of the session: end each set at the first cheat.");
  assert.ok(words(s.spoken) <= 20);
  assert.ok(!mentionsRawShare(all + s.spoken) && !/snitch/i.test(all));
  assert.equal(fallbackSession({ sets: [], logged: [] }).headline, "No sensed sets yet today");
});

test("summarizeSession: Gemini JSON used; rule breaks fall back to the code card", async () => {
  const card = {
    headline: "Cleaner as you go, right shoulder still sneaks in",
    bullets: [
      "Six working sets of 35 lb curls: cheats went 3 then 5, then a clean finish.",
      "Fatigue shows from rep 4 to rep 6 in your 10-rep sets.",
      "Ten of eleven cheats came from your right shoulder.",
      "Lat pulldown 3x10 at 120 lb logged, no sensors.",
    ],
    focus_next: "End each set the moment your right shoulder joins in.",
    spoken: "Twenty-nine of forty reps clean. Rest of the session: stop each set at the first cheat.",
  };
  let seen = "";
  setBrain(async (_s, p, o) => {
    seen = p;
    assert.deepEqual(o, { json: true });
    return JSON.stringify(card);
  });
  const s = await summarizeSession(ctx(), { logged: LOGGED });
  assert.equal(s.source, "gemini");
  assert.deepEqual(s.bullets, card.bullets);
  assert.equal(s.spoken, card.spoken);
  assert.deepEqual(s.totals, { sets: 11, working_sets: 6, reps: 40, clean: 29, cheats: 11 });
  assert.match(seen, /FOCUS \(chosen by code, restate it\): End each set at the first cheat/);
  assert.doesNotMatch(seen, /delt_share|"up_delt_ratio"|2026-11-13/);

  for (const bad of [
    { ...card, focus_next: "Drop to 30 lb for the rest of the session." },
    { ...card, bullets: [...card.bullets.slice(0, 3), "Your delt share hit 51 percent."] },
    { ...card, headline: "Better than yesterday" },
    { ...card, bullets: card.bullets.slice(0, 2) },
  ]) {
    setBrain(async () => JSON.stringify(bad));
    assert.equal((await summarizeSession(ctx(), { logged: LOGGED })).source, "code", JSON.stringify(bad).slice(0, 80));
  }
  setBrain(async () => JSON.stringify({ ...card, spoken: "Twenty-nine of forty clean. " + "Keep going strong today. ".repeat(6) }));
  assert.ok(words((await summarizeSession(ctx())).spoken) <= 20);
  setBrain(async () => {
    throw new Error("down");
  });
  assert.equal((await summarizeSession(ctx())).source, "code");
  setBrain(undefined);
});

test("answer('how's my workout going?') -> the <= 20-word workout line; rep questions are not rerouted", async () => {
  assert.ok(isWorkoutQuestion("How's my workout going?"));
  assert.ok(isWorkoutQuestion("how am I doing so far"));
  assert.ok(!isWorkoutQuestion("Which rep did I cheat today?"));
  assert.ok(!isWorkoutQuestion("Which arm is weaker?"));
  setBrain(async (_s, _p, o) => (o?.json ? "not json" : "should not be used"));
  const a = await answer(ctx(), "How's my workout going?");
  assert.equal(a, "29 of 40 reps clean so far. Rest of the session: end each set at the first cheat.");
  assert.equal(await answer(ctx(), "Which rep did I cheat?"), "should not be used");
  setBrain(undefined);
});

test("workoutInputFromContext uses today's sets and setMeta by default", () => {
  const i = workoutInputFromContext(ctx());
  assert.equal(i.sets.length, 11);
  assert.deepEqual(i.sets[0].lift, { exercise: "dumbbell curl", variant: "standing", load_lb: 35 });
  assert.deepEqual(i.logged, []);
});
