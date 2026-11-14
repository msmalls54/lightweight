// Few-shot Gemma eval on held-out gemma_sft pairs (v1). Gemma only PHRASES the code's verdict; we score
// whether its line keeps that verdict, stays short, and avoids banned wording.
//
//   cd server && npx tsx scripts/gemma-eval.ts [--model gemma-4-26b-a4b-it] [--n 20] [--delay-ms 2500]
//
// Key: GEMINI_API_KEY from .env (found by walking up from the cwd; never printed). Small and rate-limited:
// one request at a time, a pause between requests, backoff on 429. Writes ../data/dataset/v1/gemma_eval.md
// and gemma_eval.jsonl.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { loadGeminiKey } from "../src/voice/env.js";
import { mentionsLoadChange, mentionsMedical, mentionsRawShare, mentionsRep, namesAllReps } from "../src/coach/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
// v1: one gemma_sft.jsonl (shots = synthetic rows, held out = real rows).
// v2 (--data ../data/dataset/v2): split files (shots = synthetic TRAIN rows, held out = real TEST rows).
const DATA = path.resolve(arg("--data", path.join(HERE, "../../data/dataset/v1")));
const V2 = existsSync(path.join(DATA, "gemma_sft_test.jsonl"));
const MODEL = arg("--model", "gemma-4-26b-a4b-it");
const N = Number(arg("--n", "20"));
const DELAY = Number(arg("--delay-ms", "2500"));

interface Msg { role: "user" | "model"; content: string }
interface Pair {
  id: string; kind: "rep_cue" | "set_summary"; source: string; recording_id: string; rep?: number; engine_flag?: boolean;
  cheat_reps?: number[]; total_reps?: number; messages: Msg[];
}
const load = (f: string) => readFileSync(path.join(DATA, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Pair);
const pairs = V2 ? [...load("gemma_sft_train.jsonl").filter((p) => p.source === "synthetic"), ...load("gemma_sft_test.jsonl")] : load("gemma_sft.jsonl");

// ---- split: few-shot examples come from SYNTHETIC rows only; the held-out set is REAL rows only (no overlap).
const pick = <T,>(xs: T[], k: number) => xs.slice(0, k);
const synthRep = pairs.filter((p) => p.source === "synthetic" && p.kind === "rep_cue");
const FEWSHOT: Pair[] = [
  ...pick(synthRep.filter((p) => p.engine_flag && /times/.test(p.messages[1].content)), 1),
  ...pick(synthRep.filter((p) => p.engine_flag && !/times/.test(p.messages[1].content)), 1),
  ...pick(synthRep.filter((p) => !p.engine_flag && /clean/i.test(p.messages[1].content)), 1),
  ...pick(synthRep.filter((p) => !p.engine_flag && /slacking|loose|slow/i.test(p.messages[1].content)), 1),
  ...pick(pairs.filter((p) => p.source === "synthetic" && p.kind === "set_summary" && (p.cheat_reps?.length ?? 0) > 0), 1),
  ...pick(pairs.filter((p) => p.source === "synthetic" && p.kind === "set_summary" && (p.cheat_reps?.length ?? 0) === 0 && (p.total_reps ?? 0) > 0), 1),
];
// Held out: real rep cues (every cheat first, then clean ones spread over recordings) + real set summaries.
const realRep = pairs.filter((p) => p.source === "real" && p.kind === "rep_cue");
const realSum = pairs.filter((p) => p.source === "real" && p.kind === "set_summary" && (p.total_reps ?? 0) > 0);
const nSum = Math.min(6, realSum.length, Math.floor(N * 0.3));
const cheats = realRep.filter((p) => p.engine_flag);
const cleans = realRep.filter((p) => !p.engine_flag);
const nRep = N - nSum;
const nCheat = Math.min(cheats.length, Math.ceil(nRep / 2));
const spread = <T,>(xs: T[], k: number) => (k >= xs.length ? xs : Array.from({ length: k }, (_, i) => xs[Math.floor((i * xs.length) / k)]));
const HELD: Pair[] = [...spread(cheats, nCheat), ...spread(cleans, nRep - nCheat), ...spread(realSum, nSum)];

// ---- scoring (same checks the coach uses on live LLM output)
const CHEAT_WORDS = /\b(cheat\w*|took over|swing\w*|swung)\b/i;
function score(p: Pair, line: string) {
  const words = line.trim().split(/\s+/).filter(Boolean).length;
  let verdict: boolean;
  if (p.kind === "rep_cue") {
    const saysCheat = CHEAT_WORDS.test(line) && !/\bno cheat/i.test(line);
    verdict = saysCheat === !!p.engine_flag && mentionsRep(line, p.rep!);
  } else {
    const cr = p.cheat_reps ?? [];
    verdict = cr.length
      ? CHEAT_WORDS.test(line) && namesAllReps(line, cr, p.total_reps ?? Math.max(...cr))
      : /\b(clean|no cheats?|strict|nice|good)\b/i.test(line) && !(CHEAT_WORDS.test(line) && !/\bno cheat/i.test(line));
  }
  const banned = [/snitch/i.test(line) && "snitch", mentionsRawShare(line) && "raw delt share", mentionsLoadChange(line) && "load change", mentionsMedical(line) && "medical"].filter(Boolean) as string[];
  return { verdict, words, short: words <= 20, banned, ok: verdict && words <= 20 && banned.length === 0 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const key = loadGeminiKey();
  if (!key) throw new Error("GEMINI_API_KEY not found in the environment or a .env above the cwd");
  const ai = new GoogleGenAI({ apiKey: key });

  // Confirm the model is served to this key (names only; nothing else is printed).
  const names: string[] = [];
  for await (const m of await ai.models.list()) if (m.name) names.push(m.name.replace(/^models\//, ""));
  const gemmas = names.filter((n) => /^gemma/i.test(n));
  if (!names.includes(MODEL)) throw new Error(`${MODEL} not in models.list for this key. Gemma models seen: ${gemmas.join(", ") || "none"}`);

  // Few-shot as alternating user/model turns (Gemma has no system role; the instruction is in each user turn).
  const shots = FEWSHOT.flatMap((p) => p.messages.map((m) => ({ role: m.role, parts: [{ text: m.content }] })));
  const results: { id: string; kind: string; target: string; output: string; s: ReturnType<typeof score>; t: ReturnType<typeof score>; ms: number; thoughts: number; error?: string }[] = [];
  for (const [i, p] of HELD.entries()) {
    if (i) await sleep(DELAY);
    const contents = [...shots, { role: "user", parts: [{ text: p.messages[0].content }] }];
    let output = "", error: string | undefined, ms = 0, thoughts = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const t0 = Date.now();
      try {
        // Gemma 4 thinks before answering (thought parts); give it room and keep only the answer parts.
        const r = await ai.models.generateContent({ model: MODEL, contents, config: { temperature: 0.3, maxOutputTokens: 2048 } });
        const parts = r.candidates?.[0]?.content?.parts ?? [];
        output = parts.filter((x) => !x.thought).map((x) => x.text ?? "").join("").trim().replace(/\s+/g, " ");
        thoughts = r.usageMetadata?.thoughtsTokenCount ?? 0;
        if (!output) throw new Error(`empty answer (finish ${r.candidates?.[0]?.finishReason})`);
        ms = Date.now() - t0;
        error = undefined;
        break;
      } catch (e) {
        error = String((e as Error)?.message ?? e).slice(0, 160);
        if (!/429|rate|quota|RESOURCE_EXHAUSTED|503|UNAVAILABLE|empty answer/i.test(error)) break;
        await sleep(5000 * (attempt + 1));
      }
    }
    const target = p.messages[1].content;
    results.push({ id: p.id, kind: p.kind, target, output, s: score(p, output), t: score(p, target), ms, thoughts, error });
    process.stdout.write(`${i + 1}/${HELD.length} ${p.kind} ${error ? "ERROR" : "ok"}\n`);
  }

  const rate = (xs: boolean[]) => `${xs.filter(Boolean).length}/${xs.length}`;
  const by = (k?: string) => results.filter((r) => !k || r.kind === k);
  const md: string[] = [];
  md.push(`# Gemma eval (${V2 ? "v2" : "v1"}): few-shot \`${MODEL}\``, "");
  md.push(`Generated by \`server/scripts/gemma-eval.ts\` on ${new Date().toISOString().slice(0, 10)}. ${FEWSHOT.length} few-shot pairs (synthetic${V2 ? " train-split" : ""} rows only), ${HELD.length} held-out pairs (real${V2 ? " TEST-split" : ""} rows only: ${by("rep_cue").length} rep cues, ${by("set_summary").length} set summaries). Temperature 0.3, one request at a time. No fine-tuning: this is the before-fine-tune baseline.`, "");
  md.push("Scores:", "", "- **verdict**: rep cue keeps the code's cheat/clean verdict and names the rep number; set summary names every cheat rep (or says the set was clean).", "- **≤ 20 words**.", "- **banned**: \"snitch\", a raw delt/shoulder percentage or \"delt share\", a load change, medical words (the coach's own output filters).", "- The target lines (code-written) go through the same scorer as a sanity check.", "");
  md.push("| Set | n | Verdict right | ≤ 20 words | No banned words | All three | Errors |", "|---|---|---|---|---|---|---|");
  for (const [name, k] of [["all", undefined], ["rep cues", "rep_cue"], ["set summaries", "set_summary"]] as const) {
    const xs = by(k);
    md.push(`| Gemma: ${name} | ${xs.length} | ${rate(xs.map((r) => r.s.verdict))} | ${rate(xs.map((r) => r.s.short))} | ${rate(xs.map((r) => !r.s.banned.length))} | ${rate(xs.map((r) => r.s.ok))} | ${xs.filter((r) => r.error).length} |`);
  }
  const all = by();
  md.push(`| Target lines (code) | ${all.length} | ${rate(all.map((r) => r.t.verdict))} | ${rate(all.map((r) => r.t.short))} | ${rate(all.map((r) => !r.t.banned.length))} | ${rate(all.map((r) => r.t.ok))} | - |`);
  const lat = all.filter((r) => r.ms).map((r) => r.ms).sort((a, b) => a - b);
  const th = all.map((r) => r.thoughts).sort((a, b) => a - b);
  if (lat.length) md.push("", `Latency per call: median ${lat[Math.floor(lat.length / 2)]} ms, max ${lat[lat.length - 1]} ms (cloud API, not on-device). Gemma 4 thinks before it answers: median ${th[Math.floor(th.length / 2)]} thinking tokens per call, so an on-device or low-latency use should turn thinking down or fine-tune.`);
  md.push("", "## Every output", "", "| id | target (code) | Gemma | verdict | words | banned |", "|---|---|---|---|---|---|");
  const esc = (x: string) => x.replace(/\|/g, "\\|");
  for (const r of results) md.push(`| \`${r.id}\` | ${esc(r.target)} | ${esc(r.error ? `ERROR: ${r.error}` : r.output)} | ${r.s.verdict ? "yes" : "**no**"} | ${r.s.words} | ${r.s.banned.join(", ") || "-"} |`);
  md.push("");
  writeFileSync(path.join(DATA, "gemma_eval.md"), md.join("\n"));
  writeFileSync(path.join(DATA, "gemma_eval.jsonl"), results.map((r) => JSON.stringify({ model: MODEL, ...r })).join("\n") + "\n");
  console.log(md.slice(0, 16).join("\n"));
}

main().catch((e) => {
  console.error(String((e as Error)?.message ?? e).replace(/key=[^&\s]+/gi, "key=***"));
  process.exit(1);
});
