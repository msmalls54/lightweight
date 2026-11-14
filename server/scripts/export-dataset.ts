// Export the Lightweight EMG curl dataset (v1) for a Gemma fine-tune and a classifier baseline.
//
//   cd server && npx tsx scripts/export-dataset.ts --db <copy of data/lightweight.sqlite>
//       real CSVs + LIVE 200 Hz sessions (replayed from stored batches with the current engine) + synthetic
//   options: --out <dir> (default ../data/dataset/v1), --no-synthetic
//   Always point --db at a COPY: node:sqlite may checkpoint the WAL when it opens the file.
//
// Rule kept from CLAUDE.md: CODE DECIDES, THE MODEL ONLY PHRASES. Every verdict in these files comes
// from the signal engine (`engine_flag`) or from the person's instruction during the recording
// (`label_instructed`). The two are kept in separate fields and never merged. The Gemma SFT pairs
// give the model the code's verdict and ask only for the spoken line, which is itself built by code
// (CLIPS text of pickCueSequence, or fallbackSummary). No network, no Gemini, no audio.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine, DEFAULT_CONFIG, type Batch, type Calibration, type RepEvent, type SetContext, type SetEndEvent, type Variant } from "../src/engine/index.js";
import { synth, toBatches, presets, type SynthRep } from "../src/engine/fixtures.js";
import { pickCue, pickCueSequence, pickSetEndCue, setFacts, repFacts, fallbackSummary, mentionsRawShare, scrubSnitch, CUE_CONFIG } from "../src/coach/index.js";
import { CLIPS } from "../src/voice/index.js"; // text only: never call initVoice/speak here

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RAW = path.join(REPO, "data/coach/history/raw");
const WINDOW_LEN = 128;
const DATASET_VERSION = "v1";

// ------------------------------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const argVal = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = path.resolve(argVal("--out") ?? path.join(REPO, "data/dataset", DATASET_VERSION));
const DB_PATH = argVal("--db");
const WITH_SYNTH = !argv.includes("--no-synthetic");

// ------------------------------------------------------------------------------------------ types
type Source = "real" | "synthetic";
/** "loose" = Mike's own word for a rep that was "kind of activated, going fast": neither strict nor an intended swing. */
type Instructed = "strict" | "swing" | "loose";

interface Sample { t: number; pct: number[] }

interface RecordingMeta {
  recording_id: string;
  source: Source;
  person: string;
  session_id: string;
  exercise: string;
  variant: Variant;
  load_lb: number | null;
  load_desc: string;
  arms_on: ("R" | "L")[];
  sample_hz: number;
  calibration: { rest: number[]; mvc: number[]; note: string };
  file: string | null;
}

interface SetRun {
  meta: RecordingMeta;
  set_index: number; // 1-based within the recording/session
  set_label: string; // the raw phase label that started the set (or synthetic preset name)
  instructed: Instructed | null;
  set: SetEndEvent;
  repEventKeys: Set<string>; // reps that got their own "rep" event
  samples: Sample[]; // the %MVC timeline fed to the engine during this set (for windows)
  labelAt: (t: number) => string | null; // raw phase label at engine time t (real data)
  repInstruction?: (r: RepEvent) => { label: Instructed | null; note: string | null }; // synthetic or human per-rep labels
  labelSource?: "phase_instruction" | "generator_intent" | "human_per_rep";
}

// ------------------------------------------------------------------------------------------ helpers
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const repKey = (r: RepEvent) => `${r.arm}:${r.rep}`;

function toPctFn(cal: { rest: number[]; mvc: number[] }) {
  // Same math as the engine (calibration.ts toPct + effectiveScale, every channel usable here).
  return (raw: number, c: number) => {
    const p = (raw - cal.rest[c]) / (cal.mvc[c] - cal.rest[c]);
    return Number.isFinite(p) ? Math.min(DEFAULT_CONFIG.pctMax, Math.max(0, p)) : 0;
  };
}

/** Feeds one batch, mirroring the engine's sample timing so `samples` lines up with rep start/end ms. */
function feed(
  e: Engine,
  b: Batch,
  pct: (raw: number, c: number) => number,
  clock: { lastT: number },
  samples: Sample[],
  onSetEnd: (s: SetEndEvent) => void,
  repKeys: Set<string>,
) {
  const n = Math.min(...b.ch.map((c) => c.length));
  for (let i = 0; i < n; i++) {
    const t = b.t0_ms + i * b.dt_ms;
    if (t <= clock.lastT) continue;
    clock.lastT = t;
    samples.push({ t, pct: [0, 1, 2, 3].map((c) => pct(b.ch[c][i], c)) });
  }
  for (const ev of e.ingest(b)) {
    if (ev.type === "rep") repKeys.add(repKey(ev));
    if (ev.type === "set_end") onSetEnd(ev);
  }
}

function instructedFromPhase(ph: string): Instructed | null {
  const p = ph.toLowerCase();
  if (p.startsWith("strict")) return "strict";
  if (p.startsWith("cheat")) return "swing";
  return null;
}

function csvRows(file: string): string[][] {
  return readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => l.split(","));
}

// ------------------------------------------------------------------------------------------ real: Nov 13 bench
// Mirrors tests/engine-real.test.ts: 2 channels (R biceps A0, R delt A1), ~20 Hz (sample index x 50 ms),
// 4 samples per batch, left channels held at rest (550). Each curl phase is fed as its OWN engine/session
// (that is what gives 3 strict + 4 swing reps). Calibration: rest 570/495, MVC at the ENV ceiling.
function runNov13(): SetRun[] {
  const file = path.join(RAW, "2026-11-13-bench.csv");
  const DT = 50;
  const rows = csvRows(file).map(([sample, phase, a0, a1]) => ({ t: +sample * DT, ph: phase, a0: +a0, a1: +a1 }));
  const cal: Calibration = { rest: [570, 495, 550, 550], mvc: [14960, 14960, 14960, 14960], ok: true, problems: [] };
  const pct = toPctFn(cal);
  const out: SetRun[] = [];
  ["strict_curls", "cheat_curls"].forEach((phase, k) => {
    const meta: RecordingMeta = {
      recording_id: "2026-11-13-bench",
      source: "real",
      person: "mike",
      session_id: `2026-11-13-bench/${phase}`,
      exercise: "standing band curl",
      variant: "standing",
      load_lb: null,
      load_desc: "resistance band",
      arms_on: ["R"],
      sample_hz: 20,
      calibration: { rest: cal.rest, mvc: cal.mvc, note: "rest from the bench rest phase; MVC = ENV ceiling 14960 (no MVC hold for biceps that night). L channels not worn (fed as constant 550)." },
      file: "data/coach/history/raw/2026-11-13-bench.csv",
    };
    const e = new Engine();
    e.setCalibration(cal);
    const ctx: SetContext = { session_id: meta.session_id, set_id: phase, person: "Mike", exercise: meta.exercise, variant: "standing", arms: ["R"] };
    e.startSet(ctx);
    const r = rows.filter((x) => x.ph === phase);
    const samples: Sample[] = [];
    const keys = new Set<string>();
    const clock = { lastT: -Infinity };
    let ended: SetEndEvent | null = null;
    for (let i = 0; i < r.length; i += 4) {
      const s = r.slice(i, i + 4);
      const b: Batch = { device: "bench-2026-11-13", seq: i / 4, t0_ms: s[0].t, dt_ms: DT, ch: [s.map((x) => x.a0), s.map((x) => x.a1), s.map(() => 550), s.map(() => 550)] };
      feed(e, b, pct, clock, samples, (se) => (ended = se), keys);
    }
    const set = ended ?? e.endSet()!;
    out.push({ meta, set_index: k + 1, set_label: phase, instructed: instructedFromPhase(phase), set, repEventKeys: keys, samples, labelAt: () => phase });
  });
  return out;
}

// ------------------------------------------------------------------------------------------ real: Nov 14 (t,ph,a0..a3)
// Mirrors tests/engine-real.test.ts runSession35 / runSessionR35: one engine = one session; one row per batch
// (dt = next t - t); the STRICT set runs from the STRICT label until the CHEAT label, the CHEAT set from there
// to the end of the file. So reps that happen under a later "relaxN" label stay in the set they belong to.
function runNov14(opts: { file: string; recording_id: string; arms: ("R" | "L")[]; cal: Calibration; calNote: string }): SetRun[] {
  const file = path.join(RAW, opts.file);
  const rows = csvRows(file).map(([t, ph, a0, a1, a2, a3]) => ({ t: +t, ph, ch: [+a0, +a1, +a2, +a3] }));
  const pct = toPctFn(opts.cal);
  const meta: RecordingMeta = {
    recording_id: opts.recording_id,
    source: "real",
    person: "mike",
    session_id: opts.recording_id,
    exercise: "dumbbell curl",
    variant: "standing",
    load_lb: 35,
    load_desc: "35 lb dumbbell" + (opts.arms.length > 1 ? "s (both arms together)" : ""),
    arms_on: opts.arms,
    sample_hz: 20,
    calibration: { rest: opts.cal.rest, mvc: opts.cal.mvc, note: opts.calNote },
    file: `data/coach/history/raw/${opts.file}`,
  };
  const labelAt = (t: number): string | null => {
    let lab: string | null = null;
    for (const r of rows) {
      if (r.t > t) break;
      lab = r.ph;
    }
    return lab;
  };
  const e = new Engine();
  e.setCalibration(opts.cal);
  const out: SetRun[] = [];
  const clock = { lastT: -Infinity };
  let cur: SetRun | null = null;
  let curLabel = ""; // like the test: the last set label seen, kept after an auto set_end
  const close = (se: SetEndEvent | null) => {
    if (cur && se) {
      cur.set = se;
      out.push(cur);
    }
    cur = null;
  };
  rows.forEach((r, i) => {
    if ((r.ph === "STRICT" || r.ph === "CHEAT") && r.ph !== curLabel) {
      close(e.endSet());
      curLabel = r.ph;
      const ctx: SetContext = { session_id: meta.session_id, set_id: r.ph, person: "Mike", exercise: meta.exercise, variant: "standing", load_lb: 35, arms: opts.arms };
      e.startSet(ctx);
      cur = { meta, set_index: out.length + 1, set_label: r.ph, instructed: instructedFromPhase(r.ph), set: null as unknown as SetEndEvent, repEventKeys: new Set(), samples: [], labelAt };
    }
    const dt = i + 1 < rows.length ? rows[i + 1].t - r.t : 50;
    const b: Batch = { device: opts.recording_id, seq: i, t0_ms: r.t, dt_ms: dt, ch: r.ch.map((x) => [x]) };
    const c = cur as SetRun | null;
    feed(e, b, pct, clock, c ? c.samples : [], (se) => close(se), c ? c.repEventKeys : new Set());
  });
  close(e.endSet());
  return out;
}

// ------------------------------------------------------------------------------------------ synthetic
interface SynthSet { name: string; reps: SynthRep[]; intent: (i: number) => Instructed; note: string }
interface SynthSession {
  id: string; exercise: string; variant: Variant; load_lb: number | null; load_desc: string; arms: ("R" | "L")[]; seed: number; sets: SynthSet[];
}

const allStrict = () => "strict" as const;
const allSwing = () => "swing" as const;
const SYNTH_SESSIONS: SynthSession[] = [
  {
    id: "syn-band-clean-then-swing", exercise: "standing band curl", variant: "standing", load_lb: null, load_desc: "resistance band", arms: ["R"], seed: 11,
    sets: [
      { name: "clean", reps: presets.clean(8), intent: allStrict, note: "preset clean: biceps 0.8, delt 0.08" },
      { name: "swing", reps: presets.swing(5), intent: allSwing, note: "preset swing: biceps 0.45, delt 0.75" },
    ],
  },
  {
    id: "syn-band-fatigue", exercise: "standing band curl", variant: "standing", load_lb: null, load_desc: "resistance band", arms: ["R"], seed: 23,
    sets: [{ name: "fatigueDrift", reps: presets.fatigueDrift(10), intent: (i) => (i < 5 ? "strict" : "swing"), note: "preset fatigueDrift: clean reps 1-5, delt climbs from rep 6 (generator intent = swing)" }],
  },
  {
    id: "syn-35lb-heavy", exercise: "dumbbell curl", variant: "standing", load_lb: 35, load_desc: "35 lb dumbbell", arms: ["R"], seed: 37,
    sets: [
      { name: "heavyEccentric", reps: presets.heavyEccentric(6), intent: allStrict, note: "preset heavyEccentric: strict heavy reps, delt works on the way down" },
      { name: "heavySwingUp", reps: presets.heavySwingUp(3), intent: allSwing, note: "preset heavySwingUp: delt fires above the biceps on the way up" },
    ],
  },
  {
    id: "syn-bilateral-left-slacking", exercise: "dumbbell curl", variant: "standing", load_lb: 35, load_desc: "35 lb dumbbells (both arms together)", arms: ["R", "L"], seed: 41,
    sets: [{ name: "bilateralImbalance", reps: Array.from({ length: 6 }, () => ({ arm: "both" as const, bi: 0.8, lBi: 0.45, delt: 0.08 })), intent: allStrict, note: "bilateral clean reps, L biceps peak 0.45 vs R 0.8 (imbalance, no swing)" }],
  },
  {
    id: "syn-band-fast", exercise: "standing band curl", variant: "standing", load_lb: null, load_desc: "resistance band", arms: ["R"], seed: 53,
    sets: [{ name: "fast", reps: presets.fast(6), intent: allStrict, note: "preset fast: clean but up phase 200 ms (tempo, not a swing)" }],
  },
];

function runSynthetic(): SetRun[] {
  const out: SetRun[] = [];
  const rest = [570, 495, 560, 520];
  const mvc = [14960, 14960, 14960, 14960];
  const cal: Calibration = { rest, mvc, ok: true, problems: [] };
  const pct = toPctFn(cal);
  for (const sess of SYNTH_SESSIONS) {
    const meta: RecordingMeta = {
      recording_id: sess.id, source: "synthetic", person: "synthetic", session_id: sess.id, exercise: sess.exercise, variant: sess.variant,
      load_lb: sess.load_lb, load_desc: sess.load_desc, arms_on: sess.arms, sample_hz: 200,
      calibration: { rest, mvc, note: "generator defaults (server/src/engine/fixtures.ts)" }, file: null,
    };
    const e = new Engine();
    e.setCalibration(cal);
    const clock = { lastT: -Infinity };
    let t0 = 100_000;
    sess.sets.forEach((ss, k) => {
      const syn = synth(ss.reps, { hz: 200, rest, mvc, seed: sess.seed + k });
      const ctx: SetContext = { session_id: sess.id, set_id: ss.name, person: "synthetic", exercise: sess.exercise, variant: sess.variant, load_lb: sess.load_lb ?? undefined, arms: sess.arms };
      e.startSet(ctx);
      const run: SetRun = { meta, set_index: k + 1, set_label: ss.name, instructed: null, set: null as unknown as SetEndEvent, repEventKeys: new Set(), samples: [], labelAt: () => ss.name, labelSource: "generator_intent" };
      let ended: SetEndEvent | null = null;
      const setT0 = t0;
      for (const b of toBatches(syn.ch, syn.hz, { t0_ms: t0, device: sess.id })) feed(e, b, pct, clock, run.samples, (se) => (ended = se), run.repEventKeys);
      run.set = ended ?? e.endSet()!;
      // Ground truth: match each detected rep to the generator rep window it overlaps most.
      run.repInstruction = (r) => {
        let best = -1, bestOv = 0;
        syn.reps.forEach((w, i) => {
          const ov = Math.min(r.end_ms, setT0 + w.end) - Math.max(r.start_ms, setT0 + w.start);
          if (ov > bestOv) { bestOv = ov; best = i; }
        });
        if (best < 0) return { label: null, note: "no generator rep overlaps this detection" };
        return { label: ss.intent(best), note: `synthetic generator intent (${ss.note}); generator rep ${best + 1}` };
      };
      out.push(run);
      t0 = clock.lastT + 15_000; // > 10 s gap between sets, like a real rest
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------ rows
function window128(samples: Sample[], start: number, end: number): number[][] | null {
  const w = samples.filter((s) => s.t >= start && s.t <= end);
  if (w.length < 2 || end <= start) return null;
  const out: number[][] = [[], [], [], []];
  let j = 0;
  for (let k = 0; k < WINDOW_LEN; k++) {
    const t = start + ((end - start) * k) / (WINDOW_LEN - 1);
    while (j < w.length - 2 && w[j + 1].t < t) j++;
    const a = w[j], b = w[j + 1];
    const u = b.t === a.t ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    for (let c = 0; c < 4; c++) out[c].push(r3(a.pct[c] + (b.pct[c] - a.pct[c]) * u));
  }
  return out;
}

function biPeakTime(samples: Sample[], r: RepEvent): number {
  const bi = r.arm === "L" ? 2 : 0;
  let best = r.start_ms, v = -1;
  for (const s of samples) if (s.t >= r.start_ms && s.t <= r.end_ms && s.pct[bi] > v) { v = s.pct[bi]; best = s.t; }
  return best;
}

function labelFor(run: SetRun, r: RepEvent): { label: Instructed | null; note: string | null; phase_at_peak: string | null } {
  if (run.repInstruction) return { ...run.repInstruction(r), phase_at_peak: run.set_label };
  const atPeak = run.labelAt(biPeakTime(run.samples, r));
  let note: string | null = null;
  if (atPeak && atPeak !== run.set_label) {
    note =
      `biceps peak falls under the following '${atPeak}' phase label (labels lag the movement); ` +
      `instruction taken from the '${run.set_label}' set it belongs to`;
  }
  return { label: run.instructed, note, phase_at_peak: atPeak };
}

function cueFlags(r: RepEvent, variant: Variant) {
  const fastUpMs = DEFAULT_CONFIG.fastUpMs;
  const imbalance =
    r.r_share == null || !Number.isFinite(r.r_share) ? "n/a (one arm)"
      : r.r_share > CUE_CONFIG.rShareHigh ? "left side slacking"
      : r.r_share < CUE_CONFIG.rShareLow ? "right side slacking" : "balanced";
  const tempo = r.up_ms > 0 && r.up_ms < fastUpMs ? "too fast up" : "ok";
  return { imbalance, tempo, cue: pickCue(r, { variant }) };
}

const f2 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "n/a" : (Math.round(x * 100) / 100).toFixed(2));

const sideWord = (a: "R" | "L") => (a === "R" ? "right" : "left");
const NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const repWord = (n: number) => (n >= 0 && n <= 20 ? NUM_WORDS[n] : String(n));
const xText = (x: number) => (x >= 10 ? String(Math.round(x)) : (Math.round(x * 10) / 10).toString());

/** Prompt for one rep. Wording rules (Nov 14): no raw delt share, the front delt (cheat check) is
 *  described relative to the lifter's OWN clean reps, never "snitch". */
function repPrompt(meta: RecordingMeta, setIndex: number, r: RepEvent): string {
  const bi = r.arm === "L" ? 2 : 0;
  const fl = cueFlags(r, meta.variant);
  const f = repFacts(r, meta.variant);
  const x = f.up_delt_x_clean;
  return [
    "You are a blunt gym coach speaking through a speaker mid-set. The sensor code has already judged this curl rep. Say the call-out in one short line (under 20 words). Do not re-judge the rep; use the code's verdict as given. Talk about the shoulder relative to the lifter's own clean reps; never quote a raw percentage.",
    `Exercise: ${meta.exercise} (${meta.variant}), load: ${meta.load_desc}. Arm: ${r.arm} (${sideWord(r.arm)}). Set ${setIndex}, rep ${r.rep}.`,
    `Numbers: biceps peak ${f2(r.peak_pct[bi])} of calibrated max; front delt (cheat check) on the way up: ${x == null ? "no clean reference yet (still learning this lifter's clean rep)" : `${xText(x)}x this lifter's clean reps`}; up ${Math.round(r.up_ms)} ms.`,
    `Code verdict: ${r.cheat ? "CHEAT (shoulder took over)" : "clean"}${f.label === "big_swing" ? ", a full swing" : f.label === "near_miss" ? ", but close to the cheat line" : ""}; imbalance: ${fl.imbalance}; tempo: ${fl.tempo}.`,
  ].join("\n");
}

/** The target line for a rep, built by code from the same verdict (the model only learns to phrase it). */
function repLine(r: RepEvent, variant: Variant): string {
  const f = repFacts(r, variant);
  const fl = cueFlags(r, variant);
  const n = `Rep ${repWord(r.rep)}`;
  const x = f.up_delt_x_clean;
  if (r.cheat) {
    if (variant === "preacher") return `${n}: cheat. Elbows in, keep them pinned.`;
    if (x == null) return `${n}: cheat. Your ${sideWord(r.arm)} shoulder took over.`;
    return `${n}: cheat. Your ${sideWord(r.arm)} shoulder did ${xText(x)} times its normal share on the way up${f.label === "big_swing" ? ", that's a swing" : ""}.`;
  }
  if (fl.imbalance === "left side slacking") return `${n}. Left side's slacking.`;
  if (fl.imbalance === "right side slacking") return `${n}. Right side's slacking.`;
  if (fl.tempo === "too fast up") return `${n}. Clean, but slow it down.`;
  if (f.label === "near_miss") return `${n}. Clean, but your shoulder is creeping up.`;
  return `${n}. Clean.`;
}

function setPrompt(meta: RecordingMeta, setIndex: number, set: SetEndEvent): string {
  const f = setFacts(set);
  const facts = {
    total_reps: f.total_reps, cheats: f.cheats, first_cheat_rep: f.first_cheat_rep, cheat_pattern: f.cheat_pattern,
    reference_status: f.reference_status, decision: set.decision?.next,
    reps: f.reps.map(({ rep, arm, verdict, label, up_delt_x_clean, up_ms }) => ({ rep, arm, verdict, label, shoulder_up_x_clean: up_delt_x_clean, up_ms })),
  };
  return [
    "You are a blunt gym coach. The set just ended. The sensor code has already counted the reps, flagged the cheats and decided what happens next. Sum it up in one or two short spoken sentences. Do not re-judge any rep and do not change the weight. Talk about the shoulder relative to the lifter's own clean reps (shoulder_up_x_clean = times its normal share on the way up); never quote a raw percentage.",
    `Exercise: ${meta.exercise} (${meta.variant}), load: ${meta.load_desc}. Set ${setIndex}.`,
    `Code facts (JSON): ${JSON.stringify(facts)}`,
  ].join("\n");
}

const cueText = (keys: string[]) => keys.map((k) => CLIPS[k] ?? k).join(" ");

interface Out { reps: object[]; windows: object[]; sft: object[] }

function emit(runs: SetRun[], out: Out) {
  for (const run of runs) {
    const m = run.meta;
    for (const r of run.set.reps) {
      const id = `${m.recording_id}/set${run.set_index}/rep${r.rep}-${r.arm}`;
      const lab = labelFor(run, r);
      const base = {
        id, recording_id: m.recording_id, source: m.source, person: m.person, session_id: m.session_id,
        exercise: m.exercise, variant: m.variant, load_lb: m.load_lb, load_desc: m.load_desc, arms_on: m.arms_on,
        arm: r.arm, set_index: run.set_index, set_label: run.set_label, rep: r.rep,
        label_instructed: lab.label, label_note: lab.note, label_source: lab.label == null ? null : run.labelSource ?? "phase_instruction",
        engine_flag: r.cheat, engine_reason: r.cheat_reason,
      };
      out.reps.push({
        ...base,
        phase_label_at_biceps_peak: lab.phase_at_peak,
        label_engine_agree: lab.label == null || lab.label === "loose" ? null : (lab.label === "swing") === r.cheat,
        up_delt_x_clean: repFacts(r, m.variant).up_delt_x_clean,
        start_ms: r.start_ms, end_ms: r.end_ms, duration_ms: r.end_ms - r.start_ms, up_ms: r.up_ms, down_ms: r.down_ms,
        peak_pct: r.peak_pct, mean_pct: r.mean_pct,
        delt_share: r.delt_share, baseline_delt_share: r.baseline_delt_share,
        up_delt_ratio: r.up_delt_ratio ?? null, baseline_up_delt_ratio: r.baseline_up_delt_ratio ?? null,
        r_share: r.r_share,
        had_rep_event: run.repEventKeys.has(repKey(r)),
        sample_hz: m.sample_hz, calibration: { rest: m.calibration.rest, mvc: m.calibration.mvc },
      });
      const w = window128(run.samples, r.start_ms, r.end_ms);
      if (w) {
        out.windows.push({
          ...base,
          length: WINDOW_LEN, duration_ms: r.end_ms - r.start_ms,
          n_source_samples: run.samples.filter((s) => s.t >= r.start_ms && s.t <= r.end_ms).length, sample_hz: m.sample_hz,
          channels: ["R_biceps", "R_front_delt", "L_biceps", "L_front_delt"],
          pct: w,
        });
      }
      const keys = pickCueSequence(r, { variant: m.variant });
      out.sft.push({
        id: `${id}/cue`, kind: "rep_cue", source: m.source, recording_id: m.recording_id, rep: r.rep, engine_flag: r.cheat,
        label_instructed: lab.label, cue_keys: keys, voice_clip_text: cueText(keys),
        messages: [
          { role: "user", content: repPrompt(m, run.set_index, r) },
          { role: "model", content: repLine(r, m.variant) },
        ],
      });
    }
    out.sft.push({
      id: `${m.recording_id}/set${run.set_index}/summary`, kind: "set_summary", source: m.source, recording_id: m.recording_id,
      cheat_reps: run.set.reps.filter((x) => x.cheat).map((x) => x.rep), total_reps: run.set.reps.length,
      cheats: run.set.cheats, decision: run.set.decision.next, set_end_cue: pickSetEndCue(run.set),
      messages: [
        { role: "user", content: setPrompt(m, run.set_index, run.set) },
        { role: "model", content: scrubSnitch(fallbackSummary(run.set)) },
      ],
    });
  }
}

// ------------------------------------------------------------------------------------------ live sessions (SQLite)
// Human per-rep labels from Mike (Nov 14), keyed by session and set_no. Rep numbers are the ones he saw LIVE
// (stored `reps` table, older engine); they are matched to today's re-detected reps by time overlap.
const HUMAN_LABELS: Record<string, Record<number, { swing?: number[]; loose?: number[]; rest: Instructed; note: string }>> = {
  "s-1114-122526-r82": { 1: { swing: [4, 8], loose: [5], rest: "strict", note: "Mike: reps 4 and 8 were intended swings, rep 5 'kind of activated, going fast', the rest strict" } },
  "s-1114-123449-zdw": { 1: { rest: "strict", note: "Mike: 3 strict reps" } },
};

interface StoredRep { rep: number; start_ms: number; end_ms: number; set_no: number }
interface ArmCtx { exercise: string; variant: Variant; load_lb?: number; arms: ("R" | "L")[]; auto_next?: boolean }

/**
 * Replays every kind='live' session's stored 200 Hz batches through the CURRENT engine, exactly the way the
 * server ran it: a set is armed right after the batch recorded in each `set_start` session event (its payload
 * is the set context), ended after `set_stop`, and re-armed after an automatic set end when `auto_next` is on.
 * (`sets.started_at` is NOT used: it is written around the first rep, so a replay from it starts mid-rep.)
 * Fake/replay sessions are skipped. Human labels are matched to re-detected reps by time overlap with the reps
 * the server stored live (older engine), whose numbers are the ones Mike saw.
 */
function runLive(dbPath: string): SetRun[] {
  const db = new DatabaseSync(dbPath);
  const out: SetRun[] = [];
  const sessions = db.prepare("SELECT session_id, person, is_walkup, calibration FROM sessions WHERE kind = 'live' ORDER BY started_at").all() as unknown as {
    session_id: string; person: string; is_walkup: number; calibration: string | null;
  }[];
  let walkup = 0;
  for (const s of sessions) {
    const events = db.prepare("SELECT kind, after_batch_id, payload FROM session_events WHERE session_id = ? AND kind IN ('set_start', 'set_stop') ORDER BY event_id").all(s.session_id) as unknown as {
      kind: string; after_batch_id: number; payload: string;
    }[];
    if (!events.some((e) => e.kind === "set_start")) continue;
    const stored = (db.prepare("SELECT r.payload AS payload, s.set_no AS set_no FROM reps r JOIN sets s ON r.set_id = s.set_id WHERE r.session_id = ?").all(s.session_id) as unknown as { payload: string; set_no: number }[])
      .map((x) => ({ ...(JSON.parse(x.payload) as StoredRep), set_no: x.set_no }));
    const batches = db.prepare("SELECT batch_id, payload FROM batches WHERE session_id = ? ORDER BY batch_id").all(s.session_id) as unknown as { batch_id: number; payload: string }[];
    const cal: Calibration = s.calibration ? (JSON.parse(s.calibration) as Calibration) : { rest: [550, 550, 550, 550], mvc: [14960, 14960, 14960, 14960], ok: true, problems: [] };
    const person = s.is_walkup ? `walkup-${++walkup}` : s.person.toLowerCase();
    const human = HUMAN_LABELS[s.session_id] ?? {};
    // Same engine settings as the live server: 30 s auto-end; everything else = current defaults.
    const e = new Engine({ autoEndMs: 30_000 });
    e.setCalibration(cal);
    const clock = { lastT: -Infinity };
    let setNo = 0;
    let armed: ArmCtx | null = null;
    let cur: { run: SetRun; pct: (raw: number, c: number) => number } | null = null;

    const labelOf = (r: RepEvent): { label: Instructed | null; note: string | null } => {
      let best: StoredRep | null = null, bestOv = 0;
      for (const sr of stored) {
        const ov = Math.min(r.end_ms, sr.end_ms) - Math.max(r.start_ms, sr.start_ms);
        if (ov > bestOv) { bestOv = ov; best = sr; }
      }
      const h = best ? human[best.set_no] : undefined;
      if (!best || !h) return { label: null, note: best ? `live set without a human label (live set ${best.set_no}, rep ${best.rep}): engine flag only` : "live: not counted as a rep live; no human label" };
      const label: Instructed = h.swing?.includes(best.rep) ? "swing" : h.loose?.includes(best.rep) ? "loose" : h.rest;
      return { label, note: `${h.note}; matched to live set ${best.set_no} rep ${best.rep}` };
    };
    const start = () => {
      if (!armed) return;
      setNo++;
      const calNow = e.getCalibration() ?? cal;
      const meta: RecordingMeta = {
        recording_id: `live:${s.session_id}`, source: "real", person, session_id: s.session_id, exercise: armed.exercise, variant: armed.variant,
        load_lb: armed.load_lb ?? null, load_desc: armed.load_lb ? `${armed.load_lb} lb dumbbell${armed.arms.length > 1 ? "s" : ""}` : "unknown", arms_on: armed.arms, sample_hz: 200,
        calibration: { rest: calNow.rest, mvc: calNow.mvc, note: "stored live session calibration (plus the engine's raise-only MVC updates from earlier sets of the session)" },
        file: "data/lightweight.sqlite (not committed)",
      };
      const run: SetRun = { meta, set_index: setNo, set_label: `armed set ${setNo}`, instructed: null, set: null as unknown as SetEndEvent, repEventKeys: new Set(), samples: [], labelAt: () => null };
      run.repInstruction = labelOf;
      e.startSet({ session_id: s.session_id, set_id: `${s.session_id}/set${setNo}`, person, exercise: armed.exercise, variant: armed.variant, load_lb: armed.load_lb, arms: armed.arms });
      cur = { run, pct: toPctFn(calNow) };
    };
    const close = (se: SetEndEvent | null) => {
      const c = cur as typeof cur;
      if (c && se) {
        c.run.set = se;
        if (se.reps.some((r) => labelOf(r).label != null)) c.run.labelSource = "human_per_rep";
        if (se.reps.length) out.push(c.run); // empty armed sets carry nothing
      }
      cur = null;
    };
    let ev = 0;
    for (const row of batches) {
      const c = cur as typeof cur;
      feed(e, JSON.parse(row.payload) as Batch, c ? c.pct : toPctFn(cal), clock, c ? c.run.samples : [], (se) => {
        close(se);
        if (armed?.auto_next) start(); // the server re-arms after an automatic set end
      }, c ? c.run.repEventKeys : new Set());
      while (ev < events.length && events[ev].after_batch_id <= row.batch_id) {
        const x = events[ev++];
        if (x.kind === "set_start") {
          close(e.endSet());
          armed = JSON.parse(x.payload) as ArmCtx;
          start();
        } else {
          close(e.endSet());
          armed = null;
        }
      }
    }
    close(e.endSet());
  }
  db.close();
  return out;
}

// ------------------------------------------------------------------------------------------ main
async function main() {
  const real: SetRun[] = [
    ...runNov13(),
    ...runNov14({
      file: "2026-11-14-right-35lb-strict-vs-swing.csv", recording_id: "2026-11-14-right-35lb-strict-vs-swing", arms: ["R"],
      cal: { rest: [550, 620, 800, 900], mvc: [14960, 14960, 14960, 14960], ok: true, problems: [] },
      calNote: "rest from the relax phases; MVC = ENV ceiling 14960 (the FLEX hold, ~10000, undershoots what curls reach). L channels worn but idle.",
    }),
    ...runNov14({
      file: "2026-11-14-fulltest-35lb-bilateral.csv", recording_id: "2026-11-14-fulltest-35lb-bilateral", arms: ["R", "L"],
      cal: { rest: [600, 620, 800, 900], mvc: [14960, 14960, 14960, 14960], ok: true, problems: [] },
      calNote: "'ceiling' calibration from tests/engine-real.test.ts: rest from the clean relax phases, MVC = ENV ceiling 14960 (curls and the raise hold saturate).",
    }),
  ];
  if (DB_PATH && !existsSync(DB_PATH)) throw new Error(`--db ${DB_PATH}: file not found`);
  const live = DB_PATH ? runLive(DB_PATH) : [];
  const syn = WITH_SYNTH ? runSynthetic() : [];

  const out: Out = { reps: [], windows: [], sft: [] };
  emit(real, out);
  emit(live, out);
  emit(syn, out);
  // Wording guard on every target line: no "snitch", no raw delt share.
  for (const row of out.sft as { id: string; messages: { role: string; content: string }[] }[]) {
    const line = row.messages[1].content;
    if (/snitch/i.test(line) || mentionsRawShare(line)) throw new Error(`wording rule broken in ${row.id}: ${line}`);
  }

  mkdirSync(OUT, { recursive: true });
  const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path.join(OUT, "reps.jsonl"), jsonl(out.reps));
  writeFileSync(path.join(OUT, "windows.jsonl"), jsonl(out.windows));
  writeFileSync(path.join(OUT, "gemma_sft.jsonl"), jsonl(out.sft));

  // Console summary for the sanity check (counts per recording/set vs the engine-real tests).
  console.log(`wrote ${OUT}`);
  for (const run of [...real, ...live, ...syn]) {
    const reps = run.set.reps;
    const lab = reps.map((r) => labelFor(run, r));
    console.log(
      `  ${run.meta.source.padEnd(9)} ${run.meta.recording_id.padEnd(40)} set ${run.set_index} ${run.set_label.padEnd(18)} ` +
      `reps ${String(reps.length).padStart(2)}  flagged ${run.set.cheats}  instructed swing ${lab.filter((l) => l.label === "swing").length}  ` +
      `lag-notes ${lab.filter((l) => l.note && run.meta.source === "real").length}  no-own-event ${reps.filter((r) => !run.repEventKeys.has(repKey(r))).length}`,
    );
  }
  const count = (rows: object[], src: Source) => rows.filter((r) => (r as { source: Source }).source === src).length;
  for (const [name, rows] of Object.entries({ "reps.jsonl": out.reps, "windows.jsonl": out.windows, "gemma_sft.jsonl": out.sft })) {
    console.log(`  ${name.padEnd(16)} real ${count(rows, "real")}  synthetic ${count(rows, "synthetic")}  total ${rows.length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
