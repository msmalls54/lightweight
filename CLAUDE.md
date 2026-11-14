# Lightweight: an AI coach that can feel your muscles

Project name is **Lightweight** (earlier working name: Snitch). "Snitch" below still means the cheat-detector muscle (front delt), not the product.

Wearables hackathon, Saturday Nov 14 2026. Builder: Mike (solo).
One-liner: "A wearable that lets an AI coach feel your muscles and call out your cheat reps out loud. Try to beat it."
Story: Thump gave agents a sense of touch. This gives agents a sense of your body.

## The lift
One lift family, done well: **curls**. Mike's real-life lift is the **preacher curl** (EZ bar or DB). The demo is **standing band curls** (no preacher bench at the venue).
- Target: biceps (L/R). Snitch: front delt (L/R).
- Preacher cheat = **elbows lifting off the pad / shoulders rolling forward** to finish the rep -> delt fires. Standing cheat = **swing / lean back** -> delt fires.
- Imbalance L vs R biceps matters most on bilateral preacher curls (EZ bar).
- No pec, no push-ups, no lateral raises in this build.
- **Curl variants are first-class:** `preacher`, `standing` (DB/barbell/band), `hammer`. User names the variant per set; no auto-detection. Same rep/cheat logic for all; thresholds can differ per variant in config.
- Cross-variant comparison only within one calibration (same pads, same session), using %MVC. Hammer recruits forearm (brachioradialis), which we do NOT sense: say "less biceps", never "forearm took over".

## Hard rules
- **All project code is written at the event.** This file is the plan, not code. Don't assume any project code exists before Saturday. The dev toolchain is already installed (see Machine setup).
- **No soldering.** Every hardware connection is snap, plug or Qwiic. If a plan needs soldering, change the plan.
- **On-body electronics run on battery only** (USB-C power bank). Never plug the worn UNO into a wall-powered laptop while electrodes are on skin. Flash firmware with the pads off.
- **Claim scope:** relative muscle activation (%MVC, share between muscles), not force, not "muscle growth", not medical. MyoWare isn't a medical device.
- **Code decides, agent explains.** Thresholds in code flag reps. The LLM writes the words and answers questions. Never let the LLM decide whether a rep was a cheat.
- Keep a **pre-recorded session** loaded as a demo fallback at all times.

## Hardware (all in hand)
| Qty | Part | Notes |
|---|---|---|
| 4 | SparkFun MyoWare 2 Muscle Sensor (DEV-27924) | Electrodes snap underneath; Link Shield snaps on top |
| 4 | MyoWare 2.0 Link Shield (DEV-18425) | **Output switch → ENV. Power switch → ON.** |
| 4 | 3.5mm stereo TRS cable, 1m | Link Shield → Arduino Shield |
| 1 | MyoWare 2.0 Arduino Shield (DEV-18426) | Pre-soldered headers, 6 TRS jacks wired to A0–A5. Power jumper default 5V (leave it) |
| 1 | Arduino UNO R4 WiFi (ABX00087) | Wi-Fi via onboard ESP32-S3 (`WiFiS3`); 12x8 LED matrix (`Arduino_LED_Matrix`); 14-bit ADC (`analogReadResolution(14)`) |
| 60 | 24mm snap electrodes (SparkFun SEN-12969) | 3 per sensor. Single use. Walk-ups get fresh pads |
| 1 | Skullcandy Ounce+ Bluetooth speaker | Coach voice + music. Clipped on tank strap |
| - | Power bank, USB-C cable, running belt, velcro ties, alcohol pads, tape, razor, resistance band with handles |

**No IMU and no LED strip in this build.** Reps come from the EMG envelope. On-body lights are the UNO's LED matrix.

### Channel map (label the cables!)
| Jack | Muscle | Role |
|---|---|---|
| A0 | Right biceps | Target (curl) |
| A1 | Right front delt | Snitch (cheat detector) |
| A2 | Left biceps | Target (curl) |
| A3 | Left front delt | Snitch |

Placement: center of the muscle belly, electrodes in line with the fibers. Shave, alcohol wipe, let it dry. UNO stack + power bank on the front of a running belt, LED matrix facing out. Cables run under the tank top, velcroed at the upper arm, slack coiled at the belt.

## Machine setup (done Nov 13, verified)
Already installed on this laptop; don't reinstall.
- **Arduino:** `arduino-cli` 1.5.1 + core `arduino:renesas_uno` 1.6.0. FQBN `arduino:renesas_uno:unor4wifi`. `WiFiS3`, `Arduino_LED_Matrix` (bundled) and `ArduinoJson` 7.4.3 compile together. Upload not yet tested (no board connected).
- **Node:** v24.15.0, npm 11.12.1. These are in the npm cache, so `npm install --prefer-offline` works on bad Wi-Fi: `mcp-use@1.34.8`, `better-sqlite3@13.0.3`, `zod@4.6.7`, `react`/`react-dom@19.3.1`, `@mcp-use/tunnel@0.2.2`, `@elevenlabs/elevenlabs-js@2.78.0`, `@google/genai@3.3.0`, dev: `tsx@4.23.15`, `typescript@5.9.3`, `@types/node@^22`, `@types/better-sqlite3@9.6.0`, `@types/react*@19.3.0`. Use helmet-agent's `overrides` block (`@modelcontextprotocol/sdk` 1.32.1, `@hono/node-server` 1.19.17, `hono` 4.13.13).
- **Tunnels:** `cloudflared` 2026.10.1 (quick tunnel, no account). `ngrok` 3.39.13 via winget; no authtoken configured yet.
- **Secrets** (ElevenLabs, Gemini, ngrok) go in `.env`, which is gitignored. Never commit keys.

## Network
UNO R4 WiFi is **2.4 GHz only**. Expect venue Wi-Fi to fail (same as Thump at YC). Plan: laptop or phone hotspot on 2.4 GHz; UNO joins that; laptop server listens on the hotspot IP.

## Architecture
```
MyoWare x4 (ENV) -> Arduino Shield -> UNO R4 WiFi
   UNO: sample 4ch @ 200 Hz, local smoothing, LED-matrix bars (no network needed)
   UNO -> HTTP POST batches (~5/s) over Wi-Fi -> laptop server
Laptop server (Node + TypeScript, same stack as helmet-agent):
   receiver -> SQLite (sessions/sets/reps/samples)
   signal engine: calibration, rep detection, scoring, flags (pure code)
   live dashboard (localhost): muscle map + bars + music player + voice
   voice: ElevenLabs TTS, music ducking (Web Audio)
   agent: Gemini writes call-outs/summaries, answers questions
   MCP server (mcp-use) + muscle-map widget -> Claude/ChatGPT
```

Reference repo for patterns (copy structure, not hit logic): `github.com/msmalls54/helmet-agent`
- `server/src/receiver.ts` (device POST ingest), `store.ts` (SQLite), `helmet-map.ts` + `server/resources/*/widget.tsx` (mcp-use widget pattern), `alert-policy.ts` / `alert-agent.ts` (code rules -> agent review), `ngrok-tunnel.ts`.
- `firmware/helmet_impact/WifiDelivery.cpp` shows queued delivery + heartbeat. It's ESP32 Arduino; port to `WiFiS3` for the UNO R4.

## Firmware spec (UNO R4 WiFi)
- `analogReadResolution(14)`; read A0–A3 at 200 Hz with a fixed timer, not `delay()`.
- ENV output is already rectified + smoothed. Light extra smoothing only (EMA, ~50 ms).
- Batch: `{device, seq, t0_ms, dt_ms, ch:[[a0..],[a1..],[a2..],[a3..]]}` POST every 200 ms. Queue up to ~10 s offline; drop oldest beyond that. Heartbeat every 2 s with RSSI and queue depth.
- LED matrix: 4 vertical bars (R bi, R delt, L bi, L delt), heights from that channel's %MVC once calibrated (raw scaled before). Updates locally at ~20 Hz so the on-body lights never wait for the network.
- Serial at 115200 prints the same values for bench testing.

## Signal engine spec (server, pure functions, unit-tested)
1. **Calibration (start of every session, per person):**
   - Rest baseline: 3 s relaxed, per channel -> `rest`.
   - MVC: 3 s max flex per muscle (curl hold for biceps, front raise hold for delt) -> `mvc`.
   - `pct = clamp((x - rest) / (mvc - rest), 0, 1.5)`. Everything downstream uses %MVC.
   - Reject calibration if mvc - rest is tiny (bad pad) and say which channel.
2. **Rep detection (curls), from the biceps channel of the active arm:**
   - Hysteresis: rep starts when biceps %MVC crosses up through `hi` (~0.35), ends when it drops below `lo` (~0.15).
   - Min rep duration ~0.6 s, min gap ~0.4 s. Tune on real data Saturday.
   - Rep window = start..end. Store peak and mean %MVC per channel in the window.
3. **Sets:** a set starts on the first rep; it ends after ~10 s without a rep. Exercise and weight come from the user ("curls, 30 lb") via dashboard or MCP.
4. **Per-rep scores:**
   - `delt_share = delt_mean / (delt_mean + biceps_mean)` for that arm.
   - **Cheat flag:** delt_share above the set's first-2-rep baseline by > ~0.15 OR delt peak %MVC > ~0.5. Thresholds live in one config file.
   - **Imbalance** (both arms on, bilateral curl or alternating): `R_bi_mean / (R_bi_mean + L_bi_mean)`; flag if outside 0.40–0.60.
   - **Fatigue drift:** trend of delt_share across reps; "from rep 6 on, delt took over" is the money insight.
5. Fixtures: write a synthetic generator (clean reps, swing reps, fatigue drift, a dead channel) so all logic is testable before the hardware is on.

## Voice + music
- Dashboard plays a playlist (local files) through the Bluetooth speaker.
- On a flagged rep: duck music to ~20% over 150 ms, play the call-out, restore over 400 ms.
- Latency trick: **pre-generate ElevenLabs clips** at startup for fixed phrases ("rep one" … "rep twenty", "delt took over", "elbows in", "clean rep", "left side's slacking") and stitch them, so mid-set call-outs don't wait on Gemini + TTS. Use live Gemini + TTS for set summaries and Q&A only.
- Cooldown: at most one call-out per ~3 s; never talk over yourself.
- Talking back uses the **laptop mic**, not the earbud/speaker mic (Bluetooth headset mode wrecks audio quality).
- Spotify ducking is a stretch goal only.

## Agent (Gemini)
- Use the current fast Gemini model; check the docs at the event, don't hardcode from memory.
- Inputs: structured rep/set records from SQLite. Output: one-line cue or short summary. Tone: blunt gym coach, no medical language.
- Q&A examples it must handle: "How was that set?", "Which rep did I cheat?", "Which arm is weaker?", "Compare my last two sets."

## MCP tools (mcp-use, same pattern as Thump)
| Tool | Does |
|---|---|
| `start_session` | person name, arm(s) in use; kicks off calibration flow |
| `log_exercise` | exercise + weight for the next set |
| `get_reps` | reps by session/set with %MVC, shares, flags |
| `show_last_set` | muscle-map widget for the last set (+ per-rep scrubber) |
| `compare_arms` | L vs R biceps share across sets |
| `compare_curls` | rank curl variants by biceps %MVC per rep, cheat rate, L/R balance (same session only) |
| `challenge_status` | beat-the-agent scoreboard |

Muscle-map widget: front body outline; tracked muscles (L/R biceps, L/R front delt) shaded red by %MVC; untracked muscles stay gray (never imply we measured them). Views: last rep, last set, session cumulative.

## Demo
1. You on stage: calibrate (15 s) -> strict curls, map lights biceps -> deliberate swing on the last reps -> music ducks, coach: "Rep 6, your delt took over" -> on-body LED bars show it -> ask Claude "which rep did I cheat and which arm is weaker?"
2. **Beat the agent:** a judge whispers "clean" or "cheat" before each rep; the agent calls it before the reveal. Goal 5/5.
3. Walk-ups: one arm, 2 sensors (biceps + delt), fresh pads, 60 s setup, 5 reps, scoreboard.

Sponsors: **ElevenLabs** (voice, the core), **Gemini/DeepMind** (agent brain; stretch: phone camera so it sees + feels the rep). Stripe optional: test-mode "$1 to challenge, beat it and get $5 back." Skip Brex.

## Priorities (cut from the bottom)
- **P0:** firmware streaming 4ch -> server -> SQLite; calibration; rep detection; cheat flag; pre-generated voice call-out; dashboard bars; pre-recorded fallback session.
- **P1:** muscle-map widget via MCP; Gemini summaries/Q&A; music ducking; LED matrix bars; imbalance.
- **P2:** challenge scoreboard; Stripe challenge; Gemini camera; Spotify.

Rough time-box: P0 by ~2 pm, P1 by ~5 pm, then freeze features and rehearse the blind test until it's reliable.

## Known gotchas
- Pads peel with sweat: fresh pads right before presenting; tape the cables, not the pads.
- Front delt and pec sit close together: crosstalk. We don't track pec, but keep delt pads high on the front of the shoulder.
- MyoWare 2 has a gain pot. If a channel saturates during MVC, turn gain down and recalibrate.
- If a channel reads flat: check Link Shield switches (ENV, ON), TRS cable seated, which jack.
- Bluetooth adds ~0.2 s of audio delay; fine for call-outs.
- Analog reads and Wi-Fi on the UNO R4 are separate chips; no ADC/Wi-Fi conflict like ESP32 ADC2.
