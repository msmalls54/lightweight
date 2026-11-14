// Live check of the ElevenLabs fallback (needs ELEVENLABS_API_KEY in the repo-root .env). Never plays audio.
//   npx tsx scripts/voice-eleven-check.ts   -> chosen voice, 2 lines via ElevenLabs only: latency, format, size
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { elevenSynth, isMp3, isWav, loadElevenKey, wavDurationMs, ELEVEN_MODEL } from "../src/voice/index.js";

const key = loadElevenKey();
if (!key) {
  console.error("ELEVENLABS_API_KEY not found in the repo-root .env");
  process.exit(1);
}
const synth = elevenSynth({ apiKey: key });
const t0 = Date.now();
const voice = await synth.voice();
console.log(`voice ${voice} (${process.env.ELEVENLABS_VOICE_ID ? "from ELEVENLABS_VOICE_ID" : "picked from GET /v1/voices"}) in ${Date.now() - t0} ms | model ${process.env.ELEVENLABS_MODEL_ID ?? ELEVEN_MODEL}`);
const out = fileURLToPath(new URL("../.cache/voice-smoke/", import.meta.url));
fs.mkdirSync(out, { recursive: true });
let chars = 0;
for (const [i, line] of ["Rep four. Right shoulder took over.", "Reps 4 and 8: right shoulder at 9 times normal, that's a swing."].entries()) {
  const t = Date.now();
  const audio = await synth(line);
  chars += line.length;
  const fmt = isWav(audio) ? `wav, ${wavDurationMs(audio)} ms of speech` : isMp3(audio) ? "mp3" : "unknown";
  const f = `${out}eleven-${i + 1}.${isMp3(audio) ? "mp3" : "wav"}`;
  fs.writeFileSync(f, audio);
  console.log(`${Date.now() - t} ms -> ${fmt}, ${audio.length} bytes -> ${f}`);
}
console.log(`characters billed: ${chars}`);
