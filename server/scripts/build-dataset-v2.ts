// Build the Lightweight dataset v2: real reps (from export-dataset.ts, current engine) + a synthetic expansion
// fitted to the real reps' statistics, every rep judged by the REAL engine, coach lines written by code.
//
//   cd server
//   npx tsx scripts/export-dataset.ts --db <copy of data/lightweight.sqlite> --no-synthetic --out <real dir>
//   npx tsx scripts/build-dataset-v2.ts --real <real dir> [--out ../data/dataset/v2] [--sessions 260] [--seed 2026]
//
// Rules kept: CODE DECIDES, THE MODEL ONLY PHRASES (verdicts come from the engine; targets from code).
// Wording: shoulder relative to the lifter's own clean reps, never a raw delt share, never "snitch",
// rep cues <= 20 words. Validation and test splits are REAL reps only, split by recording.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine, type Batch, type Calibration, type RepEvent, type SetContext, type SetEndEvent, type Variant } from "../src/engine/index.js";
import { synth, toBatches, hold, type SynthRep } from "../src/engine/fixtures.js";
import { repFacts, setFacts, fallbackSummary, mentionsRawShare, mentionsLoadChange, mentionsMedical, decisionLine, CUE_CONFIG } from "../src/coach/index.js";
import { DEFAULT_CONFIG } from "../src/engine/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const REAL = arg("--real");
if (!REAL) throw new Error("--real <dir with reps.jsonl, windows.jsonl, sets.jsonl from export-dataset.ts>");
const OUT = path.resolve(arg("--out", path.join(HERE, "../../data/dataset/v2"))!);
const N_SESSIONS = Number(arg("--sessions", "110"));
const SEED = Number(arg("--seed", "2026"));
const GENERATOR_VERSION = "lw-synth-v2.0";
const ENGINE_CONFIG = { autoEndMs: 8_000, mvcPercentile: 0.99 }; // = server src/pipeline.ts
const WINDOW_LEN = 128;
const DELT_CAL = 0.62;

// ------------------------------------------------------------------------------------------ rng
function rngOf(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
  return {
    u: (lo = 0, hi = 1) => lo + (hi - lo) * next(),
    n: (mu: number, sd: number) => mu + sd * normal(),
    int: (lo: number, hi: number) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof rngOf>;
const clip = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ------------------------------------------------------------------------------------------ real data
interface RepRow { id: string; recording_id: string; source: string; set_index: number; rep: number; arm: "R" | "L"; label_instructed: string | null; engine_flag: boolean; loose?: boolean; load_lb: number | null; arms_on: string[]; duration_ms: number; up_ms: number; peak_pct: number[]; mean_pct: number[]; up_delt_ratio: number | null; [k: string]: unknown }
interface SetRow { id: string; recording_id: string; source: string; person: string; session_id: string; exercise: string; variant: Variant; load_lb: number | null; load_desc: string; arms_on: ("R" | "L")[]; set_index: number; labels: (string | null)[]; set_end: SetEndEvent }
const readJsonl = <T,>(f: string) => readFileSync(path.join(REAL, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
const realReps = readJsonl<RepRow>("reps.jsonl");
const realWins = readJsonl<{ id: string; [k: string]: unknown }>("windows.jsonl");
const realSets = readJsonl<SetRow>("sets.jsonl");

// Splits by recording (no recording appears in two splits). Test/validation: real, human- or phase-labelled.
const SPLIT_OF: Record<string, "train" | "validation" | "test"> = {
  "live:s-1114-122526-r82": "test", // Mike's per-rep labels: 7 strict, 2 swing, 1 loose
  "live:s-1114-140601-kau": "test", // Mike: all 9 clean (pinned R delt, fatiguing L delt)
  "2026-11-14-right-35lb-strict-vs-swing": "test", // 5 strict, 3 swing (phase instruction)
  "2026-11-14-fulltest-35lb-bilateral": "validation", // 7 strict, 6 swing
  "live:s-1114-123449-zdw": "validation", // 3 strict (human) + handling
  "2026-11-13-bench": "train", // band, 3 strict, 4 swing
  "live:s-1114-120548-fpi": "train", // unlabelled
  "live:s-1114-134519-i7p": "train", // unlabelled
};
const splitOf = (recording: string, source: string) => (source === "synthetic" ? "train" : SPLIT_OF[recording] ?? "train");

// Fitted statistics (printed into fit_stats.json): per condition and label, from the labelled real reps.
type Cond = "band_1arm" | "35lb_1arm" | "35lb_bilateral";
const condOf = (r: { load_lb: number | null; arms_on: string[] }): Cond => (r.load_lb == null ? "band_1arm" : r.arms_on.length > 1 ? "35lb_bilateral" : "35lb_1arm");
function stats(xs: number[]) {
  if (!xs.length) return null;
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, xs.length - 1));
  return { n: xs.length, mean: r3(mu), sd: r3(sd), min: r3(Math.min(...xs)), max: r3(Math.max(...xs)) };
}
const FIT: Record<string, unknown> = {};
for (const c of ["band_1arm", "35lb_1arm", "35lb_bilateral"] as Cond[]) {
  for (const lab of ["strict", "swing"]) {
    const rs = realReps.filter((r) => r.source === "real" && condOf(r) === c && r.label_instructed === lab);
    const bi = (r: RepRow) => r.peak_pct[r.arm === "L" ? 2 : 0];
    const de = (r: RepRow) => r.peak_pct[r.arm === "L" ? 3 : 1];
    FIT[`${c}/${lab}`] = {
      duration_s: stats(rs.map((r) => r.duration_ms / 1000)), up_s: stats(rs.map((r) => r.up_ms / 1000)),
      biceps_peak: stats(rs.map(bi)), biceps_saturated_share: rs.length ? r3(rs.filter((r) => bi(r) >= 0.95).length / rs.length) : null,
      up_delt_ratio: stats(rs.map((r) => r.up_delt_ratio ?? 0)), delt_peak: stats(rs.map(de)),
    };
  }
}

// ------------------------------------------------------------------------------------------ generator
// Session = one lifter with one pad placement; sets of 5-12 reps. Parameters drawn to match FIT (see card).
interface GenRep { rep: SynthRep; intent: "strict" | "swing" | "loose"; tag: string }
interface GenSet { kind: string; reps: GenRep[] }
interface GenSession { id: string; cond: Cond; person: string; walkup: boolean; sets: GenSet[]; fault: null | "dead_delt" | "raw_delt"; padK: number; high: boolean }

function genSession(i: number, rng: Rng): GenSession {
  const cond: Cond = rng.chance(0.2) ? "band_1arm" : rng.chance(0.4) ? "35lb_1arm" : "35lb_bilateral";
  const walkup = rng.chance(0.2);
  const high = cond !== "band_1arm" && rng.chance(0.12); // pad forward: delt pinned at the ceiling on clean reps
  // pad sensitivity = strict up-phase delt/biceps (band ~0.08, 35 lb 0.2-1.4 across sessions in the real data)
  const padK = cond === "band_1arm" ? clip(rng.n(0.08, 0.03), 0.03, 0.2) : high ? rng.u(1.15, 1.5) : clip(Math.exp(rng.n(Math.log(0.6), 0.45)), 0.15, 1.1);
  const fault = !high && rng.chance(0.06) ? rng.pick(["dead_delt", "raw_delt"] as const) : null;
  const nSets = walkup ? 1 : rng.int(2, 4);
  const sets: GenSet[] = [];
  const kinds = ["all_strict", "swing_end", "abrupt_mid", "fatigue", "rushed", ...(cond === "35lb_bilateral" ? ["imbalance"] : [])];
  for (let k = 0; k < nSets; k++) {
    // first set mostly clean; the last set of a longer workout leans to fatigue
    const kind = k === 0 && rng.chance(0.5) ? "all_strict" : k === nSets - 1 && nSets >= 3 && rng.chance(0.5) ? "fatigue" : rng.pick(kinds);
    sets.push(genSet(kind, cond, padK, high, rng, k / Math.max(1, nSets - 1)));
  }
  return { id: `syn2-${String(i).padStart(4, "0")}`, cond, person: walkup ? `walkup-syn-${i}` : "synthetic", walkup, sets, fault, padK, high };
}

function genSet(kind: string, cond: Cond, padK: number, high: boolean, rng: Rng, workoutPos: number): GenSet {
  const n = rng.int(5, 12);
  const band = cond === "band_1arm";
  const both = cond === "35lb_bilateral";
  const lBiBase = kind === "imbalance" ? rng.u(0.45, 0.65) : clip(rng.n(1, 0.07), 0.85, 1.15);
  const swingAt = new Set<number>();
  if (kind === "swing_end") for (let j = 0; j < rng.int(1, 3); j++) swingAt.add(n - 1 - j);
  if (kind === "abrupt_mid") { swingAt.add(rng.int(3, n - 2)); if (rng.chance(0.4)) swingAt.add(rng.int(3, n - 1)); }
  const reps: GenRep[] = [];
  for (let i = 0; i < n; i++) {
    // biceps: heavy curls often saturate the ENV (real: 60-100% of reps at the ceiling); later sets slightly lower
    const bi = band ? clip(rng.n(1.15, 0.15), 0.8, 1.5) : clip(rng.n(1.12 - 0.08 * workoutPos, 0.2), 0.7, 1.5);
    const tot = band ? clip(rng.n(1.75, 0.2), 1.1, 2.4) : clip(rng.n(2.4, 0.45), 1.4, 3.3); // shape length s (engine window ~0.75x)
    const upFrac = band ? clip(rng.n(0.45, 0.06), 0.3, 0.6) : clip(rng.n(0.46, 0.06), 0.3, 0.6);
    let upMs = tot * 1000 * upFrac;
    const holdMs = rng.u(80, band ? 300 : 500);
    let downMs = Math.max(250, tot * 1000 - upMs - holdMs);
    let ratio = clip(rng.n(padK, padK * 0.18), 0.02, 1.6);
    let intent: GenRep["intent"] = "strict";
    let tag = "strict";
    if (kind === "fatigue") {
      // gradual drift: up ratio rises ~3-6% per rep; the last rep sometimes becomes a real swing
      ratio *= 1 + rng.u(0.02, 0.04) * i;
      tag = "fatigue_drift";
      if (i > n * 0.4) { intent = "loose"; }
      if (i === n - 1 && rng.chance(0.35)) swingAt.add(i);
    }
    if (kind === "rushed") { upMs = rng.u(200, 320); downMs = rng.u(350, 650); tag = "rushed"; }
    if (swingAt.has(i)) {
      // swing: delt fires on the way up (real: 1.3-3x the clean reps under load, much more on a quiet band delt)
      const target = band ? clip(rng.n(1.0, 0.35), 0.4, 1.9) : ratio * rng.u(1.7, high ? 3 : 3.5);
      ratio = high ? Math.max(target, padK * 1.9) : target;
      // swings are quicker: real swing reps last ~0.6x a strict rep (fit_stats.json)
      upMs *= rng.u(0.55, 0.8);
      downMs *= rng.u(0.45, 0.65);
      intent = "swing";
      tag = "swing";
    }
    // DELT_CAL: the engine measures the up phase on a biceps clamped at the ENV ceiling, which reads the
    // drawn ratio ~1.6x high; scaled so synthetic strict up ratios match the real ones (fit_stats.json).
    const deltUp = DELT_CAL * ratio * Math.min(bi, 1);
    // strict heavy reps: the delt works harder on the way down (stabilizing); swings: less on the way down
    const deltDown = intent === "swing" ? deltUp * rng.u(0.4, 0.8) : band ? deltUp * rng.u(0.9, 1.2) : deltUp * rng.u(1.1, 1.9);
    reps.push({
      rep: { arm: both ? "both" : "R", bi, lBi: both ? bi * lBiBase : undefined, delt: deltUp, lDelt: both ? deltUp * lBiBase * clip(rng.n(1, 0.1), 0.75, 1.25) : undefined, deltDown, upMs, holdMs, downMs, gapMs: rng.u(600, 2200) },
      intent, tag,
    });
  }
  return { kind, reps };
}

// ------------------------------------------------------------------------------------------ run through the engine
interface Sample { t: number; pct: number[] }
interface RunSet { meta: SetRow; samples: Sample[]; intents: (GenRep | null)[]; context: string; kind: string }

function runSession(g: GenSession, seed: number): { sets: RunSet[]; calibration: Calibration; problems: string[] } {
  const rest = [570, 495, 560, 520].map((r) => r + Math.round((seed % 7) * 5));
  const mvc = [14960, 14960, 14960, 14960];
  const arms: ("R" | "L")[] = g.cond === "35lb_bilateral" ? ["R", "L"] : ["R"];
  const dead = g.fault === "dead_delt" ? [1] : [];
  // Calibration as the server does it: 3 s rest + a flex per muscle (RAW channel sits near half scale).
  const restWin = hold(rest.map((r, c) => (g.fault === "raw_delt" && c === 1 ? 8150 : r)), 3000, { seed, dead, noise: g.fault === "raw_delt" ? 600 : 40 });
  const mvcWin = hold([14500, 9000, 14000, 8000].map((v, c) => (g.fault === "raw_delt" && c === 1 ? 8200 : v)), 3000, { seed: seed + 1, dead });
  const e = new Engine(ENGINE_CONFIG);
  const cal = e.calibrate(restWin, mvcWin, arms);
  const sets: RunSet[] = [];
  let t0 = 1_000_000 + seed * 10;
  const pct = (raw: number, c: number) => clip((raw - (cal.rest[c] ?? 550)) / ((cal.mvc[c] ?? 14960) - (cal.rest[c] ?? 550)), 0, DEFAULT_CONFIG.pctMax);
  g.sets.forEach((gs, k) => {
    const s = synth(gs.reps.map((x) => x.rep), { hz: 200, rest, mvc, seed: seed * 31 + k, dead, noise: 30 });
    if (g.fault === "raw_delt") s.ch[1] = s.ch[1].map((_, i) => Math.round(8150 + 900 * Math.sin(i * 0.9) + ((i * 7919) % 400) - 200));
    const variant: Variant = "standing";
    const exercise = g.cond === "band_1arm" ? "standing band curl" : "dumbbell curl";
    const load_lb = g.cond === "band_1arm" ? null : 35;
    const ctx: SetContext = { session_id: g.id, set_id: `${g.id}/set${k + 1}`, person: g.person, exercise, variant, load_lb: load_lb ?? undefined, arms };
    e.startSet(ctx);
    const samples: Sample[] = [];
    let ended: SetEndEvent | null = null;
    for (const b of toBatches(s.ch, s.hz, { t0_ms: t0, device: g.id })) {
      for (let i = 0; i < b.ch[0].length; i++) samples.push({ t: b.t0_ms + i * b.dt_ms, pct: [0, 1, 2, 3].map((c) => pct(b.ch[c][i], c)) });
      for (const ev of e.ingest(b as Batch)) if (ev.type === "set_end") ended = ev;
    }
    const set = ended ?? e.endSet()!;
    // generator intent per detected rep = the generator rep it overlaps most
    const intents = set.reps.map((r) => {
      let best = -1, ov = 0;
      s.reps.forEach((w, i) => {
        const o = Math.min(r.end_ms, t0 + w.end) - Math.max(r.start_ms, t0 + w.start);
        if (o > ov) { ov = o; best = i; }
      });
      return best >= 0 ? gs.reps[best] : null;
    });
    const context = g.walkup ? "walk_up_no_history" : k === 0 ? "first_set" : gs.kind === "fatigue" && k === g.sets.length - 1 ? "late_fatigue" : "mid_workout";
    sets.push({
      meta: {
        id: ctx.set_id, recording_id: g.id, source: "synthetic", person: g.person, session_id: g.id, exercise, variant, load_lb, load_desc: load_lb ? `35 lb dumbbell${arms.length > 1 ? "s" : ""}` : "resistance band",
        arms_on: arms, set_index: k + 1, labels: intents.map((x) => x?.intent ?? null), set_end: set,
      },
      samples, intents, context, kind: gs.kind,
    });
    t0 = samples[samples.length - 1].t + 20_000; // rest between sets (> autoEnd)
  });
  return { sets, calibration: cal, problems: cal.problems };
}

function window128(samples: Sample[], start: number, end: number): number[][] | null {
  const w = samples.filter((s) => s.t >= start && s.t <= end);
  if (w.length < 2 || end <= start) return null;
  const out: number[][] = [[], [], [], []];
  let j = 0;
  for (let k = 0; k < WINDOW_LEN; k++) {
    const t = start + ((end - start) * k) / (WINDOW_LEN - 1);
    while (j < w.length - 2 && w[j + 1].t < t) j++;
    const a = w[j], b = w[j + 1];
    const u = b.t === a.t ? 0 : clip((t - a.t) / (b.t - a.t), 0, 1);
    for (let c = 0; c < 4; c++) out[c].push(r3(a.pct[c] + (b.pct[c] - a.pct[c]) * u));
  }
  return out;
}

// ------------------------------------------------------------------------------------------ coach lines (code)
const NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const word = (n: number) => (n >= 0 && n <= 20 ? NUM[n] : String(n));
const side = (a: "R" | "L") => (a === "R" ? "right" : "left");
const xt = (x: number) => (x >= 10 ? String(Math.round(x)) : (Math.round(x * 10) / 10).toString());

/** Verdict category for a rep, decided by code (engine flags + coach facts). */
function repCategory(r: RepEvent, variant: Variant) {
  const f = repFacts(r, variant);
  const both = (r.peak_pct?.[0] ?? 0) >= DEFAULT_CONFIG.hi && (r.peak_pct?.[2] ?? 0) >= DEFAULT_CONFIG.hi;
  const imb = r.r_share != null && both ? (r.r_share > CUE_CONFIG.rShareHigh ? "left" : r.r_share < CUE_CONFIG.rShareLow ? "right" : null) : null;
  if (r.cheat) return { cat: f.up_delt_x_clean == null ? "cheat_nox" : f.label === "big_swing" ? "cheat_big" : "cheat_x", f, imb };
  if (r.loose) return { cat: "loose", f, imb };
  if (imb) return { cat: imb === "left" ? "slack_left" : "slack_right", f, imb };
  if (f.fast_up) return { cat: "fast", f, imb };
  if (f.up_delt_x_clean == null) return { cat: "learning", f, imb };
  if (f.label === "near_miss") return { cat: "near_miss", f, imb };
  return { cat: "clean", f, imb };
}

// Template bank: {N} rep number, {S} side, {X} multiple. Every template <= 20 words, no raw share.
const BANK: Record<string, string[]> = {
  cheat_big: [
    "Rep {N}: cheat. Your {S} shoulder did {X} times its normal share on the way up, that's a swing.",
    "Rep {N}, that's a swing. {X} times your normal shoulder on the way up.",
    "Cheat on rep {N}. Your {S} shoulder threw it up, {X} times your clean reps.",
    "Rep {N}: you swung it. {S} shoulder at {X} times your normal.",
  ],
  cheat_x: [
    "Rep {N}: cheat. Your {S} shoulder did {X} times its normal share on the way up.",
    "Rep {N}, shoulder took over. {X} times your clean reps.",
    "Cheat, rep {N}. Your {S} shoulder jumped to {X} times normal.",
    "Rep {N}: too much {S} shoulder, {X} times your clean reps. Cheat.",
  ],
  cheat_nox: [
    "Rep {N}: cheat. Your {S} shoulder took over.",
    "Rep {N}, shoulder took over. Cheat rep.",
    "Cheat on rep {N}. That was your {S} shoulder lifting.",
  ],
  loose: [
    "Rep {N}. A bit loose, your {S} shoulder is creeping up. Tighten it.",
    "Rep {N}: getting loose. Keep the shoulder out of it.",
    "Rep {N}, loose but not a cheat. Elbows pinned.",
    "Rep {N}. Shoulder's sneaking in as you tire. Stay strict.",
  ],
  slack_left: ["Rep {N}. Left side's slacking.", "Rep {N}: left arm is doing less. Even it out.", "Rep {N}, left biceps lagging. Match the right."],
  slack_right: ["Rep {N}. Right side's slacking.", "Rep {N}: right arm is doing less. Even it out.", "Rep {N}, right biceps lagging. Match the left."],
  fast: ["Rep {N}. Clean, but slow it down.", "Rep {N}: clean. Two seconds up, no bounce.", "Rep {N}, good rep, too fast though. Control it."],
  learning: ["Rep {N}. Clean.", "Rep {N}. Still learning your clean rep, keep it strict.", "Rep {N}, looks good. Learning your groove."],
  near_miss: ["Rep {N}. Clean, but your shoulder is creeping up.", "Rep {N}: clean, just. Keep the shoulder quiet.", "Rep {N}, clean. Shoulder's close to the line."],
  clean: ["Rep {N}. Clean.", "Rep {N}, clean rep.", "Rep {N}: strict. Nice.", "Rep {N}. Clean, shoulder stayed quiet.", "Rep {N}, that's the groove."],
};
const fill = (t: string, r: RepEvent, x: number | null) =>
  t.replace("{N}", word(r.rep)).replace("{S}", side(r.arm)).replace("{X}", x == null ? "" : xt(x)).replace(/^./, (c) => c.toUpperCase());

function repLine(r: RepEvent, variant: Variant, rng: Rng): { line: string; cat: string } {
  const { cat, f } = repCategory(r, variant);
  return { line: fill(rng.pick(BANK[cat]), r, f.up_delt_x_clean), cat };
}

function repPrompt(meta: SetRow, r: RepEvent, context: string): string {
  const f = repFacts(r, meta.variant);
  const { cat } = repCategory(r, meta.variant);
  const x = f.up_delt_x_clean;
  const bi = r.arm === "L" ? 2 : 0;
  const verdict = r.cheat ? "CHEAT (shoulder took over)" : r.loose ? "LOOSE (shoulder rising with fatigue, not a cheat)" : "clean";
  const extra = cat === "cheat_big" ? ", a full swing" : cat === "near_miss" ? ", but close to the cheat line" : cat.startsWith("slack") ? `, ${cat === "slack_left" ? "left" : "right"} side slacking` : cat === "fast" ? ", too fast up" : "";
  return [
    "You are a blunt gym coach speaking through a speaker mid-set. The sensor code has already judged this curl rep. Say the call-out in one short line (under 20 words). Do not re-judge the rep; use the code's verdict as given. Talk about the shoulder relative to the lifter's own clean reps; never quote a raw percentage.",
    `Context: ${context.replace(/_/g, " ")}. Exercise: ${meta.exercise} (${meta.variant}), load: ${meta.load_desc}. Arm: ${r.arm} (${side(r.arm)}). Set ${meta.set_index}, rep ${r.rep}.`,
    `Numbers: biceps peak ${(r.peak_pct[bi] ?? 0).toFixed(2)} of calibrated max; front delt (cheat check) on the way up: ${x == null ? "no clean reference yet (still learning this lifter's clean rep)" : `${xt(x)}x this lifter's clean reps`}; up ${Math.round(r.up_ms)} ms.`,
    `Code verdict: ${verdict}${extra}.`,
  ].join("\n");
}

const CONTEXT_OPEN: Record<string, string[]> = {
  first_set: ["First set.", "Set one done.", "Opening set."],
  mid_workout: ["Set {K}.", "That's set {K}.", "Set {K} done."],
  late_fatigue: ["Last set, you're tiring.", "Set {K}, the fatigue is showing.", "Final set."],
  walk_up_no_history: ["Nice work.", "Alright.", "Good effort."],
};
function setLine(meta: SetRow, context: string, rng: Rng): string {
  const open = rng.pick(CONTEXT_OPEN[context] ?? ["Set {K}."]).replace("{K}", word(meta.set_index));
  return `${open} ${fallbackSummary(meta.set_end)}`.replace(/\s+/g, " ").trim();
}
function setPrompt(meta: SetRow, context: string): string {
  const f = setFacts(meta.set_end);
  const facts = {
    context, total_reps: f.total_reps, cheats: f.cheats, first_cheat_rep: f.first_cheat_rep, cheat_pattern: f.cheat_pattern, reference_status: f.reference_status,
    decision: meta.set_end.decision?.next, loose_reps: meta.set_end.reps.filter((r) => r.loose).map((r) => r.rep), delt_saturated: meta.set_end.delt_saturated ?? [],
    reps: f.reps.map(({ rep, arm, verdict, label, up_delt_x_clean, up_ms }) => ({ rep, arm, verdict, label, shoulder_up_x_clean: up_delt_x_clean, up_ms })),
  };
  return [
    "You are a blunt gym coach. The set just ended. The sensor code has already counted the reps, flagged the cheats and decided what happens next. Sum it up in one to three short spoken sentences. Do not re-judge any rep and do not change the weight. Talk about the shoulder relative to the lifter's own clean reps (shoulder_up_x_clean = times its normal share on the way up); never quote a raw percentage. If this is a walk-up, there is no history: don't mention earlier sessions.",
    `Exercise: ${meta.exercise} (${meta.variant}), load: ${meta.load_desc}. Set ${meta.set_index}.`,
    `Code facts (JSON): ${JSON.stringify(facts)}`,
  ].join("\n");
}

function workoutLine(sets: SetRow[], rng: Rng): string {
  const reps = sets.reduce((a, s) => a + s.set_end.reps.length, 0);
  const cheats = sets.reduce((a, s) => a + s.set_end.cheats, 0);
  const cheatSets = sets.filter((s) => s.set_end.cheats > 0).map((s) => s.set_index);
  const loose = sets.reduce((a, s) => a + s.set_end.reps.filter((r) => r.loose).length, 0);
  const head = `${word(sets.length)} sets, ${reps} reps, ${cheats === 0 ? "no cheats" : `${cheats} cheat${cheats > 1 ? "s" : ""}`}.`.replace(/^./, (c) => c.toUpperCase());
  const where = cheats === 0 ? rng.pick(["Your shoulder stayed in its normal range all workout.", "Clean work the whole way."]) : cheatSets.length === 1 ? `All in set ${word(cheatSets[0])}.` : `Spread over sets ${cheatSets.join(", ")}.`;
  const tired = loose > 0 ? rng.pick([" You got loose as you tired; rest a bit longer next time.", " The shoulder crept in late, that's fatigue."]) : "";
  const next = rng.pick(["Same weight next time.", "Keep the weight, clean those reps up.", "Hold the weight and own every rep."]);
  return `${head} ${where}${tired} ${next}`;
}

const SAT_HINT = (arms: string[]) => (arms.length ? ` Your ${arms.map((a) => (a === "R" ? "right" : "left")).join(" and ")} delt pad reads at the ceiling: move it down the shoulder.` : "");

function bannedIn(line: string) {
  return /snitch/i.test(line) || mentionsRawShare(line) || mentionsLoadChange(line) || mentionsMedical(line);
}

// ------------------------------------------------------------------------------------------ main
interface Out { reps: object[]; windows: object[]; sft: object[]; sets: object[] }
const out: Out = { reps: [], windows: [], sft: [], sets: [] };
const rng = rngOf(SEED);
const seen = new Set<string>();
let dupes = 0;
function pushSft(row: { id: string; messages: { role: string; content: string }[]; [k: string]: unknown }) {
  const line = row.messages[1].content;
  if (bannedIn(line)) throw new Error(`wording rule broken in ${row.id}: ${line}`);
  if (row.kind === "rep_cue" && line.split(/\s+/).length > 20) throw new Error(`rep cue over 20 words in ${row.id}: ${line}`);
  const key = row.messages[0].content + "\u0000" + line;
  if (seen.has(key)) { dupes++; return; }
  seen.add(key);
  out.sft.push(row);
}

// Real: reps/windows as exported, plus split; SFT rebuilt here so real and synthetic share one target style.
const realBySession = new Map<string, SetRow[]>();
for (const s of realSets) {
  if (!s.set_end.reps.length) continue;
  const list = realBySession.get(s.recording_id) ?? [];
  list.push(s);
  realBySession.set(s.recording_id, list);
}
for (const r of realReps) out.reps.push({ ...r, split: splitOf(r.recording_id, "real"), generator_version: null, seed: null });
for (const w of realWins) out.windows.push({ ...w, split: splitOf(String(w.recording_id), "real") });
for (const [recording, sets] of realBySession) {
  const split = splitOf(recording, "real");
  sets.forEach((s, k) => {
    const context = k === 0 ? "first_set" : "mid_workout";
    out.sets.push({ id: s.id, recording_id: recording, source: "real", split, context, set_index: s.set_index, labels: s.labels, set_end: s.set_end });
    for (const r of s.set_end.reps) {
      const { line, cat } = repLine(r, s.variant, rng);
      pushSft({ id: `${s.id}/rep${r.rep}-${r.arm}/cue`, kind: "rep_cue", source: "real", split, recording_id: recording, rep: r.rep, engine_flag: r.cheat, loose: !!r.loose, category: cat, messages: [{ role: "user", content: repPrompt(s, r, context) }, { role: "model", content: line }] });
    }
    pushSft({ id: `${s.id}/summary`, kind: "set_summary", source: "real", split, recording_id: recording, cheat_reps: s.set_end.reps.filter((r) => r.cheat).map((r) => r.rep), total_reps: s.set_end.reps.length, messages: [{ role: "user", content: setPrompt(s, context) }, { role: "model", content: setLine(s, context, rng) + SAT_HINT(s.set_end.delt_saturated ?? []) }] });
  });
}

// Synthetic sessions
let faults = 0;
for (let i = 0; i < N_SESSIONS; i++) {
  const g = genSession(i, rng);
  const seed = SEED * 1000 + i;
  const run = runSession(g, seed);
  const base = { source: "synthetic", split: "train", generator_version: GENERATOR_VERSION, seed, condition: g.cond, pad_sensitivity: r3(g.padK), high_baseline_pad: g.high, fault: g.fault };
  if (g.fault) {
    faults++;
    const msg = run.problems.length ? run.problems.join(" ") : "All channels look fine.";
    pushSft({
      id: `${g.id}/calibration`, kind: "calibration_check", ...base, recording_id: g.id,
      messages: [
        { role: "user", content: `You are a gym coach helping set up EMG sensors. The calibration code checked each channel and reported: ${JSON.stringify(run.problems)}. Tell the lifter what to fix in one or two short sentences.` },
        { role: "model", content: msg },
      ],
    });
  }
  for (const rs of run.sets) {
    const s = rs.meta;
    out.sets.push({ id: s.id, recording_id: g.id, ...base, context: rs.context, set_kind: rs.kind, set_index: s.set_index, labels: s.labels, set_end: s.set_end });
    s.set_end.reps.forEach((r, j) => {
      const gi = rs.intents[j];
      const id = `${s.id}/rep${r.rep}-${r.arm}`;
      const common = {
        id, recording_id: g.id, ...base, person: g.person, session_id: g.id, exercise: s.exercise, variant: s.variant, load_lb: s.load_lb, load_desc: s.load_desc, arms_on: s.arms_on,
        arm: r.arm, set_index: s.set_index, set_label: rs.kind, rep: r.rep, label_instructed: gi?.intent ?? null, label_source: "generator_intent", generator_tag: gi?.tag ?? null,
        engine_flag: r.cheat, engine_reason: r.cheat_reason, loose: !!r.loose,
      };
      out.reps.push({
        ...common, label_engine_agree: gi ? (gi.intent === "swing") === r.cheat : null,
        start_ms: r.start_ms, end_ms: r.end_ms, duration_ms: r.end_ms - r.start_ms, up_ms: r.up_ms, down_ms: r.down_ms, peak_pct: r.peak_pct, mean_pct: r.mean_pct,
        delt_share: r.delt_share, baseline_delt_share: r.baseline_delt_share, up_delt_ratio: r.up_delt_ratio ?? null, baseline_up_delt_ratio: r.baseline_up_delt_ratio ?? null,
        up_delt_x_clean: repFacts(r, s.variant).up_delt_x_clean, r_share: r.r_share, sample_hz: 200, calibration: { rest: run.calibration.rest, mvc: run.calibration.mvc },
      });
      const w = window128(rs.samples, r.start_ms, r.end_ms);
      if (w) out.windows.push({ ...common, length: WINDOW_LEN, duration_ms: r.end_ms - r.start_ms, sample_hz: 200, channels: ["R_biceps", "R_front_delt", "L_biceps", "L_front_delt"], pct: w });
      const { line, cat } = repLine(r, s.variant, rng);
      pushSft({ id: `${id}/cue`, kind: "rep_cue", ...base, recording_id: g.id, rep: r.rep, engine_flag: r.cheat, loose: !!r.loose, category: cat, messages: [{ role: "user", content: repPrompt(s, r, rs.context) }, { role: "model", content: line }] });
    });
    if (s.set_end.reps.length) {
      pushSft({ id: `${s.id}/summary`, kind: "set_summary", ...base, recording_id: g.id, context: rs.context, cheat_reps: s.set_end.reps.filter((r) => r.cheat).map((r) => r.rep), total_reps: s.set_end.reps.length, messages: [{ role: "user", content: setPrompt(s, rs.context) }, { role: "model", content: setLine(s, rs.context, rng) + SAT_HINT(s.set_end.delt_saturated ?? []) }] });
    }
  }
  const done = run.sets.map((x) => x.meta).filter((x) => x.set_end.reps.length);
  if (done.length >= 2) {
    const facts = done.map((x) => ({ set: x.set_index, reps: x.set_end.reps.length, cheats: x.set_end.cheats, loose: x.set_end.reps.filter((r) => r.loose).length, decision: x.set_end.decision?.next }));
    pushSft({
      id: `${g.id}/workout`, kind: "workout_summary", ...base, recording_id: g.id,
      messages: [
        { role: "user", content: `You are a blunt gym coach. The workout is over. The sensor code's per-set facts (JSON): ${JSON.stringify(facts)}. Exercise: ${done[0].exercise}, load: ${done[0].load_desc}. Sum up the workout in two or three short spoken sentences. Don't re-judge reps and don't change the weight.` },
        { role: "model", content: workoutLine(done, rng) },
      ],
    });
  }
}

// ------------------------------------------------------------------------------------------ write
mkdirSync(OUT, { recursive: true });
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(path.join(OUT, "reps.jsonl"), jsonl(out.reps));
writeFileSync(path.join(OUT, "windows.jsonl"), jsonl(out.windows));
writeFileSync(path.join(OUT, "sets.jsonl"), jsonl(out.sets));
// (no combined gemma_sft.jsonl: use the split files)
for (const sp of ["train", "validation", "test"]) writeFileSync(path.join(OUT, `gemma_sft_${sp}.jsonl`), jsonl(out.sft.filter((r) => (r as { split: string }).split === sp)));
writeFileSync(path.join(OUT, "fit_stats.json"), JSON.stringify({ generator_version: GENERATOR_VERSION, seed: SEED, sessions: N_SESSIONS, fitted_from_real: FIT }, null, 2) + "\n");

const count = (rows: object[], f: (r: Record<string, unknown>) => unknown) => {
  const m: Record<string, number> = {};
  for (const r of rows as Record<string, unknown>[]) { const k = String(f(r)); m[k] = (m[k] ?? 0) + 1; }
  return m;
};
console.log(JSON.stringify({
  reps: count(out.reps, (r) => `${r.source}/${r.split}`), sft: count(out.sft, (r) => `${r.source}/${r.split}/${r.kind}`),
  syn_labels: count(out.reps.filter((r) => (r as { source: string }).source === "synthetic"), (r) => `${r.label_instructed}->${r.engine_flag ? "cheat" : r.loose ? "loose" : "clean"}`),
  categories: count(out.sft.filter((r) => (r as { kind: string }).kind === "rep_cue"), (r) => r.category),
  unique_targets: new Set((out.sft as { messages: { content: string }[] }[]).map((r) => r.messages[1].content)).size, sft_total: out.sft.length, dupes_removed: dupes, fault_sessions: faults,
}, null, 1));
