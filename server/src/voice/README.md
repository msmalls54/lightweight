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
// per SetEndEvent: cue = pickSetEndCueSequence(set) -> LWAudio.playClip(cue)   e.g. ["set_done","three_cheats","big_swing"] (instant, cached)
//   ctx = buildCoachContext({ person, todaySets, setMeta: store.todaySetMeta(person) })
//   line = await summarizeSet(ctx, set) (<= 25 words) -> dashboard: LWAudio.coachText(set_id, line)
//   server speak(line) -> dashboard: LWAudio.coachAudio(set_id, { ok, text, fallback_clip })
//   card = await summarizeSetDetail(ctx, set)
// session end (Mike only): writeTodayHistory(todaySets, { person, setMeta })
```
- Summary text is capped at 25 words (shown on screen); only `spokenPart(line)` (first sentence, <= 15 words) is spoken. Pre-TTS exactly that: `speak(spokenPart(line))`, and send it as `spoken` in coach_audio.
- Live TTS (`speak`, `/voice/say`) tries `SAY_TTS_MODELS` (flash-tts first, 8 s per model); clips keep `TTS_MODEL`.
- `speak()` dedups concurrent requests for the same text, so the server's pre-TTS and the speaker tab's `/voice/say` share one Gemini call.
- `pickCue(rep)` returns one key (BUILD.md contract); `pickCueSequence` stitches the rep number in front of a flag.
- Cache lives in `server/.cache/voice/` (gitignored) + `clips.json` manifest; a clip regenerates only if its text or
  voice changes. Copy that folder between checkouts to skip the first ~80 s generation.
- A missing clip is generated on demand by `GET /voice/clip/:key.wav`.
- `summarizeSet` / `answer` never throw: on API failure, timeout (12 s), or a line that mentions changing the weight,
  they return a code-written line (`fallbackSummary`).
- Walk-ups (`person` ≠ profile name): blank profile, generic plan, no history; `writeTodayHistory` skips them.

## Browser (`public/voice-player.js`)
`window.LWAudio = { setMusic(el), setMusicVolume(v), playClip(key | keys[]), say(text), coachText(setId, text), coachAudio(setId, msg), cooldownMs: 3000, fallbackMs: 5000, unlock(), isSpeaking() }`.

**Slow-TTS fallback:** `coachText` starts a 5 s clock when the coach text arrives; if `coachAudio` hasn't come by
then, the browser speaks the text (`speechSynthesis`, en-US male voice if available, rate 1.05, same ducking) and the
late Gemini audio is skipped. `say(text)` has the same 5 s guard on its own fetch. Never both, never overlapping.
Set-end sequences (first key `set_done`) wait their turn instead of being dropped by the cooldown.
Preloads every clip into Web Audio buffers on load. Voice ducks music to 20% over 150 ms, restores over 400 ms
(music volume ramp on the element, so music never goes silent if the AudioContext is suspended). Call-outs inside the
3 s cooldown or while a voice is playing are dropped; `say()` waits its turn. Emits `lwaudio` window events
(`start`/`end`/`drop`). Verified in a browser: 0.8 → 0.16 → 0.8, overlap dropped, stitched "Rep six. Your delt took
over." = 3.7 s including duck/restore.

## Tests / smoke
- `npx tsx --test tests/voice.test.ts tests/coach.test.ts` (Gemini mocked).
- `npx tsx scripts/voice-smoke.ts [--all]`: 3 live clips with latency, Hydrogen Q&A on the real Nov 13 history,
  a set summary, a walk-up answer; `--all` pre-generates every clip.

## Workout so far (`summarizeSession`)
```ts
summarizeSession(ctx, { logged?: LoggedLift[], sets?: { set, lift }[] }) -> Promise<SessionSummary>
// SessionSummary = { headline, bullets: string[3–5], focus_next, spoken (<= 20 words), totals: { sets, working_sets, reps, clean, cheats }, source: "gemini" | "code" }
```
`sets` defaults to `ctx.today.sets` + `ctx.today.setMeta`. Code computes the trend (cleaner/sloppier/steady over
working sets of 3+ reps), fatigue (first cheat rep in 6+ rep sets), which arm cheats, the best set, and picks
`focus_next`; Gemini phrases it. `answer(ctx, "how's my workout going?")` returns the `spoken` line.

## Backup voice (Gemini TTS flaky)
Set-end order: instant set-end clips -> **wait for the Gemini first sentence** (dashboard shows "Coach is
thinking…") -> only if Gemini **fails** (the server's TTS chain errors or times out: flash-tts then
flash-lite-tts, 8 s each, sent as `coach_audio` ok:false; or no `coach_audio` at all within 45 s) -> a summary
**stitched from cached Alnilam clips** (`buildClipSummary(set)`, pure code, <= 8 clips, e.g. "Rep four. And rep
eight. Right shoulder took over. Stop at the first cheat next set. Rest longer.") -> browser speechSynthesis only
if no clip is cached. One queue: never two voices.
- `LW_SUMMARY_VOICE=gemini|clips` (server env, default `gemini`): `clips` forces the stitched summary (for a demo
  when Google is down).
- The server adds `...coachVoiceExtras(e)` (`{ clips, voice_mode }`) to its `coach` events; app.js passes them to
  `LWAudio.coachText(setId, text, { clips, mode })`.
- Each set's tier is logged by the server: `[voice] set X: gemini 3.4 s` or
  `[voice] set X: gemini failed (timeout) -> clips 16.1 s` (the speaker tab POSTs `/voice/log`).
- `npm run voice:warm`: generates every missing clip (retries with backoff) and lists what's still missing
  (`--check` only reports). Exit code 1 if any clip is missing.

## ElevenLabs fallback (`src/voice/elevenlabs.ts`, `chain.ts`)
Live summaries/answers (`speak`, `/voice/say`): **Gemini flash-tts -> ElevenLabs -> stitched clips -> browser**.
ElevenLabs runs only when Gemini errors or times out. Plain fetch, no SDK: `POST /v1/text-to-speech/{voice}`,
`xi-api-key`, model `eleven_flash_v2_5`, 8 s timeout, `pcm_24000` (wrapped as WAV) -> `wav_24000` ->
`mp3_44100_128` (served as audio/mpeg) depending on what the plan allows.
- Keys (repo-root `.env`): `ELEVENLABS_API_KEY`; optional `ELEVENLABS_VOICE_ID` (else a premade male coach-style
  voice is picked from `GET /v1/voices`, else the docs' example voice `JBFqnCBsd6RMkjVDRZzb`), `ELEVENLABS_MODEL_ID`.
- `LW_TTS_PROVIDER=auto` (default: Gemini, then ElevenLabs) | `elevenlabs` (skip Gemini) | `gemini`.
- Without `ELEVENLABS_API_KEY` everything is exactly the Gemini-only path.
- `/voice/say` sends `x-lw-tts: elevenlabs; ms=1200; after=gemini timeout`; the per-set log reads
  `[voice] set X: gemini timeout -> elevenlabs 1.2 s`.
- `npm run voice:warm`: a clip that fails on Gemini is made with ElevenLabs (provider recorded in `clips.json`).
  `npm run voice:warm -- --provider elevenlabs` regenerates every clip in the ElevenLabs voice (57 clips = 1,038
  characters). Live check: `npx tsx scripts/voice-eleven-check.ts`.
