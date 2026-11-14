// The real Nov 13 bench recording: R biceps (A0) + R delt (A1), standing band curls, ~20 Hz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Engine, type Batch, type SetEndEvent } from "../src/engine/index.js";

const CSV = new URL("../../data/coach/history/raw/2026-11-13-bench.csv", import.meta.url);
const DT = 50; // ~20 samples/s

interface Row { sample: number; phase: string; a0: number; a1: number }
const rows: Row[] = readFileSync(CSV, "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((l) => {
    const [sample, phase, a0, a1] = l.split(",");
    return { sample: +sample, phase, a0: +a0, a1: +a1 };
  });

/** Phase rows as firmware-style batches (4 samples = 200 ms). Left channels sit at rest. */
function batches(phase: string): Batch[] {
  const r = rows.filter((x) => x.phase === phase);
  const out: Batch[] = [];
  for (let i = 0; i < r.length; i += 4) {
    const s = r.slice(i, i + 4);
    out.push({
      device: "bench-2026-11-13",
      seq: i / 4,
      t0_ms: s[0].sample * DT,
      dt_ms: DT,
      ch: [s.map((x) => x.a0), s.map((x) => x.a1), s.map(() => 550), s.map(() => 550)],
    });
  }
  return out;
}

function runPhase(phase: string): SetEndEvent {
  const e = new Engine();
  e.setCalibration({ rest: [570, 495, 550, 550], mvc: [14960, 14960, 14960, 14960], ok: true, problems: [] });
  e.startSet({ session_id: "bench", set_id: phase, person: "Mike", exercise: "standing band curl", variant: "standing", arms: ["R"] });
  for (const b of batches(phase)) e.ingest(b);
  return e.endSet()!;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

test("real CSV has the expected phases", () => {
  assert.ok(rows.length > 1000);
  assert.ok(batches("strict_curls").length > 40);
  assert.ok(batches("cheat_curls").length > 40);
});

test("real strict curls: 3 reps, delt share ~0.10, no cheats", () => {
  const set = runPhase("strict_curls");
  assert.equal(set.reps.length, 3);
  assert.equal(set.cheats, 0);
  const share = mean(set.reps.map((r) => r.delt_share));
  assert.ok(Math.abs(share - 0.1) < 0.03, `mean delt_share ${share}`);
  for (const r of set.reps) {
    assert.ok(r.peak_pct[0] > 0.9, "biceps hits ~100% on strict reps");
    assert.ok(r.peak_pct[1] < 0.3);
  }
  assert.equal(set.decision.next, "continue");
});

test("real swing curls: 4 reps, flagged, delt share ~0.46", () => {
  const set = runPhase("cheat_curls");
  assert.equal(set.reps.length, 4);
  const share = mean(set.reps.map((r) => r.delt_share));
  assert.ok(Math.abs(share - 0.46) < 0.06, `mean delt_share ${share}`);
  // Rep 1 is borderline (share ~0.2, delt peak ~0.35: a light swing); reps 2-4 are clear swings.
  assert.ok(set.cheats >= 3, `cheats ${set.cheats}`);
  assert.deepEqual(set.reps.slice(1).map((r) => r.cheat), [true, true, true]);
  assert.equal(set.first_cheat_rep, 2);
  // 3 cheat reps > plan's max of 1 per set
  assert.equal(set.decision.next, "stop_at_first_cheat_rest_longer");
  assert.match(set.decision.reason, /^3 cheat reps \(first at rep 2\)/);
  // swing reps use less biceps than strict ones (momentum did the work)
  const strict = runPhase("strict_curls");
  assert.ok(mean(set.reps.map((r) => r.mean_pct[0])) < mean(strict.reps.map((r) => r.mean_pct[0])));
});

test("real recording as one continuous stream: strict reps clean, swing reps flagged", () => {
  const e = new Engine();
  e.setCalibration({ rest: [570, 495, 550, 550], mvc: [14960, 14960, 14960, 14960], ok: true, problems: [] });
  const sets: SetEndEvent[] = [];
  let current: string | null = null;
  for (let i = 0; i < rows.length; i += 4) {
    const s = rows.slice(i, i + 4);
    const phase = s[0].phase;
    if ((phase === "strict_curls" || phase === "cheat_curls") && current !== phase) {
      const prev = e.endSet();
      if (prev) sets.push(prev);
      e.startSet({ session_id: "bench", set_id: phase, person: "Mike", exercise: "band curl", variant: "standing", arms: ["R"] });
      current = phase;
    }
    for (const ev of e.ingest({ device: "b", seq: i, t0_ms: s[0].sample * DT, dt_ms: DT, ch: [s.map((x) => x.a0), s.map((x) => x.a1), s.map(() => 550), s.map(() => 550)] })) {
      if (ev.type === "set_end") sets.push(ev);
    }
  }
  const last = e.endSet();
  if (last) sets.push(last);
  const strict = sets.find((x) => x.set_id === "strict_curls")!;
  const cheat = sets.find((x) => x.set_id === "cheat_curls")!;
  // The phase labels lag the movement, so the trailing "rest" holds one more rep of each kind.
  assert.ok(strict.reps.length >= 3 && strict.reps.length <= 4);
  assert.equal(strict.cheats, 0);
  assert.ok(cheat.reps.length >= 4 && cheat.reps.length <= 5);
  assert.ok(cheat.cheats >= 3);
});
