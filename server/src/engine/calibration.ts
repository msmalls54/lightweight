// Calibration: rest baseline + MVC per channel -> %MVC. Pure functions.

import type { EngineConfig } from "./config.js";
import { ARM_CH, CHANNEL_NAMES, type Arm, type Calibration } from "./types.js";

export function median(xs: number[]): number {
  return percentile(xs, 0.5);
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return s[idx];
}

/**
 * rest[i] / mvc[i] are raw samples of channel i (3 s windows; mvc[i] = that muscle's own max flex).
 * Only the channels of `arms` are checked (default: all four).
 */
export function computeCalibration(
  rest: number[][],
  mvc: number[][],
  cfg: EngineConfig,
  arms: Arm[] = ["R", "L"],
): Calibration {
  const checked = new Set(arms.flatMap((a) => [ARM_CH[a].bi, ARM_CH[a].delt]));
  const out: Calibration = { rest: [], mvc: [], ok: true, problems: [] };
  for (let i = 0; i < 4; i++) {
    const r = median(rest[i] ?? []);
    const m = percentile(mvc[i] ?? [], cfg.mvcPercentile);
    out.rest.push(Number.isFinite(r) ? Math.round(r) : cfg.defaultRest);
    out.mvc.push(Number.isFinite(m) ? Math.round(m) : cfg.defaultMvc);
    if (!checked.has(i)) continue;
    const name = CHANNEL_NAMES[i];
    if (!Number.isFinite(r) || !Number.isFinite(m)) {
      out.problems.push(`${name}: no samples recorded. Check the cable is in the right jack.`);
    } else if (r > cfg.restMax) {
      out.problems.push(
        `${name}: reads ${Math.round(r)} at rest (expected ~550). Near 8150 means the Link Shield is on RAW: slide it to ENV. Otherwise relax fully and redo.`,
      );
    } else if (m - r < cfg.minMvcSpan) {
      out.problems.push(
        `${name}: flex only reached ${Math.round(m)} vs rest ${Math.round(r)} (needs +${cfg.minMvcSpan}). Check the pads, the TRS cable and the power switch.`,
      );
    }
  }
  out.ok = out.problems.length === 0;
  return out;
}

/** Effective per-channel rest and span. Unusable channels fall back to the defaults. */
export function effectiveScale(c: Calibration | null, cfg: EngineConfig): { rest: number[]; span: number[] } {
  const rest: number[] = [];
  const span: number[] = [];
  for (let i = 0; i < 4; i++) {
    const r = c?.rest[i];
    const m = c?.mvc[i];
    const usable =
      r !== undefined && m !== undefined && Number.isFinite(r) && Number.isFinite(m) && r <= cfg.restMax && m - r >= cfg.minMvcSpan;
    rest.push(usable ? r : cfg.defaultRest);
    span.push(usable ? m - r : cfg.defaultMvc - cfg.defaultRest);
  }
  return { rest, span };
}

export function toPct(raw: number, rest: number, span: number, pctMax: number): number {
  const p = (raw - rest) / span;
  if (!Number.isFinite(p)) return 0;
  return Math.min(pctMax, Math.max(0, p));
}
