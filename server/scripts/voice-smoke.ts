// Live smoke test for ④ voice + coach brain. Hits the real Gemini API.
//   npx tsx scripts/voice-smoke.ts          3 clips + Hydrogen Q&A + spoken/detail summaries of Mike's real Nov 14 sets
//   (never plays audio: WAVs are written to server/.cache/voice-smoke/)
//   npx tsx scripts/voice-smoke.ts --all    also pre-generate every clip into server/.cache/voice
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIPS, DEFAULT_VOICE_CACHE, initVoice, loadGeminiKey, wavDurationMs } from "../src/voice/index.js";
import { geminiSynth } from "../src/voice/tts.js";
import { BRAIN_MODEL, TTS_MODEL, voiceId } from "../src/voice/models.js";
import { answer, buildCoachContext, fallbackSummary, summarizeSet, summarizeSetDetail, type SetEndEvent } from "../src/coach/index.js";

const key = loadGeminiKey();
if (!key) {
  console.error("GEMINI_API_KEY not found in .env");
  process.exit(1);
}
const outDir = fileURLToPath(new URL("../.cache/voice-smoke/", import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

console.log(`TTS ${TTS_MODEL} voice ${voiceId()} | brain ${BRAIN_MODEL}\n`);
const synth = geminiSynth({ apiKey: key });
for (const k of ["rep_6", "delt_took_over", "nice_set"]) {
  const t = Date.now();
  const wav = await synth(CLIPS[k]);
  const ms = Date.now() - t;
  fs.writeFileSync(path.join(outDir, `${k}.wav`), wav);
  console.log(`clip ${k.padEnd(15)} ${String(ms).padStart(5)} ms TTS  -> ${wavDurationMs(wav)} ms audio, ${wav.length} bytes  "${CLIPS[k]}"`);
}

const ctx = buildCoachContext({ person: "Mike", todaySets: [] });
const q = "How did my swing reps compare to my strict reps last time?";
let t = Date.now();
const a = await answer(ctx, q);
console.log(`\nQ: ${q}\nA (${Date.now() - t} ms): ${a}`);

// Mike's real live set (Nov 14 12:25, session s-1114-122526-r82). No audio playback: WAVs go to disk only.
const fx = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../src/coach/fixtures/real-session-s-1114-122526-r82.json", import.meta.url)), "utf8"),
) as { sets: { set_no: number; set_end: SetEndEvent; coach_line_at_the_time: string }[] };
const realSets = fx.sets.map((s) => s.set_end);
for (const s of fx.sets) {
  const sctx = buildCoachContext({ person: "Mike", todaySets: realSets.slice(0, s.set_no) });
  console.log(`\n=== real set ${s.set_no}: ${s.set_end.reps.length} reps, cheats ${JSON.stringify(s.set_end.reps.filter((r) => r.cheat).map((r) => r.rep))}`);
  console.log(`before:  ${s.coach_line_at_the_time}`);
  t = Date.now();
  const line = await summarizeSet(sctx, s.set_end);
  const tLine = Date.now() - t;
  console.log(`spoken (${tLine} ms, ${line.split(/\s+/).length} words, ${line === fallbackSummary(s.set_end) ? "CODE FALLBACK" : "gemini"}): ${line}`);
  t = Date.now();
  const wav = await synth(line);
  const ttsMs = Date.now() - t;
  fs.writeFileSync(path.join(outDir, `real-set-${s.set_no}-summary.wav`), wav);
  console.log(`  TTS ${ttsMs} ms -> ${wavDurationMs(wav)} ms of speech`);
  t = Date.now();
  const d = await summarizeSetDetail(sctx, s.set_end);
  console.log(`detail (${Date.now() - t} ms, source ${d.source}):\n  headline: ${d.headline}\n${d.bullets.map((b) => "  - " + b).join("\n")}\n  cue: ${d.cue}`);
}
const ctx2 = buildCoachContext({ person: "Mike", todaySets: realSets });
for (const q2 of ["Which rep did I cheat?", "Which arm is weaker?", "Compare my last two sets."]) {
  t = Date.now();
  const ans = await answer(ctx2, q2);
  console.log(`\nanswer "${q2}" (${Date.now() - t} ms): ${ans}`);
}

const walk = buildCoachContext({ person: "Priya", todaySets: [] });
t = Date.now();
console.log(`walk-up "How did I do last time?": ${await answer(walk, "How did I do last time?")}  [${Date.now() - t} ms]`);

if (process.argv.includes("--all")) {
  t = Date.now();
  await initVoice({ apiKey: key, cacheDir: DEFAULT_VOICE_CACHE });
  console.log(`\ninitVoice (all ${Object.keys(CLIPS).length} clips) took ${Date.now() - t} ms -> ${DEFAULT_VOICE_CACHE}`);
}
console.log(`\nclips written to ${outDir}`);
