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
  // in one session the strict set's clean reference carries over, so even the light swing (rep 1) is caught
  assert.equal(cheat.cheats, cheat.reps.length);
});

// ---------------------------------------------------------------------------------------------
// Nov 14 full test: 4 sensors, 35 lb dumbbells, both arms together, ~20 Hz with irregular t.
// Columns t,ph,a0..a3. Phase labels lag the movement (strict reps spill into relax4).
const CSV35 = new URL("../../data/coach/history/raw/2026-11-14-fulltest-35lb-bilateral.csv", import.meta.url);
const rows35 = readFileSync(CSV35, "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .filter((l) => l.trim())
  .map((l) => {
    const [t, ph, a0, a1, a2, a3] = l.split(",");
    return { t: +t, ph, ch: [+a0, +a1, +a2, +a3] };
  });

/** One session: the STRICT set runs until CHEAT starts, then the CHEAT set to the end. */
function runSession35(rest: number[], mvc: number[]): Record<string, SetEndEvent> {
  const e = new Engine();
  e.setCalibration({ rest, mvc, ok: true, problems: [] });
  const sets: Record<string, SetEndEvent> = {};
  let cur = "";
  rows35.forEach((r, i) => {
    if ((r.ph === "STRICT" || r.ph === "CHEAT") && r.ph !== cur) {
      const prev = e.endSet();
      if (prev) sets[prev.set_id] = prev;
      e.startSet({ session_id: "nov14", set_id: r.ph, person: "Mike", exercise: "dumbbell curl", variant: "standing", load_lb: 35, arms: ["R", "L"] });
      cur = r.ph;
    }
    const dt = i + 1 < rows35.length ? rows35[i + 1].t - r.t : 50;
    for (const ev of e.ingest({ device: "nov14", seq: i, t0_ms: r.t, dt_ms: dt, ch: r.ch.map((x) => [x]) })) {
      if (ev.type === "set_end") sets[ev.set_id] = ev;
    }
  });
  const last = e.endSet();
  if (last) sets[last.set_id] = last;
  return sets;
}

const CALS_35 = {
  // what the lead's run used (R biceps MVC from a weak FLEX, so R pct runs high)
  lead: { rest: [602, 932, 804, 1301], mvc: [9691, 14963, 14938, 14954] },
  // rest from the clean relax phases, MVC at the ENV ceiling (curls and the raise hold saturate)
  ceiling: { rest: [600, 620, 800, 900], mvc: [14960, 14960, 14960, 14960] },
};

for (const [name, cal] of Object.entries(CALS_35)) {
  test(`real 35 lb bilateral (${name} calibration): strict reps clean, swings flagged`, () => {
    const sets = runSession35(cal.rest, cal.mvc);
    const strict = sets.STRICT;
    const cheat = sets.CHEAT;
    // 7 strict reps (2 of them after the label switched to relax4), 6 swing reps
    assert.equal(strict.reps.length, 7);
    assert.equal(strict.cheats, 0, strict.reps.map((r) => `${r.rep}:${r.arm}:${r.delt_share}:${r.cheat_reason}`).join(" "));
    assert.equal(strict.decision.next, "continue");
    assert.equal(cheat.reps.length, 6);
    // Swing rep 1 has strict-level delt (R mean ~0.49 vs ~0.48 on strict reps); reps 2-6 are swings.
    assert.deepEqual(cheat.reps.map((r) => r.cheat), [false, true, true, true, true, true]);
    assert.equal(cheat.decision.next, "stop_at_first_cheat_rest_longer");
    // the delt level, not the share, is what separates them under load
    const rDelt = (s: SetEndEvent) => mean(s.reps.map((r) => r.mean_pct[1]));
    assert.ok(rDelt(cheat) > 1.4 * rDelt(strict), `${rDelt(cheat)} vs ${rDelt(strict)}`);
    // both arms worked: r_share filled
    assert.ok(strict.reps.every((r) => r.r_share !== null));
  });
}

// ---------------------------------------------------------------------------------------------
// Nov 14 right arm only, 35 lb dumbbell: 5 strict reps, 3 swings. Columns t,ph,a0..a3 (~20 Hz).
// Phase labels start ~2.5-3 s before the movement; only the signal decides, the labels just bound the sets.
const CSV_R35 = new URL("../../data/coach/history/raw/2026-11-14-right-35lb-strict-vs-swing.csv", import.meta.url);
const rowsR35 = readFileSync(CSV_R35, "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .filter((l) => l.trim())
  .map((l) => {
    const [t, ph, a0, a1, a2, a3] = l.split(",");
    return { t: +t, ph, ch: [+a0, +a1, +a2, +a3] };
  });

function runSessionR35(mvc: number[]): Record<string, SetEndEvent> {
  const e = new Engine();
  e.setCalibration({ rest: [550, 620, 800, 900], mvc, ok: true, problems: [] });
  const sets: Record<string, SetEndEvent> = {};
  let cur = "";
  rowsR35.forEach((r, i) => {
    if ((r.ph === "STRICT" || r.ph === "CHEAT") && r.ph !== cur) {
      const prev = e.endSet();
      if (prev) sets[prev.set_id] = prev;
      e.startSet({ session_id: "nov14r", set_id: r.ph, person: "Mike", exercise: "dumbbell curl", variant: "standing", load_lb: 35, arms: ["R"] });
      cur = r.ph;
    }
    const dt = i + 1 < rowsR35.length ? rowsR35[i + 1].t - r.t : 50;
    for (const ev of e.ingest({ device: "nov14r", seq: i, t0_ms: r.t, dt_ms: dt, ch: r.ch.map((x) => [x]) })) {
      if (ev.type === "set_end") sets[ev.set_id] = ev;
    }
  });
  const last = e.endSet();
  if (last) sets[last.set_id] = last;
  return sets;
}

const CALS_R35 = {
  ceiling: [14960, 14960, 14960, 14960],
  // MVC from the FLEX/RAISE holds: biceps ~10,000 (less than the curls reach), delt ~14,300
  holds: [10000, 14300, 14960, 14960],
};

for (const [name, mvc] of Object.entries(CALS_R35)) {
  test(`real 35 lb right arm (${name} MVC): 5 strict reps clean, 3 swings flagged on the up phase`, () => {
    const { STRICT: strict, CHEAT: cheat } = runSessionR35(mvc);
    assert.equal(strict.reps.length, 5);
    assert.equal(strict.cheats, 0, strict.reps.map((r) => `${r.rep}:${r.up_delt_ratio}/${r.baseline_up_delt_ratio}`).join(" "));
    assert.equal(cheat.reps.length, 3);
    assert.equal(cheat.cheats, 3, cheat.reps.map((r) => `${r.rep}:${r.up_delt_ratio}/${r.baseline_up_delt_ratio}`).join(" "));
    assert.equal(cheat.decision.next, "stop_at_first_cheat_rest_longer");
    // On the way up the swing's delt works ~1.5-1.9x harder relative to the biceps than on strict reps...
    const upMax = Math.max(...strict.reps.map((r) => r.up_delt_ratio!));
    const upMin = Math.min(...cheat.reps.map((r) => r.up_delt_ratio!));
    assert.ok(upMin > 1.3 * upMax, `strict up max ${upMax}, swing up min ${upMin}`);
    // ...while the whole-rep share separates them far less (the delt also works lowering strict reps).
    const shareMax = Math.max(...strict.reps.map((r) => r.delt_share));
    const shareMin = Math.min(...cheat.reps.map((r) => r.delt_share));
    assert.ok(shareMin - shareMax < 0.15, `share gap ${shareMin - shareMax}`);
  });
}
