// npm run voice:warm  -> generate every missing coach clip (Gemini TTS, retries with backoff), then
// report which clips are still missing. Never plays audio. Exit code 1 if any clip is missing.
//   --dir <path>   cache dir (default server/.cache/voice)   --check   only report, don't generate
import { CLIPS, DEFAULT_VOICE_CACHE, initVoice, loadGeminiKey, missingClips } from "../src/voice/index.js";
import { voiceId } from "../src/voice/models.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dir = arg("--dir") ?? DEFAULT_VOICE_CACHE;
const before = missingClips(dir);
console.log(`voice ${voiceId()} | ${Object.keys(CLIPS).length} clips | cache ${dir}`);
console.log(`missing before: ${before.length ? before.join(", ") : "none"}`);
if (before.length && !process.argv.includes("--check")) {
  const key = loadGeminiKey();
  if (!key) {
    console.error("GEMINI_API_KEY not found (.env at the repo root)");
    process.exit(1);
  }
  const t = Date.now();
  await initVoice({ apiKey: key, cacheDir: dir, keys: before, concurrency: 2, attempts: 4, backoffMs: 2000 });
  console.log(`generation took ${Math.round((Date.now() - t) / 1000)} s`);
}
const after = missingClips(dir);
console.log(after.length ? `STILL MISSING (${after.length}): ${after.join(", ")}` : "all clips cached");
process.exit(after.length ? 1 : 0);
