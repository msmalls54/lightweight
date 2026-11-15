# Lightweight

**A wearable that lets an AI coach feel your muscles and call out your cheat reps out loud.**

**3rd place, Google DeepMind track (Best Use of Gemini 4), VexoHacks 2026.** 48 projects entered the track.

**Demo video (1:51):** https://youtu.be/IrWhJGBbjtQ

![Lightweight: rep 5 flagged, the left front delt took over](docs/submission/cover-1500x1000.png)
<sub>Rep 5 of a real set: four clean reps, then the left front delt takes over and the rep is flagged.</sub>

## What it does

- **Feels the lift.** Four MyoWare 2.0 EMG sensors read the left and right **biceps** (the target) and the left and right **front delts** (the cheat check) at 200 Hz.
- **Catches the swing.** When you swing a curl up, your front delt starts the weight. The signal engine compares each rep's up phase with your own clean reps and flags the cheat ("delt took over").
- **A voice coach in your speaker or earbuds.** The coach (Gemini TTS, voice *Alnilam*) talks through any Bluetooth speaker or earbuds paired to the laptop (we used a Skullcandy Ounce+ clipped to a tank strap), ducking your music: "Rep six. Your delt took over." Call-outs are pre-generated clips, so they're instant mid-set. Voice commands ("start set", "stop", "how's my workout") keep it hands-free: private coaching in your ears, no screen needed. Today the laptop stands in for a phone: the voice commands use the laptop's mic (a Bluetooth headset mic would force low-quality call audio), and there's no phone app yet.
- **Knows you.** A coach brain (**Gemini 4 Hydrogen**) gets one context packet: your profile, your plan (35 lb stays 35 lb; progress means more clean reps), today's sets and your last session. After each set it writes a short analysis of that set (which reps, why, tempo, left vs right, what to do next), so the feedback is more than a canned line. Code computes every number; Gemini only words it.
- **Any lift is a config entry.** A Lift library shows each lift's target muscle and cheat-check muscle on front and back body maps. Curls are live today; the rest are marked "config ready, not yet tested".
- **A dataset for Gemma.** `data/dataset/v2/`: 2,428 reps (85 real, 2,343 synthetic). A classifier trained on the synthetic reps alone scored 0.96 accuracy on the 26 real test reps. Nothing is fine-tuned yet.
- **Lets Claude see your body.** An MCP server (mcp-use) exposes your reps, sets, L/R balance and history as tools, plus a **muscle-map widget**: a front-body map with the four sensed muscles shaded by effort and a per-rep scrubber.

## The proof (real recordings)

Three real recordings, replayed through the engine in `server/tests/engine-real.test.ts` (all green). Raw CSVs are in `data/coach/history/raw/`.

| Recording | Strict reps | Swing reps | What separates them |
|---|---|---|---|
| Nov 13, band curls, right arm | 3 reps, **0 flagged** | 4 reps, **3 flagged** | delt share per rep: **0.093–0.098** strict vs 0.22–0.66 swing (mean **0.48**) |
| Nov 14, 35 lb dumbbell, right arm | 5 reps, **0 flagged** | 3 reps, **3 flagged** | up-phase delt/biceps ratio: **0.41–0.76** strict vs **1.04–1.31** swing |
| Nov 14, 35 lb dumbbells, both arms | 7 reps, **0 flagged** | 6 reps, **5 flagged** | right delt mean %MVC: 0.45–0.52 strict vs 0.75–0.86 swing |

Why the up phase: on heavy strict curls the front delt works too, but mostly on the way *down*, to hold the shoulder still. A swing fires it on the way *up*. Whole-rep numbers blur the two under load (35 lb: delt share 0.35–0.46 strict vs 0.51–0.54 swing). The up-phase ratio separates them (worst strict rep 1.08× its reference, weakest swing 1.47×, threshold 1.35×). The swings that weren't flagged were light swings at strict-level delt effort. Details: [`server/src/engine/README.md`](server/src/engine/README.md).

## Why the data matters

Most AI coaching is trained on text: articles, textbooks and forum posts about how a lift should look. Lightweight produces something different: measurements of what a real body did.

Every rep is stored as a labelled example: four muscle channels at 200 Hz, the up and down phase, tempo, left against right, and a clean or cheat verdict from code. Every raw batch is kept, so any session can be replayed or re-labelled later.

That is training data, not reference material. `data/dataset/v2/` holds 2,428 reps (85 real, 2,343 synthetic from a generator fitted to the real ones) plus chat-format files ready for a Gemma fine-tune. A classifier trained on the synthetic reps alone scored 0.96 accuracy on the real test reps. Nothing is fine-tuned yet, and the real reps so far come from one person and one lift; the dataset and baseline are the starting point, and it grows with every set anyone lifts.

## Architecture

```mermaid
flowchart LR
  S["4x MyoWare 2.0 EMG (ENV)<br/>R/L biceps, R/L front delt"] -->|TRS cables| U["Arduino UNO R4 WiFi<br/>200 Hz, 14-bit"]
  U -->|"HTTP POST every 200 ms<br/>iPhone hotspot 2.4 GHz"| R["/ingest + /heartbeat"]
  subgraph Laptop["Laptop server (Node + TypeScript, mcp-use)"]
    R --> DB[("SQLite<br/>raw batches, reps, sets")]
    R --> E["Signal engine (pure code)<br/>calibration, reps, cheat flags"]
    E -->|SSE| D["Dashboard<br/>bars, muscle map, rep feed"]
    E --> C["Cue picker (code)"] --> V["Voice: Gemini TTS clips<br/>music ducking"]
    E --> H["Coach brain: Gemini 4 Hydrogen<br/>profile + plan + history"]
    DB --> M["MCP tools + muscle-map widget"]
  end
  M --> A["Claude / ChatGPT"]
```

Every raw batch is stored, so any session can be **replayed** through the same pipeline at real speed. The dashboard, voice and MCP tools behave exactly as if it were live, which makes a replay the demo fallback.

## Hardware

| Qty | Part |
|---|---|
| 4 | SparkFun MyoWare 2.0 Muscle Sensor (DEV-27924), output on **ENV** |
| 4 | MyoWare 2.0 Link Shield (DEV-18425) + 1 m 3.5 mm TRS cable |
| 1 | MyoWare 2.0 Arduino Shield (DEV-18426) |
| 1 | Arduino UNO R4 WiFi (ABX00087) |
| 3 per sensor | 24 mm snap electrodes (single use) |
| 1 | USB-C power bank: **on-body electronics run on battery only** |
| 1 | Bluetooth speaker (coach voice + music) |

No soldering: everything snaps, plugs or stacks. Channel map: A0 R biceps, A1 R front delt, A2 L biceps, A3 L front delt. Placement and setup: [`HARDWARE-SETUP.md`](HARDWARE-SETUP.md).

## Run it

### Server (works without hardware)
```bash
cd server
npm ci --prefer-offline   # on Windows without Visual Studio: add --ignore-scripts (better-sqlite3 ships prebuilt binaries)
npm run dev               # http://localhost:3000/  (dashboard), /mcp (MCP), /inspector (mcp-use inspector)
```
Put `GEMINI_API_KEY=...` in a `.env` at the repo root for voice and coach lines. The first start generates the voice clips (~80 s), and later starts load them from `server/.cache/voice/`. Without a key, the dashboard and engine still work: the coach falls back to code-written lines, and the dashboard uses browser speech if the voice player is missing. Add `?mute=1` to the dashboard URL to log call-outs instead of playing them.

**No-hardware run:** a synthetic UNO does a calibration, 5 clean curls, then 3 swings:
```bash
npx tsx scripts/fake-device.ts            # flags: --arms R, --clean N --swing N, --loop, --raw
```

**Replay** a recorded session: pick it in the dashboard's Replay box, or
```bash
curl -X POST "http://127.0.0.1:3000/replay/<session_id>?speed=1"   # session ids: GET /sessions
```

**Tests:** `npm test` (engine on the 3 real recordings, synthetic fixtures, coach, voice) and `npm run typecheck`.

### Firmware
```bash
cp firmware/lightweight/arduino_secrets.example.h firmware/lightweight/arduino_secrets.h   # Wi-Fi SSID/password, LAPTOP_IP (hotspot: 172.20.10.2), port 3000
arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi firmware/lightweight
arduino-cli upload -p COM8 --fqbn arduino:renesas_uno:unor4wifi firmware/lightweight      # electrodes OFF the skin while on USB
```
The UNO is 2.4 GHz only, so use a phone hotspot. It samples in a timer interrupt, POSTs 40-sample batches every 200 ms, queues ~8.6 s offline and sends a heartbeat every 2 s. When it falls behind it bundles up to 8 batches into one POST, which took live lag from 5–15 s to under a second at the venue. More detail: [`firmware/README.md`](firmware/README.md).

### Connect Claude (MCP)
The MCP endpoint is `http://localhost:3000/mcp` (streamable HTTP, stateless). For example, with Claude Code:
```bash
claude mcp add --transport http lightweight http://localhost:3000/mcp
```
Tools: `start_session`, `log_exercise`, `get_reps`, `show_last_set` (muscle-map widget), `compare_arms` (widget), `compare_curls`, `challenge_status`, `get_coach_context`, `get_history`, `update_plan`. Ask: *"Which rep did I cheat, and which arm is weaker?"* Verified in Claude itself (a claude.ai custom connector over a token-gated tunnel) and in the mcp-use inspector (`/inspector`).

The server only accepts `/ingest` and `/heartbeat` from the network (the UNO). Everything else (dashboard, control routes, MCP) answers to this laptop only.

## Design rules

- **Code decides, the LLM explains.** Thresholds in `server/src/engine/config.ts` flag reps, and code picks the call-out clips and the set decision. Gemini only phrases them and answers questions, and it is never asked whether a rep was a cheat. A coach line that suggests changing the weight is replaced by a code-written one.
- **Relative, not medical.** Readings are %MVC from a calibration (relax, then flex each muscle; saved and adjusted automatically after that), plus shares between muscles. Not force, not muscle growth, not a medical device.
- **Walk-ups don't get Mike's coaching.** A walk-up gets a blank coach profile, a generic plan and no history, and their sets are never written into Mike's history.
- **Honest map.** Only the four sensed muscles get shaded; everything else on the body map stays gray. Hammer curls use the forearm, which we don't sense, so the coach says "less biceps", never "forearm took over".

## Built at VexoHacks

Built solo in one day at **VexoHacks, November 14, 2026**, where it placed **3rd in the Google DeepMind track** (Best Use of Gemini 4). Built with **Claude Code** (parallel sessions for firmware, signal engine, server and voice/coach) and **Google Gemini** (Gemini 4 Hydrogen for the coach, Gemini TTS for the voice, with ElevenLabs as a fallback voice and for the demo video's narration). Muscle-map body art is from [react-body-highlighter](https://github.com/GV79/react-body-highlighter) (MIT, license in `assets/muscle-map/`).
