// Real engine -> coach: the call-outs and summaries follow the engine's events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Engine, type EngineEvent, type RepEvent, type SetContext, type SetEndEvent } from "../src/engine/index.js";
import { presets, synth, toBatches, type SynthRep } from "../src/engine/fixtures.js";
import { buildCoachContext, fallbackSummary, pickCueSequence, pickSetEndCue, setBrain, summarizeSet } from "../src/coach/index.js";
import { CLIPS } from "../src/voice/index.js";

const DATA = fileURLToPath(new URL("../../data/coach/", import.meta.url));
const REST = [570, 495, 560, 520];
const CTX: SetContext = {
  session_id: "s1", set_id: "set-1", person: "Mike", exercise: "dumbbell curl", variant: "standing", load_lb: 35, arms: ["R"],
};

function run(reps: SynthRep[]) {
  const e = new Engine();
  e.setCalibration({ rest: REST, mvc: [14960, 14960, 14960, 14960], ok: true, problems: [] });
  const s = synth(reps, { rest: REST });
  e.startSet(CTX);
  const events: EngineEvent[] = [];
  for (const b of toBatches(s.ch, s.hz)) events.push(...e.ingest(b));
  const end = e.endSet() ?? (events.find((x) => x.type === "set_end") as SetEndEvent);
  return { reps: events.filter((x): x is RepEvent => x.type === "rep"), end };
}

test("fatigue drift: delt call-out from the first flagged rep, every cue key is a real clip", async () => {
  const { reps, end } = run(presets.fatigueDrift(10));
  const cues = reps.map((r) => pickCueSequence(r, { variant: "standing" }));
  for (const keys of cues) for (const k of keys) assert.ok(k in CLIPS, `no clip for ${k}`);
  const firstCheat = end.first_cheat_rep;
  assert.ok(firstCheat != null && firstCheat >= 6, `first cheat ${firstCheat}`);
  assert.deepEqual(cues[firstCheat - 1], [`rep_${firstCheat}`, "delt_took_over"]);
  assert.deepEqual(cues[0], ["rep_1"]);
  assert.ok(pickSetEndCue(end) in CLIPS);

  setBrain(async () => {
    throw new Error("offline");
  });
  const ctx = buildCoachContext({ person: "Mike", todaySets: [end], dataDir: DATA });
  assert.equal(await summarizeSet(ctx, end), fallbackSummary(end));
  assert.match(fallbackSummary(end), new RegExp(`delt took over from rep ${firstCheat}`));
  setBrain(undefined);
});

test("clean set ends with nice_set; fast set gets slow_it_down", () => {
  assert.equal(pickSetEndCue(run(presets.clean(6)).end), "nice_set");
  const fast = run(presets.fast(6));
  assert.ok(fast.reps.some((r) => pickCueSequence(r).includes("slow_it_down")));
});
