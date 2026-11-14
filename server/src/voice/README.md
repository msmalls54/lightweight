# ④ Voice + coach brain

Code decides (cheats, cues, training decisions). Gemini only phrases them.

## Models (checked with our key, Nov 14) — all in `src/voice/models.ts`
| Role | ID | Notes |
|---|---|---|
| Brain | `gemini-4-hydrogen` | Listed by `ai.models.list()`. `thinkingLevel: "LOW"` → ~2.4–3.1 s per answer (default thinking 3.5–8 s; `MINIMAL` is rejected). Fallback `gemini-3.8-flash`. |
| Voice | `gemini-3.8-flash-lite-tts` | ~2.2–2.5 s per line. Fallback `gemini-3.8-flash-tts` (~2.9 s). TTS models do **not** show in `models.list()` but work. |
| Voice name | `Algenib` ("Gravelly") | Override with env `LW_VOICE_ID` or `CUSTOM_VOICE_ID` (hook for a custom/replicated voice). |

**TTS gotcha:** `generateContent` + `speechConfig` now returns 400 (`Unknown name "speechConfig"`). TTS only works via
`ai.interactions.create(...)` on `apiVersion: "v1beta"` with `response_format: {type:"audio"}` and
`generation_config.speech_config: [{voice}]`. We ask for `audio/l16` (raw 24 kHz mono 16-bit PCM) and wrap it in our
own WAV header (`wav.ts`), then trim the ~300 ms of silence TTS pads on each side (`trimSilence`).

## Server wiring (for ③)
```ts
import { initVoice, registerVoiceRoutes, loadGeminiKey, DEFAULT_VOICE_CACHE } from "./src/voice/index.js";
import { buildCoachContext, pickCueSequence, pickSetEndCue, summarizeSet, answer, writeTodayHistory } from "./src/coach/index.js";

registerVoiceRoutes(server.app);                       // GET /voice/clips, GET /voice/clip/:key.wav, POST /voice/say
void initVoice({ apiKey: loadGeminiKey() ?? "", cacheDir: DEFAULT_VOICE_CACHE }); // don't await: ~80 s first time, instant once cached

// per RepEvent:   send pickCueSequence(rep, { variant }) to the dashboard -> LWAudio.playClip(keys)  e.g. ["rep_6","delt_took_over"]
// per SetEndEvent: LWAudio.playClip(pickSetEndCue(set)); then const line = await summarizeSet(buildCoachContext({ person, todaySets }), set) -> LWAudio.say(line)
// session end (Mike only): writeTodayHistory(todaySets, { person, setMeta })
```
- `pickCue(rep)` returns one key (BUILD.md contract); `pickCueSequence` stitches the rep number in front of a flag.
- Cache lives in `server/.cache/voice/` (gitignored) + `clips.json` manifest; a clip regenerates only if its text or
  voice changes. Copy that folder between checkouts to skip the first ~80 s generation.
- A missing clip is generated on demand by `GET /voice/clip/:key.wav`.
- `summarizeSet` / `answer` never throw: on API failure, timeout (12 s), or a line that mentions changing the weight,
  they return a code-written line (`fallbackSummary`).
- Walk-ups (`person` ≠ profile name): blank profile, generic plan, no history; `writeTodayHistory` skips them.

## Browser (`public/voice-player.js`)
`window.LWAudio = { setMusic(el), setMusicVolume(v), playClip(key | keys[]), say(text), cooldownMs: 3000, unlock(), isSpeaking() }`.
Preloads every clip into Web Audio buffers on load. Voice ducks music to 20% over 150 ms, restores over 400 ms
(music volume ramp on the element, so music never goes silent if the AudioContext is suspended). Call-outs inside the
3 s cooldown or while a voice is playing are dropped; `say()` waits its turn. Emits `lwaudio` window events
(`start`/`end`/`drop`). Verified in a browser: 0.8 → 0.16 → 0.8, overlap dropped, stitched "Rep six. Your delt took
over." = 3.7 s including duck/restore.

## Tests / smoke
- `npx tsx --test tests/voice.test.ts tests/coach.test.ts` (Gemini mocked).
- `npx tsx scripts/voice-smoke.ts [--all]`: 3 live clips with latency, Hydrogen Q&A on the real Nov 13 history,
  a set summary, a walk-up answer; `--all` pre-generates every clip.
