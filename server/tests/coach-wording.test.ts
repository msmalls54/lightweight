// Mike's wording rules (Nov 14): no "snitch", history only like-for-like, never a raw delt share,
// all-clean sets said plainly, "learning your clean rep" before a reference exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  answer,
  buildCoachContext,
  fallbackDetail,
  fallbackSummary,
  mentionsHistory,
  mentionsRawShare,
  relabelSnitch,
  scrubSnitch,
  setBrain,
  setFacts,
  summarizeSet,
  summarizeSetDetail,
  type SetEndEvent,
} from "../src/coach/index.js";

const DATA = fileURLToPath(new URL("../../data/coach/", import.meta.url));
const load = (f: string) =>
  JSON.parse(fs.readFileSync(new URL(`../src/coach/fixtures/${f}`, import.meta.url), "utf8")) as {
    sets: { set_end: SetEndEvent; ctx: { exercise: string; variant: string; load_lb: number }; coach_line_at_the_time: string }[];
  };
const R82 = load("real-session-s-1114-122526-r82.json");
const ZDW = load("real-session-s-1114-123449-zdw.json");
const SET1 = R82.sets[0].set_end;
const CLEAN3 = ZDW.sets[0].set_end; // 3 clean reps at 35 lb, the set that confused Mike
const DB35 = { exercise: "dumbbell curl", variant: "standing", load_lb: 35 };

function tmpCoachDir(history: Record<string, unknown>[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lw-wording-"));
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: "Mike", coaching_style: "blunt, call out the snitch" }));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ rules: { note: "the Snitch catches swings" } }));
  fs.mkdirSync(path.join(dir, "history"));
  for (const day of history) fs.writeFileSync(path.join(dir, "history", `${day.date}.json`), JSON.stringify(day));
  return dir;
}

test("no 'snitch': relabelled in the context, scrubbed from model output", async () => {
  assert.deepEqual(relabelSnitch({ a: "the snitch fired", b: ["Snitches"] }), { a: "the front delt fired", b: ["front delts"] });
  assert.equal(scrubSnitch("The snitch took over on rep 4."), "The shoulder took over on rep 4.");
  assert.equal(scrubSnitch("your snitch front delt jumped"), "your front delt jumped");
  assert.equal(scrubSnitch("Snitch says no."), "Shoulder says no.");
  assert.equal(scrubSnitch("the shoulder snitched"), "the shoulder fired");

  const dir = tmpCoachDir();
  const ctx = buildCoachContext({ person: "Mike", todaySets: [SET1], dataDir: dir });
  let seen = "";
  setBrain(async (sys, p) => {
    seen = sys + p;
    return "Reps 4 and 8: the snitch did 8 times its normal share on the way up. Rep 5 was smaller. Stop at the first cheat and rest longer, same weight.";
  });
  const line = await summarizeSet(ctx, SET1);
  assert.doesNotMatch(seen.replace(/Never say "snitch"/, ""), /snitch/i);
  assert.doesNotMatch(line, /snitch/i);
  assert.match(line, /the shoulder did 8 times/);
  assert.doesNotMatch(await answer(ctx, "what did the snitch do?"), /snitch/i);
  setBrain(undefined);
});

test("history is compared only like-for-like (35 lb dumbbell != Nov 13 band curls)", async () => {
  const ctx = buildCoachContext({ person: "Mike", todaySets: [CLEAN3], dataDir: DATA, setMeta: { [CLEAN3.set_id]: DB35 } });
  let seen = "";
  setBrain(async (_s, p) => {
    seen = p;
    return ZDW.sets[0].coach_line_at_the_time; // the old confusing line
  });
  const line = await summarizeSet(ctx, CLEAN3);
  assert.match(seen, /LAST_SESSION_SAME_LIFT: none/);
  assert.doesNotMatch(seen, /2026-11-13|bench_test|cheat \(swing\)/); // no trace of the Nov 13 band-curl day
  assert.equal(line, fallbackSummary(CLEAN3)); // quoted 51% delt share + yesterday -> rejected
  assert.equal(line, "All 3 reps clean, your shoulder stayed in its normal range. Same groove next set: elbows pinned, squeeze at the top. Same weight, keep going.");

  setBrain(async () => "All three clean, better than yesterday. Same weight, keep going.");
  assert.equal(await summarizeSet(ctx, CLEAN3), fallbackSummary(CLEAN3)); // mentions history without like-for-like data

  // Same lift last time -> history allowed and passed in.
  const dir = tmpCoachDir([
    { date: "2026-11-10", sets: [{ ...DB35, reps: [{ cheat: true, up_delt_x_clean: 6 }, { cheat: false }], cheats: 1, first_cheat_rep: 1 }] },
  ]);
  const ctx2 = buildCoachContext({ person: "Mike", todaySets: [CLEAN3], dataDir: dir, setMeta: { [CLEAN3.set_id]: DB35 } });
  const ok = "All three reps clean, your shoulder stayed normal. Last time you had a cheat, so that's progress. Same weight, keep going.";
  setBrain(async (_s, p) => {
    seen = p;
    return ok;
  });
  assert.equal(await summarizeSet(ctx2, CLEAN3), ok);
  assert.match(seen, /LAST_SESSION_SAME_LIFT: \{"date":"2026-11-10","exercise":"dumbbell curl"/);
  assert.match(fallbackDetail(CLEAN3, ctx2.lastDay, { lift: DB35 }).bullets.join(" "), /Vs 2026-11-10, same lift: 1 cheat in 2 reps; today 0 in 3/);
  setBrain(undefined);
});

test("never a raw delt share: not in the prompt, rejected in the output", async () => {
  const ctx = buildCoachContext({ person: "Mike", todaySets: [SET1], dataDir: DATA, setMeta: { [SET1.set_id]: DB35 } });
  let seen = "";
  setBrain(async (_s, p) => {
    seen = p;
    return "Reps 4, 5 and 8: your delt share hit 57 percent. Stop at the first cheat and rest longer, same weight.";
  });
  assert.equal(await summarizeSet(ctx, SET1), fallbackSummary(SET1));
  assert.doesNotMatch(seen, /delt_share|"delt_peak|up_delt_ratio"|0\.569/);
  assert.match(seen, /"up_delt_x_clean":8\.6/);
  for (const bad of ["your delt share hit 51 percent", "shoulder at 46 percent", "front delt fired at 99%", "shoulder share was high"])
    assert.ok(mentionsRawShare(bad), bad);
  for (const ok of ["right biceps did 41 percent of the work", "your shoulder did 8 times its normal share", "biceps peaked at 46 percent"])
    assert.ok(!mentionsRawShare(ok), ok);
  for (const old of [...R82.sets, ...ZDW.sets].map((s) => fallbackSummary(s.set_end)))
    assert.ok(!mentionsRawShare(old) && !/snitch/i.test(old), old);
  assert.ok(mentionsHistory("compared to 10 percent on strict reps yesterday"));
  setBrain(undefined);
});

test("all-clean set: plain words and a technique cue, no numbers", async () => {
  const f = setFacts(CLEAN3);
  assert.equal(f.all_clean, true);
  assert.equal(f.reference_status, "set");
  assert.deepEqual(f.reference_reps, [1, 2]);
  assert.equal(f.shoulder_in_normal_range, true);
  setBrain(async () => {
    throw new Error("down");
  });
  const d = await summarizeSetDetail(buildCoachContext({ person: "Mike", todaySets: [CLEAN3], dataDir: DATA }), CLEAN3);
  assert.equal(d.headline, "All 3 reps clean");
  assert.match(d.bullets.join(" "), /shoulder stayed in its normal range/);
  assert.equal(d.cue, "Same groove next set: elbows pinned, squeeze at the top.");
  assert.doesNotMatch(JSON.stringify(d), /delt share|51|2026-11-13/);
  setBrain(undefined);
});

test("first reps before any clean reference: 'learning your clean rep'", () => {
  const learning: SetEndEvent = { ...CLEAN3, reps: CLEAN3.reps.slice(0, 2) };
  assert.equal(setFacts(learning).reference_status, "learning");
  assert.equal(fallbackSummary(learning), "2 reps in. I'm still learning your clean rep, so no calls yet. Keep them strict.");
  const d = fallbackDetail(learning);
  assert.equal(d.headline, "2 reps in, learning your clean rep");
  assert.match(d.bullets[0], /^Learning your clean rep/);
});

test("L/R balance ignores one-arm reps (r_share ~1.0 when the left didn't curl)", () => {
  const b = setFacts(CLEAN3).balance!;
  assert.deepEqual(b.reps_with_both_arms, [3]); // reps 1-2 were right-arm only
  assert.equal(b.verdict, "balanced");
});
