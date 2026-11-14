# BUILD.md: the contract for today's parallel build

Read CLAUDE.md first (plan, hard rules, verified numbers). This file says **who owns which files** and **exactly how the pieces talk**. If you need to change anything in this file, stop and ask Mike; other agents are coding against it.

Times (Nov 14): P0 by **12:30** (first live run), AI layer by **2:30**, feature freeze **3:30**, demo **5:00**.

## Ownership (touch only your files)

| Workstream | Owns | Branch |
|---|---|---|
| ① Firmware | `firmware/**` | `build/firmware` |
| ② Signal engine | `server/src/engine/**`, `server/tests/engine*.test.ts` | `build/engine` |
| ③ Server + dashboard | `server/index.ts`, `server/src/*.ts` (top level), `server/src/mcp/**`, `server/resources/**`, `server/public/index.html`, `server/public/app.js`, `server/tests/server*.test.ts` | `build/server` |
| ④ Voice + coach brain | `server/src/voice/**`, `server/src/coach/**`, `server/public/voice-player.js`, `server/tests/voice*.test.ts`, `server/tests/coach*.test.ts` | `build/voice` |

Shared, read-only for everyone: `server/package.json`, `server/package-lock.json`, `server/tsconfig.json`, `assets/**`, `data/coach/**` (only ④'s code may write `data/coach/history/<today>.json` at runtime), `CLAUDE.md`, `BUILD.md`. Need a new npm package? Ask; don't edit package.json yourself.

Secrets: `.env` at the repo root (`GEMINI_API_KEY`). Never print, log or commit it. Firmware Wi-Fi secrets: `firmware/lightweight/arduino_secrets.h` (gitignored); copy the values from `bench/hotspot_test/arduino_secrets.h`.

## Channel map (everywhere)
`ch[0]` A0 = **R biceps**, `ch[1]` A1 = **R front delt**, `ch[2]` A2 = **L biceps**, `ch[3]` A3 = **L front delt**. Raw values are 14-bit ENV, 0–16383. Rest ≈ 500–600, ENV ceiling ≈ 14,960.

## ① → ③ Firmware to server (HTTP over the hotspot)
Laptop `172.20.10.2`, port **3000**. Every 200 ms:

```http
POST /ingest   Content-Type: application/json
{"device":"lw-uno-1","seq":123,"t0_ms":845120,"dt_ms":5,"ch":[[a0...],[a1...],[a2...],[a3...]]}
```
- `ch` = 4 arrays of equal length (normally 40 samples = 200 ms at 200 Hz). `t0_ms` = device `millis()` of the first sample. `seq` increments per batch; a resend keeps its seq.
- Reply `200 {"ok":true}`. Server ignores duplicate `seq`s.

Every 2 s: `POST /heartbeat {"device":"lw-uno-1","seq":N,"uptime_ms":...,"rssi":-25,"queue":0,"fw":"0.1.0"}` → `200 {"ok":true}`.

Only `/ingest` and `/heartbeat` accept LAN callers; everything else is loopback-only (copy helmet-agent `receiver.ts`).

## ② Signal engine API (`server/src/engine/index.ts`): pure TypeScript, no I/O
```ts
export const CH = { R_BI: 0, R_DELT: 1, L_BI: 2, L_DELT: 3 } as const;
export type Arm = "R" | "L";
export type Variant = "standing" | "preacher" | "hammer";
export interface Batch { device: string; seq: number; t0_ms: number; dt_ms: number; ch: number[][] }
export interface Calibration { rest: number[]; mvc: number[]; ok: boolean; problems: string[] } // length-4 arrays
export interface SetContext { session_id: string; set_id: string; person: string; exercise: string; variant: Variant; load_lb?: number; arms: Arm[] }
export interface LiveFrame { type: "live"; t_ms: number; pct: number[] }            // ~20 Hz, %MVC 0..1.5 per channel
export interface RepEvent { type: "rep"; set_id: string; arm: Arm; rep: number; start_ms: number; end_ms: number;
  peak_pct: number[]; mean_pct: number[]; delt_share: number; baseline_delt_share: number | null;
  cheat: boolean; cheat_reason: "delt_share_jump" | "delt_peak" | null; r_share: number | null; up_ms: number; down_ms: number }
export interface CoachDecision { next: "continue" | "stop_at_first_cheat_rest_longer" | "slow_the_tempo"; reason: string } // load NEVER changes (35 lb constant)
export interface SetEndEvent { type: "set_end"; set_id: string; reps: RepEvent[]; clean: number; cheats: number; first_cheat_rep: number | null; decision: CoachDecision }
export type EngineEvent = LiveFrame | RepEvent | SetEndEvent;
export class Engine {
  constructor(config?: Partial<EngineConfig>);
  calibrate(rest: number[][], mvc: number[][]): Calibration;   // each: 4 arrays of raw samples (3 s windows)
  setCalibration(c: Calibration): void;
  startSet(ctx: SetContext): void;
  ingest(b: Batch): EngineEvent[];                              // call per batch; works before calibration (pct from raw/14960)
  endSet(): SetEndEvent | null;                                 // also auto-ends after ~10 s without a rep
}
```
Logic per CLAUDE.md "Signal engine spec": hysteresis hi 0.35 / lo 0.15, min rep 0.6 s, min gap 0.4 s; envelope decays slowly after hard reps, so tune `lo` and the gap on the real CSV. Cheat = delt_share > first-2-rep baseline + 0.15, OR delt peak > 0.5. Thresholds live in `server/src/engine/config.ts`. Tests: synthetic fixtures (clean, swing, fatigue drift, dead channel) + the real recording `data/coach/history/raw/2026-11-13-bench.csv` (must find 3 strict reps, delt_share ≈ 0.10, and 4 swing reps flagged, ≈ 0.46).

## ④ Voice + coach API
`server/src/voice/index.ts`:
```ts
export const CLIPS: Record<string, string>; // key -> text: rep_1..rep_20, delt_took_over, elbows_in, clean_rep, slow_it_down, left_slacking, right_slacking, set_done, stop_and_rest, nice_set, calibrate_relax, calibrate_flex
export async function initVoice(opts: { apiKey: string; cacheDir: string }): Promise<void>; // pre-generate all CLIPS once, cache WAVs to disk
export async function speak(text: string): Promise<Buffer>;   // live Gemini TTS -> WAV bytes
export function registerVoiceRoutes(app: Hono): void;         // GET /voice/clip/:key.wav, POST /voice/say {text} -> audio/wav
```
`server/src/coach/index.ts`:
```ts
export interface CoachContext { profile: unknown; plan: unknown; lastDay: unknown; today: { sets: SetEndEvent[]; checkin?: { sleep: number; energy: number; soreness: number } }; person: string; isWalkUp: boolean }
export function buildCoachContext(input: { person: string; todaySets: SetEndEvent[]; checkin?: CoachContext["today"]["checkin"] }): CoachContext; // reads data/coach/*; walk-ups get a blank profile and no history
export function pickCue(rep: RepEvent): string | null;        // clip key for an instant call-out (code, not LLM)
export async function summarizeSet(ctx: CoachContext, set: SetEndEvent): Promise<string>; // Gemini 4 Hydrogen, 1–2 sentences
export async function answer(ctx: CoachContext, question: string): Promise<string>;       // Hydrogen Q&A over the context
export function writeTodayHistory(sets: SetEndEvent[]): void;                             // data/coach/history/<date>.json
```
Model IDs: list them with the key (`ai.models.list()`), and put them in one constant. Brain = Gemini 4 Hydrogen; voice = `gemini-3.8-flash-lite-tts` (fallback `gemini-3.8-flash-tts`). TTS returns raw PCM 24 kHz mono 16-bit → wrap in a WAV header.

`server/public/voice-player.js` (plain browser JS, loaded by ③'s dashboard):
```js
window.LWAudio = { setMusic(audioElement), playClip(key), say(text), cooldownMs: 3000 }
// on any voice: duck music to 20% over 150 ms, play, restore over 400 ms; drop call-outs inside the cooldown; never overlap voices
```

## ③ Server + dashboard
`server/index.ts`: one `MCPServer` (`host: "0.0.0.0"`, port 3000, `stateless: true`), routes on `server.app` (Hono). SQLite at `data/lightweight.sqlite` (gitignored): sessions, sets, reps, batches (raw JSON per batch, for replay), heartbeats.
- Pipeline: `/ingest` → store batch → `engine.ingest` → events → SSE `GET /events` to the dashboard (+ `pickCue` → tell the dashboard which clip to play).
- Dashboard `GET /` (`server/public/index.html` + `app.js`): connection status (last heartbeat, RSSI), calibration flow (relax 3 s → flex each muscle 3 s, with the voice prompts), start/stop set (default: dumbbell curl, standing, 35 lb, person "Mike"; a walk-up button asks for a name), 4 live bars, the muscle map from `assets/muscle-map/anterior.json` (front view; person's right on the viewer's left; untracked muscles gray), a rep feed (clean/cheat), music file picker + `voice-player.js`.
- **Replay = demo fallback**: `POST /replay/:session_id` pushes stored batches back through the engine at real speed, so the dashboard, voice and MCP behave exactly as live.
- Until ②/④ merge, code against the interfaces above with your own throwaway stub in `server/src/stubs.ts` (delete at merge).
- P1 (after 12:30): MCP tools from CLAUDE.md (`start_session`, `log_exercise`, `get_reps`, `show_last_set`, `compare_arms`, `get_coach_context`, `get_history`, `update_plan`, `challenge_status`) + the `muscle-map` widget (`server/resources/muscle-map/widget.tsx`), copied from the helmet-agent pattern described in CLAUDE.md.

## ① Firmware
`firmware/lightweight/lightweight.ino` (+ `arduino_secrets.h`, gitignored). Spec: CLAUDE.md "Firmware spec". 200 Hz with a `micros()` timer, light EMA, batch per the format above, queue ~10 s offline, heartbeat every 2 s, retry Wi-Fi forever. **Skip the LED matrix** (the shield covers it); keep the Serial print. Compile: `arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi firmware/lightweight`. **Upload only after asking Mike** (pads must be off): `arduino-cli upload -p COM8 --fqbn arduino:renesas_uno:unor4wifi firmware/lightweight`. Until ③ exists, test against `node bench/ping_server.mjs`, or a tiny local POST logger of your own in `firmware/tools/`.

## Done = for each workstream
- ① compiles; after an upload, the laptop receives ~5 batches/s of 4×40 samples with no gaps for 5 minutes.
- ② `npm test` passes, including the real-CSV test.
- ③ `npm run dev` serves the dashboard; replaying a recorded session shows live bars, map, reps and cheat flags.
- ④ `initVoice` caches all clips; `voice-player.js` ducks music on a clip; `summarizeSet` and `answer` return sensible lines using the Nov 13 history.

Merge order at 12:30 (Claude in Mike's main session merges): ② engine → ④ voice/coach → ③ server → ① firmware, then the first live run.
