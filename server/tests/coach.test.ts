import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  answer,
  buildCoachContext,
  fallbackSummary,
  mentionsLoadChange,
  pickCue,
  pickCueSequence,
  pickSetEndCue,
  setBrain,
  summarizeSet,
  writeTodayHistory,
  type RepEvent,
  type SetEndEvent,
} from "../src/coach/index.js";

const DATA = fileURLToPath(new URL("../../data/coach/", import.meta.url));

function rep(over: Partial<RepEvent> = {}): RepEvent {
  return {
    type: "rep", set_id: "s1", arm: "R", rep: 3, start_ms: 0, end_ms: 1800,
    peak_pct: [0.9, 0.15, 0, 0], mean_pct: [0.7, 0.08, 0, 0],
    delt_share: 0.1, baseline_delt_share: 0.1, cheat: false, cheat_reason: null,
    r_share: null, up_ms: 800, down_ms: 1000, ...over,
  };
}

function set(reps: RepEvent[], next: SetEndEvent["decision"]["next"] = "continue"): SetEndEvent {
  const cheats = reps.filter((r) => r.cheat);
  return {
    type: "set_end", set_id: "s1", reps, clean: reps.length - cheats.length, cheats: cheats.length,
    first_cheat_rep: cheats[0]?.rep ?? null, decision: { next, reason: "test" },
  };
}

const swingSet = () =>
  set(
    [1, 2, 3, 4, 5, 6, 7].map((n) =>
      n >= 6 ? rep({ rep: n, cheat: true, cheat_reason: "delt_share_jump", delt_share: 0.46 }) : rep({ rep: n }),
    ),
    "stop_at_first_cheat_rest_longer",
  );

test("pickCue: cheat beats everything; preacher says elbows", () => {
  const r = rep({ rep: 6, cheat: true, cheat_reason: "delt_peak", r_share: 0.8, up_ms: 200 });
  assert.equal(pickCue(r), "delt_took_over");
  assert.equal(pickCue(r, { variant: "standing" }), "delt_took_over");
  assert.equal(pickCue(r, { variant: "preacher" }), "elbows_in");
  assert.deepEqual(pickCueSequence(r), ["rep_6", "delt_took_over"]);
});

test("pickCue: imbalance, tempo, count", () => {
  assert.equal(pickCue(rep({ r_share: 0.7 })), "left_slacking"); // right doing the work
  assert.equal(pickCue(rep({ r_share: 0.3 })), "right_slacking");
  assert.equal(pickCue(rep({ r_share: 0.5 })), "rep_3");
  assert.equal(pickCue(rep({ up_ms: 250 })), "slow_it_down");
  assert.equal(pickCue(rep({ up_ms: 350 })), "rep_3"); // engine fastUpMs = 300
  assert.equal(pickCue(rep({ rep: 1 })), "rep_1");
  assert.equal(pickCue(rep({ rep: 20 })), "rep_20");
  assert.equal(pickCue(rep({ rep: 21 })), "clean_rep");
  assert.deepEqual(pickCueSequence(rep({ rep: 4 })), ["rep_4"]);
  assert.deepEqual(pickCueSequence(rep({ rep: 4, r_share: 0.7 })), ["rep_4", "left_slacking"]);
  assert.equal(pickCue({ type: "live" } as unknown as RepEvent), null);
});

test("pickSetEndCue follows the engine decision", () => {
  assert.equal(pickSetEndCue(swingSet()), "stop_and_rest");
  assert.equal(pickSetEndCue(set([rep(), rep()])), "nice_set");
  assert.equal(pickSetEndCue(set([rep({ cheat: true })], "continue")), "set_done");
});

test("buildCoachContext for Mike: profile, plan, Nov 13 history, no TODOs", () => {
  const s = swingSet();
  const ctx = buildCoachContext({ person: "Mike", todaySets: [s], dataDir: DATA });
  assert.equal(ctx.isWalkUp, false);
  assert.equal(ctx.person, "Mike");
  assert.equal((ctx.profile as { name: string }).name, "Mike");
  assert.ok(!JSON.stringify(ctx.profile).includes("TODO"));
  assert.ok(!JSON.stringify(ctx.plan).includes("TODO"));
  assert.match(JSON.stringify(ctx.plan), /35 lb/);
  assert.equal((ctx.lastDay as { date: string }).date, "2026-11-13");
  assert.deepEqual(ctx.today.sets, [s]);
});

test("buildCoachContext for a walk-up: blank profile, no history, no Mike data", () => {
  const ctx = buildCoachContext({ person: "Priya", todaySets: [], dataDir: DATA });
  assert.equal(ctx.isWalkUp, true);
  assert.equal(ctx.lastDay, null);
  const all = JSON.stringify(ctx);
  assert.ok(!/Mike|205|Cutting|2026-11-13/.test(all), all);
  assert.equal((ctx.profile as { name: string }).name, "Priya");
});

test("buildCoachContext: case-insensitive owner, empty name = owner", () => {
  assert.equal(buildCoachContext({ person: "mike", todaySets: [], dataDir: DATA }).isWalkUp, false);
  assert.equal(buildCoachContext({ person: "", todaySets: [], dataDir: DATA }).person, "Mike");
});

test("summarizeSet uses the brain, and passes facts + decision", async () => {
  let seen = "";
  setBrain(async (_sys, prompt) => {
    seen = prompt;
    return "**Seven reps**, delt took over from rep six. Stop at the first cheat and rest longer.";
  });
  const s = swingSet();
  const ctx = buildCoachContext({ person: "Mike", todaySets: [s], dataDir: DATA });
  const line = await summarizeSet(ctx, s);
  assert.equal(line, "Seven reps, delt took over from rep six. Stop at the first cheat and rest longer.");
  assert.match(seen, /"first_cheat_rep":6/);
  assert.match(seen, /stop at the first cheat/i);
  assert.match(seen, /LAST_SESSION: \{"date":"2026-11-13"/);
  setBrain(undefined);
});

test("summarizeSet rejects invented load changes and falls back to code", async () => {
  setBrain(async () => "Ugly swing. Drop the weight to 25 lb next set.");
  const s = swingSet();
  const ctx = buildCoachContext({ person: "Mike", todaySets: [s], dataDir: DATA });
  assert.equal(await summarizeSet(ctx, s), fallbackSummary(s));
  setBrain(async () => {
    throw new Error("network down");
  });
  assert.equal(await summarizeSet(ctx, s), fallbackSummary(s));
  assert.match(await answer(ctx, "How was that set?"), /offline/);
  setBrain(undefined);
});

test("mentionsLoadChange", () => {
  for (const bad of ["Go heavier next time.", "Add weight.", "Drop to 30 lb.", "Bump the dumbbells up.", "Grab a lighter band."])
    assert.ok(mentionsLoadChange(bad), bad);
  for (const ok of ["Same weight, keep going.", "Hold the weight at 35 lb and slow it down.", "Your delt took over on rep six.", "Rest longer."])
    assert.ok(!mentionsLoadChange(ok), ok);
});

test("fallbackSummary phrases the decision", () => {
  assert.equal(
    fallbackSummary(swingSet()),
    "7 reps, 2 cheats, delt took over from rep 6. Next set, stop at the first cheat and rest longer.",
  );
  assert.match(fallbackSummary(set([rep(), rep()])), /^2 reps, all clean, delt share 10 percent\. Same weight/);
});

test("writeTodayHistory writes code numbers; walk-ups skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lw-coach-"));
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: "Mike" }));
  const s = swingSet();
  const file = writeTodayHistory([s], { dataDir: dir, date: "2026-11-14", setMeta: { s1: { exercise: "dumbbell curl", variant: "standing", load_lb: 35 } } });
  assert.equal(file, path.join(dir, "history", "2026-11-14.json"));
  const day = JSON.parse(fs.readFileSync(file!, "utf8"));
  assert.equal(day.date, "2026-11-14");
  assert.equal(day.sets[0].cheats, 2);
  assert.equal(day.sets[0].first_cheat_rep, 6);
  assert.equal(day.sets[0].load_lb, 35);
  assert.equal(day.sets[0].reps[0].biceps_mean_pct_mvc, 0.7);
  assert.ok(day.coach_takeaways[0].startsWith("Set 1: 7 reps, 2 cheats (first at rep 6)"));
  assert.equal(writeTodayHistory([s], { dataDir: dir, person: "Priya" }), null);
  assert.equal(writeTodayHistory([], { dataDir: dir }), null);
});
