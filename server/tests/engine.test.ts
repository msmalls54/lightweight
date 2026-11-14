import { test } from "node:test";
import assert from "node:assert/strict";
import { CH, DEFAULT_CONFIG, Engine, type EngineEvent, type RepEvent, type SetContext, type SetEndEvent } from "../src/engine/index.js";
import { hold, presets, synth, toBatches, type SynthOptions, type SynthRep } from "../src/engine/fixtures.js";

const CTX: SetContext = {
  session_id: "s1",
  set_id: "set-1",
  person: "Mike",
  exercise: "dumbbell curl",
  variant: "standing",
  load_lb: 35,
  arms: ["R"],
};

const REST = [570, 495, 560, 520];
const MVC = [14960, 14960, 14960, 14960];

function calibrated(cfg?: ConstructorParameters<typeof Engine>[0]): Engine {
  const e = new Engine(cfg);
  e.setCalibration({ rest: REST, mvc: MVC, ok: true, problems: [] });
  return e;
}

/** Runs one set through the engine; returns all events and the set_end. */
function runSet(e: Engine, reps: SynthRep[], ctx: Partial<SetContext> = {}, opts: SynthOptions = {}) {
  const s = synth(reps, { rest: REST, ...opts });
  e.startSet({ ...CTX, ...ctx });
  const events: EngineEvent[] = [];
  for (const b of toBatches(s.ch, s.hz)) events.push(...e.ingest(b));
  const end = e.endSet() ?? (events.find((x) => x.type === "set_end") as SetEndEvent);
  const repEvents = events.filter((x): x is RepEvent => x.type === "rep");
  return { events, repEvents, end, synth: s };
}

test("exports the BUILD.md channel map", () => {
  assert.deepEqual(CH, { R_BI: 0, R_DELT: 1, L_BI: 2, L_DELT: 3 });
});

test("clean set: every rep found, none flagged, decision continue", () => {
  const { end, repEvents } = runSet(calibrated(), presets.clean(8));
  assert.equal(end.reps.length, 8);
  assert.equal(repEvents.length, 8);
  assert.equal(end.cheats, 0);
  assert.equal(end.clean, 8);
  assert.equal(end.first_cheat_rep, null);
  assert.equal(end.decision.next, "continue");
  for (const r of end.reps) {
    assert.ok(r.delt_share > 0.05 && r.delt_share < 0.15, `rep ${r.rep} share ${r.delt_share}`);
    assert.equal(r.arm, "R");
    assert.equal(r.r_share, null);
    assert.ok(r.end_ms - r.start_ms > 1000);
    assert.ok(r.up_ms > 300 && r.down_ms > 300);
  }
  assert.deepEqual(end.reps.map((r) => r.rep), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(end.reps[0].baseline_delt_share, null);
  assert.equal(end.reps[1].baseline_delt_share, null);
  assert.ok(end.reps[2].baseline_delt_share! > 0.05);
});

test("rep windows line up with the ground truth", () => {
  const { end, synth: s } = runSet(calibrated(), presets.clean(4));
  end.reps.forEach((r, i) => {
    const truth = s.reps[i];
    const start = r.start_ms - 100_000;
    assert.ok(start >= truth.start && start < truth.start + 500, `start ${start} vs ${truth.start}`);
    assert.ok(r.end_ms - 100_000 <= truth.end, `end ${r.end_ms - 100_000} vs ${truth.end}`);
  });
});

test("default: no cheat flag before a clean reference exists, even on blatant swings", () => {
  const { end } = runSet(calibrated(), presets.swing(5));
  assert.equal(end.reps.length, 5);
  assert.equal(end.cheats, 0);
  assert.ok(end.reps.every((r) => r.baseline_delt_share === null)); // blatant reps never become the reference
});

test("flagWithoutReference: blatant swing set flagged from rep 1 by the strong rules", () => {
  const { end } = runSet(calibrated({ flagWithoutReference: true }), presets.swing(5));
  assert.equal(end.reps.length, 5);
  assert.equal(end.cheats, 5);
  assert.equal(end.first_cheat_rep, 1);
  for (const r of end.reps) {
    assert.ok(r.delt_share > 0.4, `share ${r.delt_share}`);
    assert.ok(r.cheat_reason === "delt_share_jump" || r.cheat_reason === "delt_peak");
  }
});

test("fatigue drift: clean through rep 5, delt takes over from rep 6", () => {
  const { end } = runSet(calibrated(), presets.fatigueDrift(10));
  assert.equal(end.reps.length, 10);
  assert.deepEqual(end.reps.slice(0, 5).map((r) => r.cheat), [false, false, false, false, false]);
  assert.equal(end.first_cheat_rep, 6);
  assert.ok(end.reps.slice(5).every((r) => r.cheat));
  assert.equal(end.reps[5].cheat_reason, "delt_share_jump");
  // delt_share trends up after rep 5
  const shares = end.reps.map((r) => r.delt_share);
  for (let i = 6; i < shares.length; i++) assert.ok(shares[i] >= shares[i - 1] - 0.01);
  // 5 cheat reps > plan's max of 1 per set
  assert.equal(end.decision.next, "stop_at_first_cheat_rest_longer");
  assert.match(end.decision.reason, /5 cheat reps \(first at rep 6\); the plan allows 1 cheat rep\./);
});

test("delt peak alone flags a rep", () => {
  // biceps works hard, so share stays low, but the delt spikes past 0.5
  // share and delt-level rules switched off so only the peak rule can fire
  const reps: SynthRep[] = [...presets.clean(3), { bi: 1.3, delt: 0.55 }];
  const { end } = runSet(calibrated({ deltShareJump: 0.5, deltMeanJump: 5, upRatioJump: 5 }), reps);
  const last = end.reps[3];
  assert.ok(last.delt_share < 0.35);
  assert.equal(last.cheat, true);
  assert.equal(last.cheat_reason, "delt_peak");
});

test("heavy load: hard-working delt on clean reps is not a cheat", () => {
  // The Nov 14 35 lb failure: delt share ~0.45 and delt peak > 0.5 on strict reps.
  const { end } = runSet(calibrated(), presets.heavyClean(6), { load_lb: 35 });
  assert.equal(end.reps.length, 6);
  assert.equal(end.cheats, 0, end.reps.map((r) => `${r.delt_share}/${r.peak_pct[1]}`).join(" "));
  assert.ok(end.reps.every((r) => r.delt_share > 0.38 && r.peak_pct[CH.R_DELT] > 0.5));
});

test("heavy load: a swing is caught by the delt level even when the share barely moves", () => {
  // strict reps then swings in the same set
  const { end } = runSet(calibrated(), [...presets.heavyClean(3), ...presets.heavySwing(3)], { load_lb: 35 });
  assert.deepEqual(end.reps.map((r) => r.cheat), [false, false, false, true, true, true]);
  const jump = end.reps[3].delt_share - end.reps[3].baseline_delt_share!;
  assert.ok(jump < 0.15, `share only up ${jump}`); // the share rule alone would miss it
  assert.equal(end.reps[3].cheat_reason, "delt_share_jump");
});

test("a swing set right after a clean set is judged against the clean set (session reference)", () => {
  const e = calibrated();
  runSet(e, presets.heavyClean(4), { set_id: "strict", load_lb: 35 });
  const swing = runSet(e, presets.heavySwing(4), { set_id: "swing", load_lb: 35 }).end;
  assert.equal(swing.cheats, 4);
  assert.ok(swing.reps[0].baseline_delt_share! > 0.38); // reference came from the strict set
  // ...but only for the same exercise + variant + load
  const e2 = calibrated();
  runSet(e2, presets.heavyClean(4), { set_id: "strict", load_lb: 35 });
  assert.equal(runSet(e2, presets.heavySwing(4), { set_id: "swing", load_lb: 25 }).end.reps[0].baseline_delt_share, null);
  // ...and only within one session
  assert.equal(runSet(e, presets.heavySwing(4), { set_id: "s2", session_id: "s2" }).end.reps[0].baseline_delt_share, null);
});

test("heavy strict reps: delt working on the way DOWN is not a cheat", () => {
  const { end } = runSet(calibrated(), presets.heavyEccentric(6), { load_lb: 35 });
  assert.equal(end.reps.length, 6);
  assert.equal(end.cheats, 0, end.reps.map((r) => `${r.delt_share}/${r.up_delt_ratio}`).join(" "));
  assert.ok(end.reps.every((r) => r.delt_share > 0.35)); // whole-rep share looks high (Nov 13 swings were 0.2-0.66)...
  assert.ok(end.reps.every((r) => r.up_delt_ratio! < 0.5)); // ...but the up phase is biceps-led
});

test("heavy swing: delt firing on the way UP is flagged by the up-phase rule", () => {
  const { end } = runSet(calibrated(), [...presets.heavyEccentric(3), ...presets.heavySwingUp(3)], { load_lb: 35 });
  assert.deepEqual(end.reps.map((r) => r.cheat), [false, false, false, true, true, true]);
  for (const r of end.reps.slice(3)) {
    assert.ok(r.up_delt_ratio! > 1.2, `up ratio ${r.up_delt_ratio}`);
    assert.ok(r.baseline_up_delt_ratio! < 0.5);
  }
});

test("milder heavy swing: whole-rep rules miss some, the up-phase rule gets all", () => {
  const mild: SynthRep = { bi: 0.85, delt: 0.75, deltDown: 0.4 }; // up ratio ~0.88 vs ~0.44 clean
  const reps = [...presets.heavyEccentric(3), mild, mild, mild];
  const wholeRepOnly = runSet(calibrated({ upRatioJump: 5, fallbackUpRatio: 99 }), reps).end;
  assert.equal(wholeRepOnly.cheats, 0, "whole-rep rules alone miss them");
  const full = runSet(calibrated(), reps).end;
  assert.deepEqual(full.reps.map((r) => r.cheat), [false, false, false, true, true, true]);
  assert.ok(full.reps.slice(3).every((r) => r.delt_share - r.baseline_delt_share! < 0.15)); // share barely moves
});

test("flagWithoutReference: a swing with delt above biceps on the way up is flagged with no reference", () => {
  const { end } = runSet(calibrated({ flagWithoutReference: true }), presets.heavySwingUp(3), { load_lb: 35 });
  assert.equal(end.cheats, 3);
  assert.equal(end.reps[0].baseline_up_delt_ratio, null);
});

test("known limit: a heavy swing from rep 1 with no clean reps yet isn't flagged", () => {
  const { end } = runSet(calibrated(), presets.heavySwing(4), { load_lb: 35 });
  assert.equal(end.cheats, 0);
});

test("back-to-back reps with no pause at the bottom all count", () => {
  // heavy continuous reps: the next rep starts rising right after the last one ends
  const reps: SynthRep[] = Array.from({ length: 6 }, () => ({ bi: 0.9, delt: 0.1, upMs: 700, holdMs: 100, downMs: 700, gapMs: 0 }));
  const { end } = runSet(calibrated(), reps);
  assert.equal(end.reps.length, 6);
});

// One cheat at rep 3 (within the plan's 1-per-set allowance, but before rep 6).
const EARLY_ONE: SynthRep[] = [...presets.clean(2), ...presets.swing(1), ...presets.clean(3)];

test("early cheats two sets in a row -> stop at first cheat, rest longer (never a load change)", () => {
  const e = calibrated();
  const early = EARLY_ONE;
  const a = runSet(e, early, { set_id: "a" }).end;
  assert.equal(a.first_cheat_rep, 3);
  assert.equal(a.cheats, 1);
  assert.equal(a.decision.next, "continue"); // first time: warning only (plan: "two sets in a row")
  assert.match(a.decision.reason, /next set/);
  const b = runSet(e, early, { set_id: "b" }).end;
  assert.equal(b.decision.next, "stop_at_first_cheat_rest_longer");
  assert.match(b.decision.reason, /before rep 6 in 2 sets in a row/);
  for (const d of [a.decision, b.decision]) assert.doesNotMatch(d.reason, /(add|drop|increase|decrease|lower|heavier|lighter)/i);

  // earlyCheatSetsInRow = 1 fires on the first such set
  const e1 = calibrated({ earlyCheatSetsInRow: 1 });
  assert.equal(runSet(e1, early).end.decision.next, "stop_at_first_cheat_rest_longer");
});

test("a clean set resets the early-cheat streak", () => {
  const e = calibrated();
  const early = EARLY_ONE;
  runSet(e, early, { set_id: "a" });
  runSet(e, presets.clean(5), { set_id: "b" });
  assert.equal(runSet(e, early, { set_id: "c" }).end.decision.next, "continue");
});

const NO_LOAD_TALK = /(add|drop|increase|decrease|lower|heavier|lighter|weight up|weight down)/i;

test("more cheat reps than the plan allows -> stop at first cheat, rest longer", () => {
  // 2 late cheats (reps 7, 8): no early-cheat streak, but over the 1-per-set limit
  const reps: SynthRep[] = [...presets.clean(6), ...presets.swing(2)];
  const { end } = runSet(calibrated(), reps);
  assert.equal(end.cheats, 2);
  assert.equal(end.first_cheat_rep, 7);
  assert.equal(end.decision.next, "stop_at_first_cheat_rest_longer");
  assert.equal(
    end.decision.reason,
    "2 cheat reps (first at rep 7); the plan allows 1 cheat rep. Next set, stop at the first cheat and rest longer. Same weight.",
  );
  assert.doesNotMatch(end.decision.reason, NO_LOAD_TALK);
});

test("exactly the allowed number of late cheats -> continue", () => {
  const reps: SynthRep[] = [...presets.clean(6), ...presets.swing(1)];
  const { end } = runSet(calibrated(), reps);
  assert.equal(end.cheats, 1);
  assert.equal(end.decision.next, "continue");
  assert.match(end.decision.reason, /6 clean, 1 cheat \(first at rep 7\)/);
});

test("maxCheatRepsPerSet comes from config", () => {
  const reps: SynthRep[] = [...presets.clean(6), ...presets.swing(2)];
  const { end } = runSet(calibrated({ maxCheatRepsPerSet: 2 }), reps);
  assert.equal(end.decision.next, "continue");
  const swing3 = runSet(calibrated({ maxCheatRepsPerSet: 2 }), [...presets.clean(6), ...presets.swing(3)]).end;
  assert.equal(swing3.decision.next, "stop_at_first_cheat_rest_longer");
  assert.match(swing3.decision.reason, /the plan allows 2 cheat reps\./);
});

test("max-cheats rule beats the tempo rule", () => {
  // all reps very fast, and 2 of them swing
  const fast = presets.fast(6);
  const reps: SynthRep[] = [...fast.slice(0, 4), ...fast.slice(4).map((r) => ({ ...r, bi: 0.55, delt: 0.6 }))];
  const { end } = runSet(calibrated(), reps);
  assert.equal(end.cheats, 2);
  assert.ok(end.reps.filter((r) => r.up_ms < DEFAULT_CONFIG.fastUpMs).length > 3);
  assert.equal(end.decision.next, "stop_at_first_cheat_rest_longer");
  assert.match(end.decision.reason, /2 cheat reps/);
});

test("max-cheats rule beats the early-cheat streak, and the streak still counts", () => {
  const e = calibrated();
  const a = runSet(e, [...presets.clean(2), ...presets.swing(3)], { set_id: "a" }).end; // 3 early cheats
  assert.equal(a.decision.next, "stop_at_first_cheat_rest_longer");
  assert.match(a.decision.reason, /^3 cheat reps \(first at rep 3\); the plan allows 1 cheat rep\./);
  // next set has only 1 early cheat: the 2-in-a-row streak fires
  const b = runSet(e, EARLY_ONE, { set_id: "b" }).end;
  assert.equal(b.decision.next, "stop_at_first_cheat_rest_longer");
  assert.match(b.decision.reason, /2 sets in a row/);
});

test("very fast up phase on most reps -> slow_the_tempo", () => {
  const { end } = runSet(calibrated(), presets.fast(6));
  assert.equal(end.reps.length, 6);
  assert.ok(end.reps.every((r) => r.up_ms < DEFAULT_CONFIG.fastUpMs), end.reps.map((r) => r.up_ms).join(","));
  assert.equal(end.decision.next, "slow_the_tempo");
});

test("slow envelope decay after a hard rep is one rep, not two", () => {
  const reps: SynthRep[] = Array.from({ length: 4 }, () => ({ bi: 1.2, delt: 0.1, tailMs: 1800, tailLevel: 0.32, gapMs: 600 }));
  const { end } = runSet(calibrated(), reps, {}, { noise: 60 });
  assert.equal(end.reps.length, 4);
  assert.equal(end.cheats, 0);
});

test("min rep duration and min gap reject blips", () => {
  const reps: SynthRep[] = [
    { bi: 0.8, upMs: 100, holdMs: 0, downMs: 150, gapMs: 1000 }, // 250 ms twitch: not a rep
    { bi: 0.8, gapMs: 150 },
    { bi: 0.6, upMs: 120, holdMs: 0, downMs: 120, gapMs: 1000 }, // re-bounce 150 ms after a rep: ignored
    { bi: 0.8 },
  ];
  const { end } = runSet(calibrated(), reps);
  assert.equal(end.reps.length, 2);
});

test("dead channel: calibration names it, reps still count, never a fake cheat", () => {
  const e = new Engine();
  const rest = hold(REST, 3000, { dead: [CH.R_DELT] });
  const mvc = hold([14000, 9000, 13000, 8000], 3000, { dead: [CH.R_DELT] });
  const cal = e.calibrate(rest, mvc);
  assert.equal(cal.ok, false);
  assert.equal(cal.problems.length, 1);
  assert.match(cal.problems[0], /R front delt \(A1\)/);

  const { end } = runSet(e, presets.clean(5), {}, { dead: [CH.R_DELT] });
  assert.equal(end.reps.length, 5);
  assert.equal(end.cheats, 0);
  for (const r of end.reps) assert.ok(r.mean_pct[CH.R_DELT] < 0.01);
});

test("calibration: good channels pass, RAW-mode channel and one-arm walk-ups", () => {
  const e = new Engine();
  const ok = e.calibrate(hold(REST, 3000), hold([14000, 9000, 13000, 8000], 3000));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.problems, []);
  assert.ok(Math.abs(ok.rest[0] - 570) < 40);
  assert.ok(Math.abs(ok.mvc[1] - 9000) < 60);

  const raw = e.calibrate(hold([570, 495, 8150, 520], 3000), hold([14000, 9000, 8200, 8000], 3000));
  assert.equal(raw.ok, false);
  assert.match(raw.problems.join("\n"), /L biceps \(A2\).*RAW/);

  // walk-up with only the right arm wired: left jacks are empty but that's fine
  const walkUp = e.calibrate(hold([570, 495, 0, 0], 3000, { dead: [2, 3] }), hold([14000, 9000, 0, 0], 3000, { dead: [2, 3] }), ["R"]);
  assert.equal(walkUp.ok, true);
});

test("calibration rescales %MVC", () => {
  const e = new Engine();
  e.calibrate(hold(REST, 3000, { noise: 0 }), hold([7570, 7495, 7560, 7520], 3000, { noise: 0 }));
  const [live] = e.ingest({ device: "d", seq: 0, t0_ms: 0, dt_ms: 5, ch: [[4070], [9000], [560], [99999]] });
  assert.equal(live.type, "live");
  const pct = (live as { pct: number[] }).pct;
  assert.equal(pct[0], 0.5);
  assert.equal(pct[1], 1.215);
  assert.equal(pct[2], 0);
  assert.equal(pct[3], 1.5); // clamped
});

test("works before calibration (defaults rest 550, mvc 14960)", () => {
  const e = new Engine();
  const { end } = runSet(e, presets.clean(4));
  assert.equal(end.reps.length, 4);
  const [live] = e.ingest({ device: "d", seq: 999, t0_ms: 10_000_000, dt_ms: 5, ch: [[7755], [550], [550], [550]] });
  assert.equal((live as { pct: number[] }).pct[0], 0.5);
});

test("live frames at ~20 Hz from 200 Hz input, in order", () => {
  const e = calibrated();
  const s = synth(presets.clean(1), { leadMs: 1000, tailMs: 1000 });
  const live = toBatches(s.ch, s.hz).flatMap((b) => e.ingest(b)).filter((x) => x.type === "live");
  const seconds = s.ch[0].length / s.hz;
  assert.ok(Math.abs(live.length / seconds - 20) < 1.5, `${live.length} frames in ${seconds}s`);
  for (let i = 1; i < live.length; i++) assert.ok(live[i].t_ms > live[i - 1].t_ms);
  assert.equal((live[0] as { pct: number[] }).pct.length, 4);
});

test("no set started: live frames only, no reps", () => {
  const e = calibrated();
  const s = synth(presets.clean(3));
  const ev = toBatches(s.ch, s.hz).flatMap((b) => e.ingest(b));
  assert.ok(ev.length > 0);
  assert.ok(ev.every((x) => x.type === "live"));
  assert.equal(e.endSet(), null);
});

test("auto set_end after ~10 s without a rep", () => {
  const e = calibrated();
  const s = synth(presets.clean(3), { tailMs: 11_000 });
  e.startSet(CTX);
  const ev = toBatches(s.ch, s.hz).flatMap((b) => e.ingest(b));
  const ends = ev.filter((x): x is SetEndEvent => x.type === "set_end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reps.length, 3);
  assert.equal(ends[0].set_id, "set-1");
  const lastRep = ends[0].reps[2];
  const endIdx = ev.indexOf(ends[0]);
  const endT = (ev.slice(0, endIdx).reverse().find((x) => x.type === "live") as { t_ms: number }).t_ms;
  assert.ok(endT - lastRep.end_ms >= 9_900 && endT - lastRep.end_ms <= 10_100);
  assert.equal(e.endSet(), null); // already ended
});

test("duplicate and overlapping batches don't double-count", () => {
  const e = calibrated();
  const s = synth(presets.clean(4));
  e.startSet(CTX);
  const batches = toBatches(s.ch, s.hz);
  let reps = 0;
  for (const b of batches) {
    reps += e.ingest(b).filter((x) => x.type === "rep").length;
    reps += e.ingest(b).filter((x) => x.type === "rep").length; // resend
  }
  assert.equal(reps, 4);
});

test("device restart (millis jumps back) keeps working", () => {
  const e = calibrated();
  e.startSet(CTX);
  const a = synth(presets.clean(2), { seed: 3 });
  const b = synth(presets.clean(2), { seed: 4 });
  let reps = 0;
  for (const x of toBatches(a.ch, a.hz, { t0_ms: 500_000 })) reps += e.ingest(x).filter((y) => y.type === "rep").length;
  for (const x of toBatches(b.ch, b.hz, { t0_ms: 0 })) reps += e.ingest(x).filter((y) => y.type === "rep").length;
  assert.equal(reps, 4);
});

test("bilateral curls: one rep per curl, r_share shows the weaker side", () => {
  const reps: SynthRep[] = Array.from({ length: 5 }, () => ({ arm: "both" as const, bi: 0.8, lBi: 0.5 }));
  const { end } = runSet(calibrated(), reps, { arms: ["R", "L"] });
  assert.equal(end.reps.length, 5);
  for (const r of end.reps) {
    assert.ok(r.r_share! > 0.58 && r.r_share! < 0.65, `r_share ${r.r_share}`);
  }
});

test("left arm only uses the left channels", () => {
  const reps: SynthRep[] = [...presets.clean(3).map((r) => ({ ...r, arm: "L" as const })), { arm: "L", bi: 0.5, delt: 0.6 }];
  const { end } = runSet(calibrated(), reps, { arms: ["L"] });
  assert.equal(end.reps.length, 4);
  assert.ok(end.reps.every((r) => r.arm === "L"));
  assert.equal(end.first_cheat_rep, 4);
  // right-arm-only set sees nothing
  assert.equal(runSet(calibrated(), reps, { arms: ["R"] }).end.reps.length, 0);
});

test("per-variant threshold overrides", () => {
  const reps: SynthRep[] = [...presets.clean(3), { bi: 1.0, delt: 0.45 }];
  const peakOnly = { deltShareJump: 0.5, deltMeanJump: 5, upRatioJump: 5 };
  assert.equal(runSet(calibrated(peakOnly), reps).end.cheats, 0);
  const strictPreacher = calibrated({ ...peakOnly, variantOverrides: { preacher: { deltPeakMax: 0.4, deltPeakJump: 0.3 } } });
  assert.equal(runSet(strictPreacher, reps, { variant: "preacher" }).end.cheats, 1);
  assert.equal(runSet(strictPreacher, reps, { variant: "standing" }).end.cheats, 0);
});

test("endSet keeps a long-enough rep still in progress", () => {
  const e = calibrated();
  const s = synth([{ bi: 0.8, upMs: 600, holdMs: 3000 }], { tailMs: 0 });
  e.startSet(CTX);
  const n = Math.round(((1000 + 600 + 800) * s.hz) / 1000); // stop mid-hold (before it counts as a hold)
  for (const b of toBatches(s.ch.map((c) => c.slice(0, n)), s.hz)) e.ingest(b);
  const end = e.endSet()!;
  assert.equal(end.reps.length, 1);
});

test("mvcFromWindows pools windows per channel; raiseMvc only raises, is pure, re-checks problems", async () => {
  const { mvcFromWindows, raiseMvc } = await import("../src/engine/index.js");
  const flex = hold([9000, 14000, 13000, 9000], 3000, { noise: 0 });
  const set = hold([14500, 9000, 600, 600], 3000, { noise: 0 });
  const pooled = mvcFromWindows([flex, set]);
  assert.deepEqual(pooled, [14500, 14000, 13000, 9000]);
  assert.ok(Number.isNaN(mvcFromWindows([])[0]));

  const cal = { rest: [570, 495, 560, 520], mvc: [9000, 14000, 1200, 9000], ok: false, problems: ["L biceps (A2): flex only reached 1200 vs rest 560 (needs +1000). Check the pads."] };
  const frozen = JSON.stringify(cal);
  const raised = raiseMvc(cal, [set, hold([600, 600, 5000, 600], 1000, { noise: 0 })]);
  assert.equal(JSON.stringify(cal), frozen, "input untouched");
  assert.deepEqual(raised.mvc, [14500, 14000, 5000, 9000]); // R bi + L bi up, delts kept (never lowered)
  assert.deepEqual(raised.rest, cal.rest);
  assert.deepEqual(raised.problems, []);
  assert.equal(raised.ok, true);
});

test("raising the MVC between sets rescales the learned reference (no false cheats after)", () => {
  // Set 1 with a low biceps MVC (FLEX hold undershoots), then MVC raised, then the same reps again.
  const e = new Engine();
  e.setCalibration({ rest: REST, mvc: [9000, 14960, 14960, 14960], ok: true, problems: [] });
  const a = runSet(e, presets.heavyEccentric(4), { set_id: "a", load_lb: 35 }, { seed: 11 }).end;
  assert.equal(a.cheats, 0);
  const s = synth(presets.heavyEccentric(4), { rest: REST, seed: 11 });
  const cal = e.raiseMvc([s.ch]);
  assert.ok(cal.mvc[0] > 11000, `R biceps MVC raised to ${cal.mvc[0]}`);
  const b = runSet(e, [...presets.heavyEccentric(2), ...presets.heavySwingUp(2)], { set_id: "b", load_lb: 35 }, { seed: 12 }).end;
  assert.deepEqual(b.reps.map((r) => r.cheat), [false, false, true, true]);
  // the carried-over reference matches what this calibration measures for clean reps
  const ref = b.reps[0].baseline_up_delt_ratio!;
  const clean = b.reps[0].up_delt_ratio!;
  assert.ok(Math.abs(ref - clean) / clean < 0.25, `ref ${ref} vs clean ${clean}`);
});

test("no reference yet: a high delt peak alone is never a cheat (only the strong rules apply)", () => {
  // rep 1: big delt peak (0.95) but biceps-led on the way up and share < 0.6
  const { end } = runSet(calibrated(), [{ bi: 1.2, delt: 0.95 }, ...presets.clean(2)]);
  assert.equal(end.reps[0].baseline_delt_share, null);
  assert.ok(end.reps[0].peak_pct[1] > 0.9);
  assert.equal(end.reps[0].cheat, false);
});

test("a too-low biceps MVC doesn't merge reps (detection isn't clamped at 1.5)", () => {
  // true peak 0.9 with the MVC set at a third of the real one: %MVC ~2.7, valleys ~0.45
  const reps: SynthRep[] = Array.from({ length: 6 }, () => ({ bi: 0.9, delt: 0.1, upMs: 700, holdMs: 200, downMs: 700, gapMs: 0, tailMs: 300, tailLevel: 0.15 }));
  const s = synth(reps, { rest: REST });
  const e = new Engine({ autoRaiseMvc: false });
  e.setCalibration({ rest: REST, mvc: [5270, 14960, 14960, 14960], ok: true, problems: [] });
  e.startSet(CTX);
  for (const b of toBatches(s.ch, s.hz)) e.ingest(b);
  const end = e.endSet()!;
  assert.equal(end.reps.length, 6);
  assert.ok(end.reps.every((r) => r.peak_pct[0] === 1.5), "reported values still clamped");
});

test("autoRaiseMvc: set_end raises the MVC from the set itself (raise-only), off when disabled", () => {
  const e = new Engine();
  e.setCalibration({ rest: REST, mvc: [6000, 14960, 14960, 14960], ok: true, problems: [] });
  const { end } = runSet(e, presets.clean(4), {}, { mvc: [14960, 14960, 14960, 14960] });
  assert.ok(end.calibration && end.calibration.mvc[0] > 10_000, `raised to ${end.calibration?.mvc[0]}`);
  assert.equal(end.calibration!.mvc[1], 14960);
  assert.deepEqual(e.getCalibration()!.mvc, end.calibration!.mvc);
  const off = new Engine({ autoRaiseMvc: false });
  off.setCalibration({ rest: REST, mvc: [6000, 14960, 14960, 14960], ok: true, problems: [] });
  assert.equal(runSet(off, presets.clean(4)).end.calibration, undefined);
  assert.equal(off.getCalibration()!.mvc[0], 6000);
});
