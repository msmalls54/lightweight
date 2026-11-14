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
function replay(cal: Calibration, cfg: ConstructorParameters<typeof Engine>[0] = { autoEndMs: 30_000 }) {
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

test("live run 1 with a correct biceps MVC + flagWithoutReference: the delt-led rep 1 is a cheat by the strong rule", () => {
  const { sets } = replay({ ...LIVE_CAL, mvc: [14000, 14303, 14857, 12969] }, { autoEndMs: 30_000, flagWithoutReference: true });
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

const DEFAULT_CAL: Calibration = { rest: [550, 550, 550, 550], mvc: [14960, 14960, 14960, 14960], ok: true, problems: [] };

test("live run 1 with the DEFAULT calibration (walk-up / no calibration): sane reps, rep 1 not flagged", () => {
  const { sets, reps } = replay(DEFAULT_CAL);
  // Mike's ~4 real curls (R, ~57.8 / 61.7 / 68.5 / 82.5 s) are all found
  const starts = reps.map((r) => sec(r.start_ms));
  for (const t of [57.8, 61.7, 68.5, 82.5]) assert.ok(starts.some((x) => Math.abs(x - t) < 0.5), `curl at ~${t}s; got ${starts.map((x) => x.toFixed(1)).join(", ")}`);
  for (const r of reps) {
    const d = (r.end_ms - r.start_ms) / 1000;
    assert.ok(d >= 0.4 && d <= 2.5, `rep at ${sec(r.start_ms).toFixed(1)}s lasts ${d.toFixed(2)}s`);
  }
  assert.equal(sets[0].reps[0].baseline_delt_share, null);
  assert.equal(sets[0].reps[0].cheat, false);
  assert.equal(reps.filter((r) => r.cheat).length, 0);
});

test("live run 1: a set armed during calibration never flags Mike's real curls", () => {
  // Arm the set from t=0 so the calibration flex / raise holds (31-47 s) fall inside it. Short holds
  // (2.4-3.3 s) look like slow reps to the biceps and may count; what matters is that they never become
  // the clean reference on their own (2 plausible reps needed) and so never turn real curls into cheats.
  const e = new Engine({ autoEndMs: 30_000 });
  e.setCalibration(DEFAULT_CAL);
  const start = () => e.startSet({ session_id: "x", set_id: "cal", person: "Mike", exercise: "dumbbell curl", variant: "standing", load_lb: 35, arms: ["R", "L"] });
  start();
  const reps: { t: number; cheat: boolean; d: number }[] = [];
  for (let i = 0; i < rows.length && rows[i][0] - T0 < 90_000; i += 40) {
    const b = rows.slice(i, i + 40);
    for (const ev of e.ingest({ device: "d", seq: i, t0_ms: b[0][0], dt_ms: 5, ch: [1, 2, 3, 4].map((c) => b.map((r) => r[c])) })) {
      if (ev.type === "rep") reps.push({ t: sec(ev.start_ms), cheat: ev.cheat, d: ev.end_ms - ev.start_ms });
      if (ev.type === "set_end") start();
    }
  }
  for (const t of [61.7, 68.5, 82.5]) {
    const r = reps.find((x) => Math.abs(x.t - t) < 0.5);
    assert.ok(r, `curl at ~${t}s missing`);
    assert.equal(r!.cheat, false, `curl at ~${t}s flagged`);
  }
  assert.ok(reps.every((r) => r.d <= 3500), "nothing longer than maxRepMs");
});

test("updateRest changes only the rest levels and keeps the session reference consistent", () => {
  const e = new Engine();
  e.setCalibration(LIVE_CAL);
  const c = e.updateRest([600, 500, Number.NaN, 99_999]);
  assert.deepEqual(c.rest, [600, 500, 735, 631]); // NaN and implausible values keep the old rest
  assert.deepEqual(c.mvc, LIVE_CAL.mvc);
  assert.deepEqual(e.getCalibration()!.rest, [600, 500, 735, 631]);
});

// ---------------------------------------------------------------------------------------------
// Live run 3 (Nov 14): bilateral 35 lb, slow reps that saturate the ENV near the top for ~1.5-2 s.
// The engine on main counted ONE rep (the hold guards rejected real reps). Server config + calibration.
const CSV3 = new URL("../../data/coach/history/raw/2026-11-14-live3-200hz-10reps.csv", import.meta.url);
const rows3 = readFileSync(CSV3, "utf8").trim().split(/\r?\n/).slice(1).filter((l) => l.trim()).map((l) => l.split(",").map(Number));
const T3 = rows3[0][0];
const CAL3: Calibration = { rest: [539, 477, 735, 609], mvc: [14950, 14926, 14938, 12969], ok: true, problems: [] };

test("live run 3: all 7 slow bilateral reps counted, set auto-ends 8 s after the last", () => {
  const e = new Engine({ autoEndMs: 8_000, mvcPercentile: 0.99 }); // server ENGINE_CONFIG
  e.setCalibration(CAL3);
  let armed = false;
  const reps: { t: number; d: number }[] = [];
  let endAt: number | null = null, endReps = -1;
  for (let i = 0; i < rows3.length; i += 40) {
    const b = rows3.slice(i, i + 40);
    // set armed ~6 s before the first rep (server 21:49:15, reps from ~21:49:21)
    if (!armed && b[0][0] - T3 >= 240_500) {
      e.startSet({ session_id: "live3", set_id: "set", person: "Mike", exercise: "dumbbell curl", variant: "standing", load_lb: 35, arms: ["R", "L"] });
      armed = true;
    }
    for (const ev of e.ingest({ device: "lw-uno-1", seq: i / 40, t0_ms: b[0][0], dt_ms: 5, ch: [1, 2, 3, 4].map((c) => b.map((r) => r[c])) })) {
      if (ev.type === "rep") reps.push({ t: (ev.start_ms - T3) / 1000, d: (ev.end_ms - ev.start_ms) / 1000 });
      if (ev.type === "set_end" && endAt === null) { endAt = (b[0][0] - T3) / 1000; endReps = ev.reps.length; }
    }
  }
  assert.ok(reps.length >= 7, `${reps.length} reps: ${reps.map((r) => r.t.toFixed(1)).join(", ")}`);
  for (const t of [246.7, 250.1, 253.2, 256.0, 262.0, 266.3, 271.2]) assert.ok(reps.some((r) => Math.abs(r.t - t) < 0.5), `rep at ~${t}s missing`);
  for (const r of reps) assert.ok(r.d >= 1.5 && r.d <= 3, `rep at ${r.t.toFixed(1)}s lasts ${r.d.toFixed(2)}s`);
  assert.ok(endAt !== null, "set never auto-ended");
  const lastEnd = Math.max(...reps.map((r) => r.t + r.d));
  assert.ok(endAt! - lastEnd >= 7.5 && endAt! - lastEnd <= 9, `set_end ${endAt} vs last rep end ${lastEnd.toFixed(1)}`);
  assert.equal(endReps, reps.length);
});

// ---------------------------------------------------------------------------------------------
// Live run 4 (Nov 14, s-1114-140601-kau): 9 reps Mike intended clean. The R delt pad was re-stuck further
// forward and SATURATES on every rep; the L delt climbs with fatigue. The engine flagged 3 (reps 6, 7 L; 9 R).
const CSV4 = new URL("../../data/coach/history/raw/2026-11-14-live4-200hz-9-clean-reps.csv", import.meta.url);
const rows4 = readFileSync(CSV4, "utf8").trim().split(/\r?\n/).slice(1).filter((l) => l.trim()).map((l) => l.split(",").map(Number));
const CAL4: Calibration = { rest: [539, 477, 735, 609], mvc: [14969, 14958, 14948, 12969], ok: true, problems: [] };

test("live run 4: 9 clean reps with a pinned R delt and a fatiguing L delt -> 0 cheats", () => {
  const e = new Engine({ autoEndMs: 8_000, mvcPercentile: 0.99 });
  e.setCalibration(CAL4);
  let armed = false;
  let end: SetEndEvent | null = null;
  for (let i = 0; i < rows4.length; i += 40) {
    const b = rows4.slice(i, i + 40);
    if (!armed && b[0][0] >= 7_829_060) { // set_start (after batch t0 7,828,860)
      e.startSet({ session_id: "kau", set_id: "set", person: "Mike", exercise: "dumbbell curl", variant: "standing", load_lb: 35, arms: ["R", "L"] });
      armed = true;
    }
    for (const ev of e.ingest({ device: "lw-uno-1", seq: i / 40, t0_ms: b[0][0], dt_ms: 5, ch: [1, 2, 3, 4].map((c) => b.map((r) => r[c])) })) {
      if (ev.type === "set_end" && !end) end = ev;
    }
  }
  end ??= e.endSet();
  assert.ok(end);
  assert.equal(end!.reps.length, 9);
  assert.equal(end!.cheats, 0, end!.reps.map((r) => `${r.rep}:${r.arm}:${r.cheat_reason}`).join(" "));
  assert.ok(end!.reps.filter((r) => r.loose).length <= 2);
  assert.deepEqual(end!.delt_saturated, ["R"]); // tell Mike to move the R pad
  // R: the reference forms from the pinned first reps (high baseline) instead of never forming
  assert.ok(end!.reps.slice(2).every((r) => r.arm_detail?.R?.ref_up_delt_ratio != null));
  assert.ok(end!.reps.every((r) => r.arm_detail?.R && r.arm_detail?.L));
});
