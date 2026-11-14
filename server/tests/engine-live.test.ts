// Regression: the first live run (Nov 14, 200 Hz, 4 ch, bilateral 35 lb, session s-1114-120548-fpi).
// The live calibration had R biceps MVC 5118 while real curls reach ~14,000, so R %MVC was ~3x too high.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Engine, type Calibration, type SetEndEvent } from "../src/engine/index.js";

const CSV = new URL("../../data/coach/history/raw/2026-11-14-live1-200hz.csv", import.meta.url);
const rows = readFileSync(CSV, "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .filter((l) => l.trim())
  .map((l) => l.split(",").map(Number));
const T0 = rows[0][0];
const LIVE_CAL: Calibration = { rest: [573, 477, 735, 631], mvc: [5118, 14303, 14857, 12969], ok: true, problems: [] };

/** Replays like the server: 40-sample batches, first set armed after calibration (t=50 s), re-armed after each set_end. */
function replay(cal: Calibration, cfg = { autoEndMs: 30_000 }) {
  const e = new Engine(cfg);
  e.setCalibration(cal);
  const sets: SetEndEvent[] = [];
  let n = 0;
  const start = () =>
    e.startSet({ session_id: "s-1114-120548-fpi", set_id: `set-${++n}`, person: "Mike", exercise: "dumbbell curl", variant: "standing", load_lb: 35, arms: ["R", "L"] });
  let started = false;
  for (let i = 0; i < rows.length; i += 40) {
    const b = rows.slice(i, i + 40);
    if (!started && b[0][0] - T0 >= 50_000) {
      start();
      started = true;
    }
    for (const ev of e.ingest({ device: "lw-uno-1", seq: i / 40, t0_ms: b[0][0], dt_ms: 5, ch: [1, 2, 3, 4].map((c) => b.map((r) => r[c])) })) {
      if (ev.type === "set_end") {
        sets.push(ev);
        start();
      }
    }
  }
  const last = e.endSet();
  if (last) sets.push(last);
  return { sets, reps: sets.flatMap((s) => s.reps), engine: e };
}
const sec = (ms: number) => (ms - T0) / 1000;

test("live run 1 (live calibration, R MVC 5118): every curl found, none merged", () => {
  const { sets, reps } = replay(LIVE_CAL);
  // What the signal shows after calibration: R curls at ~57.6, 61.7, 68.4, 82.3 s, a small R one at ~71.2 s,
  // then R at ~123.4, L at ~125.8 and a bilateral one at ~128.0 s. Delt-only raises (85, 89, 91-96, 135-141 s) are not curls.
  const starts = reps.map((r) => sec(r.start_ms));
  for (const t of [57.6, 61.7, 68.4, 82.3, 123.4, 125.8, 128.0]) {
    assert.ok(starts.some((s) => Math.abs(s - t) < 0.5), `curl at ~${t}s missing; got ${starts.map((s) => s.toFixed(1)).join(", ")}`);
  }
  assert.ok(reps.length >= 7 && reps.length <= 8, `${reps.length} reps`);
  for (const r of reps) {
    const d = (r.end_ms - r.start_ms) / 1000;
    assert.ok(d >= 0.4 && d <= 2.5, `rep at ${sec(r.start_ms).toFixed(1)}s lasts ${d.toFixed(2)}s (merged?)`);
  }
  // no reference yet on rep 1: no cheat (the old engine flagged it with delt_peak 0.98, baseline null)
  assert.equal(sets[0].reps[0].baseline_delt_share, null);
  assert.equal(sets[0].reps[0].cheat, false);
  assert.ok(sets[0].reps[0].peak_pct[1] > 0.9, "delt peak ~0.98 on that rep");
  assert.equal(reps.filter((r) => r.cheat_reason === "delt_peak" && r.baseline_delt_share === null).length, 0);
  assert.ok(reps.every((r) => r.peak_pct.every((p) => p <= 1.5)), "reported %MVC still clamped to 1.5");
});

test("live run 1: the MVC raises itself from the first set, and the stale reference is dropped", () => {
  const { sets, engine } = replay(LIVE_CAL);
  const raised = sets[0].calibration;
  assert.ok(raised, "set_end carries the raised calibration");
  // p99 of a mostly idle set (4 short curls in ~57 s) lands a bit under the curl peaks...
  assert.ok(raised!.mvc[0] > 10_000, `R biceps MVC 5118 -> ${raised!.mvc[0]} after set 1`);
  // ...and the next set raises it further
  assert.ok(engine.getCalibration()!.mvc[0] > 14_000, `after set 2: ${engine.getCalibration()!.mvc[0]}`);
  assert.ok(raised!.mvc.every((m, i) => m >= LIVE_CAL.mvc[i]), "raise-only");
  assert.deepEqual(engine.getCalibration()!.rest, LIVE_CAL.rest);
  // Set 1's reference came from a delt-led rep that only looked clean under the too-low MVC.
  // Rescaled to the real MVC it's blatant (up ratio > 1.2), so set 2 starts without it.
  assert.equal(sets[1].reps[0].baseline_up_delt_ratio, null);
});

test("live run 1 with a correct biceps MVC: the delt-led rep 1 is a cheat by the strong no-reference rule", () => {
  const { sets } = replay({ ...LIVE_CAL, mvc: [14000, 14303, 14857, 12969] });
  const r1 = sets[0].reps[0];
  assert.ok(Math.abs(sec(r1.start_ms) - 57.7) < 0.5);
  assert.equal(r1.baseline_delt_share, null);
  assert.ok(r1.up_delt_ratio! > 1.2, `up ratio ${r1.up_delt_ratio}`);
  assert.equal(r1.cheat, true);
  assert.equal(r1.cheat_reason, "delt_share_jump"); // never delt_peak without a reference
  assert.ok(sets.flatMap((s) => s.reps).slice(1).every((r) => !r.cheat));
});

test("autoEndMs controls the automatic set end", () => {
  assert.equal(replay(LIVE_CAL, { autoEndMs: 30_000 }).sets.filter((s) => s.reps.length > 0).length, 2);
  assert.equal(replay(LIVE_CAL, { autoEndMs: 10_000 }).sets.filter((s) => s.reps.length > 0).length, 3);
});
