// Strict-vs-swing baseline on the v1 dataset: a tiny logistic regression and a decision stump on the engine's
// per-rep features, evaluated leave-one-recording-out on REAL rows only. Pure TypeScript, no dependencies.
//
//   cd server && npx tsx scripts/baseline.ts [--data ../data/dataset/v1]
//
// Writes baseline.md + baseline.json next to reps.jsonl. Honest by construction: synthetic rows are never used
// for training or testing here, and "loose" reps (Mike's own in-between label) are scored separately.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const DATA = path.resolve(argv.includes("--data") ? argv[argv.indexOf("--data") + 1] : path.join(HERE, "../../data/dataset/v1"));

interface Row {
  id: string; recording_id: string; source: string; arm: "R" | "L"; label_instructed: string | null; engine_flag: boolean;
  peak_pct: number[]; mean_pct: number[]; delt_share: number; up_delt_ratio: number | null; up_ms: number; duration_ms: number;
}
const rows = readFileSync(path.join(DATA, "reps.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row);
const real = rows.filter((r) => r.source === "real" && (r.label_instructed === "strict" || r.label_instructed === "swing"));
const loose = rows.filter((r) => r.source === "real" && r.label_instructed === "loose");

// Absolute per-rep features (no clean reference: the classifier has to work without the engine's session state).
const FEATURES = ["up_delt_ratio", "delt_share", "delt_peak", "delt_mean", "biceps_peak", "biceps_mean", "up_s", "duration_s"] as const;
function feats(r: Row): number[] {
  const bi = r.arm === "L" ? 2 : 0, de = bi + 1;
  return [r.up_delt_ratio ?? 0, r.delt_share, r.peak_pct[de], r.mean_pct[de], r.peak_pct[bi], r.mean_pct[bi], r.up_ms / 1000, r.duration_ms / 1000];
}
const y = (r: Row) => (r.label_instructed === "swing" ? 1 : 0);

// ---- logistic regression (standardized, L2, batch gradient descent)
function trainLogreg(X: number[][], Y: number[], lambda = 0.1, iters = 3000, lr = 0.1) {
  const d = X[0].length;
  const mu = Array.from({ length: d }, (_, j) => X.reduce((a, x) => a + x[j], 0) / X.length);
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((a, x) => a + (x[j] - mu[j]) ** 2, 0) / X.length) || 1);
  const Z = X.map((x) => x.map((v, j) => (v - mu[j]) / sd[j]));
  const w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    Z.forEach((z, i) => {
      const p = 1 / (1 + Math.exp(-(b + z.reduce((a, v, j) => a + v * w[j], 0))));
      const e = p - Y[i];
      z.forEach((v, j) => (gw[j] += e * v));
      gb += e;
    });
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / Z.length + lambda * w[j]);
    b -= lr * (gb / Z.length);
  }
  return { predict: (x: number[]) => 1 / (1 + Math.exp(-(b + x.reduce((a, v, j) => a + ((v - mu[j]) / sd[j]) * w[j], 0)))), w, b, mu, sd };
}

// ---- decision stump: best single feature + threshold + direction on the training fold
function trainStump(X: number[][], Y: number[]) {
  let best = { j: 0, t: 0, dir: 1, acc: -1 };
  for (let j = 0; j < X[0].length; j++) {
    const vals = [...new Set(X.map((x) => x[j]))].sort((a, b) => a - b);
    for (let k = 0; k + 1 < vals.length; k++) {
      const t = (vals[k] + vals[k + 1]) / 2;
      for (const dir of [1, -1]) {
        const acc = X.filter((x, i) => ((dir * (x[j] - t) > 0 ? 1 : 0) === Y[i])).length / X.length;
        if (acc > best.acc) best = { j, t, dir, acc };
      }
    }
  }
  return { predict: (x: number[]) => (best.dir * (x[best.j] - best.t) > 0 ? 1 : 0), ...best };
}

interface Counts { tp: number; fp: number; tn: number; fn: number }
const add = (c: Counts, pred: number, truth: number) => {
  if (pred && truth) c.tp++; else if (pred && !truth) c.fp++; else if (!pred && truth) c.fn++; else c.tn++;
};
const metrics = (c: Counts) => {
  const n = c.tp + c.fp + c.tn + c.fn;
  const f = (x: number | null) => (x == null ? "n/a" : x.toFixed(2));
  return {
    n, acc: f(n ? (c.tp + c.tn) / n : null), precision: f(c.tp + c.fp ? c.tp / (c.tp + c.fp) : null), recall: f(c.tp + c.fn ? c.tp / (c.tp + c.fn) : null),
    confusion: `TP ${c.tp} FP ${c.fp} TN ${c.tn} FN ${c.fn}`,
  };
};

const recs = [...new Set(real.map((r) => r.recording_id))];
const models = ["engine_flag (fixed rules)", "logistic regression", "decision stump", "majority class"] as const;
const pooled: Record<string, Counts> = Object.fromEntries(models.map((m) => [m, { tp: 0, fp: 0, tn: 0, fn: 0 }]));
const perFold: { recording: string; n: number; swing: number; results: Record<string, ReturnType<typeof metrics>>; stump: string }[] = [];
const loosePreds: { id: string; engine: boolean; logreg: number; stump: number }[] = [];

for (const held of recs) {
  const train = real.filter((r) => r.recording_id !== held);
  const test = real.filter((r) => r.recording_id === held);
  const X = train.map(feats), Y = train.map(y);
  const lr = trainLogreg(X, Y);
  const st = trainStump(X, Y);
  const majority = Y.filter((v) => v === 1).length > Y.length / 2 ? 1 : 0;
  const fold: Record<string, Counts> = Object.fromEntries(models.map((m) => [m, { tp: 0, fp: 0, tn: 0, fn: 0 }]));
  for (const r of test) {
    const preds: Record<string, number> = {
      "engine_flag (fixed rules)": r.engine_flag ? 1 : 0,
      "logistic regression": lr.predict(feats(r)) >= 0.5 ? 1 : 0,
      "decision stump": st.predict(feats(r)),
      "majority class": majority,
    };
    for (const m of models) { add(fold[m], preds[m], y(r)); add(pooled[m], preds[m], y(r)); }
  }
  for (const r of loose.filter((x) => x.recording_id === held)) loosePreds.push({ id: r.id, engine: r.engine_flag, logreg: +lr.predict(feats(r)).toFixed(2), stump: st.predict(feats(r)) });
  perFold.push({
    recording: held, n: test.length, swing: test.filter((r) => y(r)).length,
    results: Object.fromEntries(models.map((m) => [m, metrics(fold[m])])),
    stump: `${FEATURES[st.j]} ${st.dir > 0 ? ">" : "<"} ${st.t.toFixed(3)}`,
  });
}
// loose reps from recordings with no strict/swing rows (none today) would be skipped; say so if it happens
const full = trainLogreg(real.map(feats), real.map(y));

const md: string[] = [];
md.push("# Baseline: strict vs swing from engine features (v1)", "");
md.push(`Real labelled reps only: **${real.length}** (${real.filter((r) => y(r)).length} swing, ${real.filter((r) => !y(r)).length} strict) from **${recs.length}** recordings. Synthetic rows are not used. Leave-one-recording-out: each recording is held out once, the models train on the rest.`, "");
md.push(`Features (absolute, per rep, the rep's own arm; no clean reference): ${FEATURES.map((f) => "`" + f + "`").join(", ")}. Logistic regression: standardized, L2 0.1, 3000 GD steps, threshold 0.5. Stump: best single feature/threshold on the training folds.`, "");
md.push("## Pooled over the held-out folds (positive = swing)", "", "| Model | n | Accuracy | Precision | Recall | Confusion |", "|---|---|---|---|---|---|");
for (const m of models) { const x = metrics(pooled[m]); md.push(`| ${m} | ${x.n} | ${x.acc} | ${x.precision} | ${x.recall} | ${x.confusion} |`); }
md.push("", "## Per held-out recording", "", "| Held out | n (swing) | engine acc | logreg acc | stump acc | stump rule learned |", "|---|---|---|---|---|---|");
for (const f of perFold) md.push(`| ${f.recording} | ${f.n} (${f.swing}) | ${f.results["engine_flag (fixed rules)"].acc} | ${f.results["logistic regression"].acc} | ${f.results["decision stump"].acc} | ${f.stump} |`);
md.push("", "## Mike's \"loose\" rep (not in the metrics)", "");
for (const l of loosePreds) md.push(`- \`${l.id}\`: engine flag ${l.engine}, logreg P(swing) ${l.logreg}, stump ${l.stump ? "swing" : "strict"}`);
md.push("", "## Logistic regression trained on all real rows (standardized weights)", "", "| Feature | Weight |", "|---|---|");
FEATURES.forEach((f, j) => md.push(`| ${f} | ${full.w[j].toFixed(2)} |`));
md.push("", "## Read this before quoting a number", "",
  "- **Tiny:** one person, 5 recordings, 2 days. Each fold is one recording, so one odd recording moves the pooled numbers a lot.",
  "- **The engine is not a held-out model.** Its thresholds were tuned by hand on these same real recordings (Nov 13 band, both Nov 14 35 lb files), so its row is closer to a training score than a test score. Only the live sessions (r82, zdw) were recorded after the last threshold change; they are its fairest test.",
  "- **Labels are instructions, not observations**, except the live r82/zdw sets, which Mike labelled per rep. A rep in a \"swing\" phase can be a light or failed swing.",
  "- **The engine has state the classifier lacks:** it compares each rep with the lifter's own clean reps in the session. The classifier sees one rep at a time, in absolute %MVC, which depends on pad placement and calibration.",
  "- Synthetic rows are deliberately excluded: they are generated to match the engine's rules, so scoring on them would be circular.", "");
writeFileSync(path.join(DATA, "baseline.md"), md.join("\n"));
writeFileSync(path.join(DATA, "baseline.json"), JSON.stringify({ n_real: real.length, recordings: recs, features: FEATURES, pooled: Object.fromEntries(models.map((m) => [m, metrics(pooled[m])])), per_fold: perFold, loose: loosePreds }, null, 2) + "\n");
console.log(md.join("\n"));
