// Live smoke test for ④ voice + coach brain. Hits the real Gemini API.
//   npx tsx scripts/voice-smoke.ts          3 clips + Hydrogen Q&A + set summary
//   npx tsx scripts/voice-smoke.ts --all    also pre-generate every clip into server/.cache/voice
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIPS, DEFAULT_VOICE_CACHE, initVoice, loadGeminiKey, wavDurationMs } from "../src/voice/index.js";
import { geminiSynth } from "../src/voice/tts.js";
import { BRAIN_MODEL, TTS_MODEL, voiceId } from "../src/voice/models.js";
import { answer, buildCoachContext, summarizeSet, type RepEvent, type SetEndEvent } from "../src/coach/index.js";

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

// A synthetic set like the demo: 7 reps, delt takes over from rep 6.
const rep = (n: number, cheat: boolean): RepEvent => ({
  type: "rep", set_id: "smoke", arm: "R", rep: n, start_ms: n * 2500, end_ms: n * 2500 + 1800,
  peak_pct: [0.95, cheat ? 0.7 : 0.18, 0, 0], mean_pct: [cheat ? 0.55 : 0.75, cheat ? 0.45 : 0.08, 0, 0],
  delt_share: cheat ? 0.45 : 0.1, baseline_delt_share: 0.1, cheat, cheat_reason: cheat ? "delt_share_jump" : null,
  r_share: null, up_ms: 800, down_ms: 1000,
});
const reps = [1, 2, 3, 4, 5, 6, 7].map((n) => rep(n, n >= 6));
const set: SetEndEvent = {
  type: "set_end", set_id: "smoke", reps, clean: 5, cheats: 2, first_cheat_rep: 6,
  decision: { next: "continue", reason: "2 cheat reps (plan allows 1) but delt took over after rep 5; same weight" },
};
const ctx2 = buildCoachContext({ person: "Mike", todaySets: [set] });
t = Date.now();
console.log(`\nsummarizeSet (${"…"}): ${await summarizeSet(ctx2, set)}  [${Date.now() - t} ms]`);
t = Date.now();
console.log(`answer "Which rep did I cheat?": ${await answer(ctx2, "Which rep did I cheat?")}  [${Date.now() - t} ms]`);

const walk = buildCoachContext({ person: "Priya", todaySets: [] });
t = Date.now();
console.log(`walk-up "How did I do last time?": ${await answer(walk, "How did I do last time?")}  [${Date.now() - t} ms]`);

if (process.argv.includes("--all")) {
  t = Date.now();
  await initVoice({ apiKey: key, cacheDir: DEFAULT_VOICE_CACHE });
  console.log(`\ninitVoice (all ${Object.keys(CLIPS).length} clips) took ${Date.now() - t} ms -> ${DEFAULT_VOICE_CACHE}`);
}
console.log(`\nclips written to ${outDir}`);
