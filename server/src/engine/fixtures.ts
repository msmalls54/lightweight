// Synthetic EMG fixtures: raw 14-bit ENV samples shaped like real curls, for tests and
// for running the dashboard without hardware. Deterministic (seeded). Pure, no I/O.

import type { Batch } from "./types.js";

export interface SynthRep {
  /** Which arm curls ("both" = bilateral). Default "R". */
  arm?: "R" | "L" | "both";
  /** Biceps peak %MVC. Default 0.8. */
  bi?: number;
  /** Delt peak %MVC (follows the same shape as the biceps). Default 0.08 (clean). */
  delt?: number;
  /** Left biceps peak when arm = "both" (imbalance). Default = bi. */
  lBi?: number;
  upMs?: number;   // default 800
  holdMs?: number; // default 200
  downMs?: number; // default 1000
  /** Slow envelope decay after the rep: lingers near `tailLevel * bi`, decaying over this long. */
  tailMs?: number;
  tailLevel?: number; // default 0.3
  /** Relaxed time after this rep. Default 1000. */
  gapMs?: number;
}

export interface SynthOptions {
  hz?: number;            // default 200
  rest?: number[];        // raw rest per channel, default [570, 495, 560, 520]
  mvc?: number[];         // raw MVC per channel, default 14960
  noise?: number;         // raw noise SD at rest, default 25
  seed?: number;
  leadMs?: number;        // rest before the first rep, default 1000
  tailMs?: number;        // rest after the last rep, default 1000
  /** Channels that are dead (flat near 0). */
  dead?: number[];
}

export interface Synth {
  hz: number;
  /** 4 arrays of raw samples. */
  ch: number[][];
  /** Ground-truth rep windows in ms from the first sample. */
  reps: { start: number; end: number }[];
}

const CEIL = 14960;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 0..1 envelope shape at time u (ms) into a rep. */
function shape(r: Required<Omit<SynthRep, "arm" | "lBi">>, u: number): number {
  if (u < 0) return 0;
  if (u < r.upMs) return 0.5 - 0.5 * Math.cos((Math.PI * u) / r.upMs);
  u -= r.upMs;
  if (u < r.holdMs) return 1;
  u -= r.holdMs;
  const floor = r.tailMs > 0 ? r.tailLevel : 0;
  if (u < r.downMs) return floor + (1 - floor) * (0.5 + 0.5 * Math.cos((Math.PI * u) / r.downMs));
  u -= r.downMs;
  if (r.tailMs > 0 && u < r.tailMs) return floor * Math.exp((-3 * u) / r.tailMs);
  return 0;
}

export function synth(reps: SynthRep[], opts: SynthOptions = {}): Synth {
  const hz = opts.hz ?? 200;
  const dt = 1000 / hz;
  const rest = opts.rest ?? [570, 495, 560, 520];
  const mvc = opts.mvc ?? [CEIL, CEIL, CEIL, CEIL];
  const noise = opts.noise ?? 25;
  const rand = rng(opts.seed ?? 1);
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * 1.73; // ~N(0,1)

  // Lay out reps on a timeline.
  const full = reps.map((r) => ({
    arm: r.arm ?? "R",
    bi: r.bi ?? 0.8,
    delt: r.delt ?? 0.08,
    lBi: r.lBi ?? r.bi ?? 0.8,
    upMs: r.upMs ?? 800,
    holdMs: r.holdMs ?? 200,
    downMs: r.downMs ?? 1000,
    tailMs: r.tailMs ?? 0,
    tailLevel: r.tailLevel ?? 0.3,
    gapMs: r.gapMs ?? 1000,
  }));
  let t = opts.leadMs ?? 1000;
  const windows: { start: number; end: number }[] = [];
  for (const r of full) {
    const len = r.upMs + r.holdMs + r.downMs + r.tailMs;
    windows.push({ start: t, end: t + len });
    t += len + r.gapMs;
  }
  const total = t + (opts.tailMs ?? 1000);
  const n = Math.ceil(total / dt);

  const ch: number[][] = [[], [], [], []];
  for (let i = 0; i < n; i++) {
    const ms = i * dt;
    const pct = [0, 0, 0, 0];
    full.forEach((r, k) => {
      const s = shape(r, ms - windows[k].start);
      if (s === 0) return;
      if (r.arm === "R" || r.arm === "both") {
        pct[0] += r.bi * s;
        pct[1] += r.delt * s;
      }
      if (r.arm === "L" || r.arm === "both") {
        pct[2] += (r.arm === "both" ? r.lBi : r.bi) * s;
        pct[3] += r.delt * s;
      }
    });
    for (let c = 0; c < 4; c++) {
      let raw: number;
      if (opts.dead?.includes(c)) raw = 20 + Math.abs(gauss()) * 3;
      else raw = rest[c] + pct[c] * (mvc[c] - rest[c]) + gauss() * (noise + pct[c] * 300);
      ch[c].push(Math.round(Math.min(CEIL, Math.max(0, raw))));
    }
  }
  return { hz, ch, reps: windows };
}

/** Constant-ish raw window for calibration (e.g. 3 s of rest, or a max-flex hold). */
export function hold(level: number[], ms: number, opts: { hz?: number; seed?: number; noise?: number; dead?: number[] } = {}): number[][] {
  const hz = opts.hz ?? 200;
  const rand = rng(opts.seed ?? 7);
  const n = Math.round((ms * hz) / 1000);
  return level.map((v, c) =>
    Array.from({ length: n }, () =>
      opts.dead?.includes(c) ? 20 : Math.round(Math.min(CEIL, Math.max(0, v + (rand() - 0.5) * 2 * (opts.noise ?? 40)))),
    ),
  );
}

/** Split 4-channel raw samples into firmware-style batches (default 40 samples = 200 ms at 200 Hz). */
export function toBatches(
  ch: number[][],
  hz: number,
  opts: { t0_ms?: number; perBatch?: number; device?: string; seq0?: number } = {},
): Batch[] {
  const per = opts.perBatch ?? Math.max(1, Math.round(hz / 5));
  const dt = 1000 / hz;
  const t0 = opts.t0_ms ?? 100_000;
  const out: Batch[] = [];
  for (let i = 0, k = 0; i < ch[0].length; i += per, k++) {
    out.push({
      device: opts.device ?? "synth",
      seq: (opts.seq0 ?? 0) + k,
      t0_ms: t0 + i * dt,
      dt_ms: dt,
      ch: ch.map((c) => c.slice(i, i + per)),
    });
  }
  return out;
}

/** Ready-made sets. */
export const presets = {
  clean: (n = 8): SynthRep[] => Array.from({ length: n }, () => ({ bi: 0.8, delt: 0.08 })),
  swing: (n = 5): SynthRep[] => Array.from({ length: n }, () => ({ bi: 0.55, delt: 0.6 })),
  /** Clean through rep 5, then the delt climbs from rep 6 on. */
  fatigueDrift: (n = 10): SynthRep[] =>
    Array.from({ length: n }, (_, i) => (i < 5 ? { bi: 0.8, delt: 0.08 } : { bi: 0.75, delt: Math.min(0.6, 0.3 + 0.08 * (i - 5)) })),
  fast: (n = 6): SynthRep[] => Array.from({ length: n }, () => ({ bi: 0.8, delt: 0.08, upMs: 200, holdMs: 50, downMs: 400, gapMs: 600 })),
};
