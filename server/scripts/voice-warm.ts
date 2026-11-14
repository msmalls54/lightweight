// npm run voice:warm  -> generate every missing coach clip and report what's still missing. Never plays audio.
//   Gemini TTS first; a clip that fails on Gemini is generated with ElevenLabs (if ELEVENLABS_API_KEY is set).
//   --provider elevenlabs   regenerate ALL clips with ElevenLabs (one voice for every clip)
//   --dir <path>            cache dir (default server/.cache/voice)
//   --check                 only report, don't generate
// Exit code 1 if any clip is missing.
import { CLIPS, DEFAULT_VOICE_CACHE, loadElevenKey, loadGeminiKey, missingClips, warmVoice } from "../src/voice/index.js";
import { voiceId } from "../src/voice/models.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dir = arg("--dir") ?? DEFAULT_VOICE_CACHE;
const provider = arg("--provider") === "elevenlabs" ? "elevenlabs" : undefined;
const allChars = Object.values(CLIPS).reduce((a, t) => a + t.length, 0);
const gemini = loadGeminiKey();
const eleven = loadElevenKey();

const before = missingClips(dir);
console.log(`${Object.keys(CLIPS).length} clips (${allChars} characters) | cache ${dir}`);
console.log(`providers: gemini ${gemini ? `yes (voice ${voiceId()})` : "no key"}, elevenlabs ${eleven ? "yes" : "no key"}`);
console.log(`missing before: ${before.length ? before.join(", ") : "none"}`);

if (!process.argv.includes("--check") && (before.length || provider)) {
  if (provider === "elevenlabs" && !eleven) {
    console.error("ELEVENLABS_API_KEY not found (.env at the repo root)");
    process.exit(1);
  }
  if (!gemini && !eleven) {
    console.error("No TTS key found: GEMINI_API_KEY or ELEVENLABS_API_KEY in the repo-root .env");
    process.exit(1);
  }
  const r = await warmVoice({
    apiKey: gemini ?? "",
    cacheDir: dir,
    keys: provider ? Object.keys(CLIPS) : before,
    provider,
    concurrency: 2,
    attempts: 4,
    backoffMs: 2000,
  });
  const by = Object.entries(r.byProvider).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  console.log(`generated ${r.generated} (${by}) in ${Math.round(r.ms / 1000)} s; ElevenLabs characters this run: ${r.chars.elevenlabs ?? 0}`);
}
const after = missingClips(dir);
console.log(after.length ? `STILL MISSING (${after.length}): ${after.join(", ")}` : "all clips cached");
process.exit(after.length ? 1 : 0);
