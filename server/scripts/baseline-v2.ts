// v2 baseline: does the synthetic data transfer to REAL reps? Logistic regression on the engine's per-rep
// features (absolute, no reference), strict vs swing. Always evaluated on REAL validation/test reps only.
//   cd server && npx tsx scripts/baseline-v2.ts [--data ../data/dataset/v2]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const DATA = path.resolve(argv.includes("--data") ? argv[argv.indexOf("--data") + 1] : path.join(HERE, "../../data/dataset/v2"));
interface Row { id: string; recording_id: string; source: string; split: string; arm: "R" | "L"; label_instructed: string | null; engine_flag: boolean; loose?: boolean; peak_pct: number[]; mean_pct: number[]; delt_share: number; up_delt_ratio: number | null; up_ms: number; duration_ms: number }
const rows = readFileSync(path.join(DATA, "reps.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row);
const bin = (r: Row) => r.label_instructed === "strict" || r.label_instructed === "swing";
const FEATURES = ["up_delt_ratio", "delt_share", "delt_peak", "delt_mean", "biceps_peak", "biceps_mean", "up_s", "duration_s"];
const feats = (r: Row) => { const bi = r.arm === "L" ? 2 : 0, de = bi + 1; return [r.up_delt_ratio ?? 0, r.delt_share, r.peak_pct[de], r.mean_pct[de], r.peak_pct[bi], r.mean_pct[bi], r.up_ms / 1000, r.duration_ms / 1000]; };
const y = (r: Row) => (r.label_instructed === "swing" ? 1 : 0);

function trainLogreg(X: number[][], Y: number[], lambda = 0.1, iters = 3000, lr = 0.1) {
  const d = X[0].length;
  const mu = Array.from({ length: d }, (_, j) => X.reduce((a, x) => a + x[j], 0) / X.length);
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((a, x) => a + (x[j] - mu[j]) ** 2, 0) / X.length) || 1);
  const Z = X.map((x) => x.map((v, j) => (v - mu[j]) / sd[j]));
  // class-balanced weights (synthetic is ~1:15 swing:strict)
  const pos = Y.filter((v) => v).length, neg = Y.length - pos;
  const wt = Y.map((v) => (v ? Y.length / (2 * Math.max(1, pos)) : Y.length / (2 * Math.max(1, neg))));
  const w = new Array(d).fill(0); let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    Z.forEach((z, i) => { const p = 1 / (1 + Math.exp(-(b + z.reduce((a, v, j) => a + v * w[j], 0)))); const e = (p - Y[i]) * wt[i]; z.forEach((v, j) => (gw[j] += e * v)); gb += e; });
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / Z.length + lambda * w[j]);
    b -= lr * (gb / Z.length);
  }
  return (x: number[]) => 1 / (1 + Math.exp(-(b + x.reduce((a, v, j) => a + ((v - mu[j]) / sd[j]) * w[j], 0))));
}
function score(preds: number[], truth: number[]) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  preds.forEach((p, i) => { if (p && truth[i]) tp++; else if (p) fp++; else if (truth[i]) fn++; else tn++; });
  const f = (x: number | null) => (x == null ? "n/a" : x.toFixed(2));
  const n = preds.length;
  return { n, acc: f(n ? (tp + tn) / n : null), precision: f(tp + fp ? tp / (tp + fp) : null), recall: f(tp + fn ? tp / (tp + fn) : null), confusion: `TP ${tp} FP ${fp} TN ${tn} FN ${fn}` };
}

const realTrain = rows.filter((r) => r.source === "real" && r.split === "train" && bin(r));
const synth = rows.filter((r) => r.source === "synthetic" && bin(r));
const evalSets = { validation: rows.filter((r) => r.source === "real" && r.split === "validation" && bin(r)), test: rows.filter((r) => r.source === "real" && r.split === "test" && bin(r)) };
const looseTest = rows.filter((r) => r.source === "real" && r.split === "test" && r.label_instructed === "loose");
const trainings: [string, Row[]][] = [["synthetic + real train", [...synth, ...realTrain]], ["synthetic only", synth], ["real train only (Nov 13 band, 7 reps)", realTrain]];
const md: string[] = ["# Baseline v2: does synthetic data transfer to real reps?", ""];
md.push(`Logistic regression (class-balanced, L2 0.1) on the engine's absolute per-rep features (${FEATURES.map((f) => "`" + f + "`").join(", ")}), strict vs swing. Training sets differ; **evaluation is always on REAL reps** from recordings never used for training (split by recording).`, "");
md.push(`Train sizes: synthetic ${synth.length} (${synth.filter((r) => y(r)).length} swing), real train ${realTrain.length} (${realTrain.filter((r) => y(r)).length} swing). Real validation ${evalSets.validation.length} (${evalSets.validation.filter((r) => y(r)).length} swing), real test ${evalSets.test.length} (${evalSets.test.filter((r) => y(r)).length} swing).`, "");
md.push("| Trained on | Evaluated on (real) | n | Accuracy | Precision (swing) | Recall (swing) | Confusion |", "|---|---|---|---|---|---|---|");
const json: Record<string, unknown> = {};
for (const [name, tr] of trainings) {
  const model = trainLogreg(tr.map(feats), tr.map(y));
  for (const [ev, rs] of Object.entries(evalSets)) {
    const s = score(rs.map((r) => (model(feats(r)) >= 0.5 ? 1 : 0)), rs.map(y));
    md.push(`| ${name} | ${ev} | ${s.n} | ${s.acc} | ${s.precision} | ${s.recall} | ${s.confusion} |`);
    json[`${name} -> ${ev}`] = s;
  }
  if (name === "synthetic + real train") for (const r of looseTest) md.push(`|  | loose rep \`${r.id}\` | 1 | P(swing) ${model(feats(r)).toFixed(2)} | | | |`);
}
for (const [ev, rs] of Object.entries(evalSets)) {
  const s = score(rs.map((r) => (r.engine_flag ? 1 : 0)), rs.map(y));
  md.push(`| engine flag (fixed rules, not trained) | ${ev} | ${s.n} | ${s.acc} | ${s.precision} | ${s.recall} | ${s.confusion} |`);
  json[`engine -> ${ev}`] = s;
}
const maj = (rs: Row[]) => score(rs.map(() => 0), rs.map(y));
for (const [ev, rs] of Object.entries(evalSets)) { const s = maj(rs); md.push(`| majority class (strict) | ${ev} | ${s.n} | ${s.acc} | ${s.precision} | ${s.recall} | ${s.confusion} |`); }
md.push("", "Read with care: the real validation/test sets are tiny (one lifter, 5 recordings), the engine's thresholds were tuned on some of these recordings, and synthetic shapes are modelled from the same few real recordings, so \"transfer\" here means \"to this lifter's other sessions\", not to new people.", "");
writeFileSync(path.join(DATA, "baseline.md"), md.join("\n"));
writeFileSync(path.join(DATA, "baseline.json"), JSON.stringify(json, null, 2) + "\n");
console.log(md.join("\n"));
