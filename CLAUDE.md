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

> **Finding Nov 13 (night):** the MyoWare Arduino Shield **fully covers the UNO's LED matrix** once stacked. The matrix is NOT visible on-body. On-body light = each sensor's / Link Shield's built-in ENV LED (brightens with flex). Live bars move to the laptop dashboard + muscle-map widget. Treat "LED matrix bars" items below as dropped unless a workaround is found. Possible no-solder workaround: shield beside the UNO, wired with male-to-female jumper wires (5V, GND, A0–A3); check the shield's pin labels first.

> **Bench results Nov 13 (night), real sensors, ENV mode, 14-bit raw values:**
> - **Concept proven: the delt snitch works.** Same session, standing band curls, R biceps on A0, delt on A1:
>
>   | Phase | Biceps avg | Delt avg | Delt peak |
>   |---|---|---|---|
>   | Rest | ~570 | ~500 | ~550 |
>   | Strict curls | 5,876 | **1,092** | 3,697 |
>   | Cheat (swing) curls | 4,058 | **3,665** | 14,944 |
>
>   Rest-subtracted delt_share ≈ **0.10 strict vs ≈ 0.48 cheat**. Cheat reps also use less biceps (momentum).
> - **Rest baseline ≈ 500–600** per channel; ENV ceiling ≈ **14,960** (saturation). Biceps hard flex saturates at current gain: consider a gain turn-down (pot is likely under the Link Shield) or rely on calibration.
> - **Link Shield output switch is easy to misread.** A channel sitting flat at **~8,150 (half-scale)** = it's on RAW, not ENV. Slide the switch to the other end.
> - **Delt placement:** 2 finger-widths below the bony shoulder tip, on the bulge, pointing down the arm. Too close to the collarbone = almost no signal. Current spot reads side raise (10,131) > front raise (7,412), so it sits toward the middle delt; it still catches the swing.
> - Envelope decays slowly after a hard rep (relax phases right after flexing read high for 1–2 s). Rep-end hysteresis must allow for it.

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
- **Arduino:** `arduino-cli` 1.5.1 + core `arduino:renesas_uno` 1.6.0. FQBN `arduino:renesas_uno:unor4wifi`. `WiFiS3`, `Arduino_LED_Matrix` (bundled) and `ArduinoJson` 7.4.3 compile together. `ArduinoGraphics` 1.1.5 installed for matrix text.
- **UNO bench-tested Nov 13:** shows up on **COM8**, uploads in ~4 s. Wi-Fi module firmware 0.6.0 (= latest, no update needed); scans 2.4 GHz fine. Timing: 4-channel 14-bit `analogRead` = ~100 µs, LED matrix render = ~50 µs; a 200 Hz `micros()` loop with a matrix render every 10th tick ran 1000 ticks, worst 4 µs late, 0 missed. CPU is not a constraint.
- **Firewall:** inbound allow rules for `node.exe` already exist (Public profile, plus a TCP 3000 rule from helmet-agent), so the UNO can reach the laptop server over a hotspot.
- **Node:** v24.15.0, npm 11.12.1. These are in the npm cache, so `npm install --prefer-offline` works on bad Wi-Fi: `mcp-use@1.34.8`, `better-sqlite3@13.0.3`, `zod@4.6.7`, `react`/`react-dom@19.3.1`, `@mcp-use/tunnel@0.2.2`, `@elevenlabs/elevenlabs-js@2.78.0` (not used: voice is Gemini), `@google/genai@3.3.0`, dev: `tsx@4.23.15`, `typescript@5.9.3`, `@types/node@^22`, `@types/better-sqlite3@9.6.0`, `@types/react*@19.3.0`. Use helmet-agent's `overrides` block (`@modelcontextprotocol/sdk` 1.32.1, `@hono/node-server` 1.19.17, `hono` 4.13.13).
- **Tunnels:** `cloudflared` 2026.10.1 (quick tunnel, no account). `ngrok` 3.39.13 via winget; no authtoken configured yet.
- **Secrets** (Gemini, ngrok) go in `.env`, which is gitignored. Never commit keys.

## Network
UNO R4 WiFi is **2.4 GHz only**. Expect venue Wi-Fi to fail (same as Thump at YC). Plan: laptop or phone hotspot on 2.4 GHz; UNO joins that; laptop server listens on the hotspot IP.

**Verified at the venue (Nov 14, YC):** venue Wi-Fi "Y Combinator" is 5/6 GHz only, so the UNO can't use it. Working setup: iPhone hotspot **"iPhone (99)"** (2.4 GHz), laptop joined to it at **172.20.10.2**, UNO gets **172.20.10.4**. UNO → laptop HTTP on port 3000 works, round-trip **~90–165 ms**, RSSI -18 to -28. Credentials live only in the gitignored `bench/hotspot_test/arduino_secrets.h`; reuse that file's values for the real firmware's secrets.

## Architecture
```
MyoWare x4 (ENV) -> Arduino Shield -> UNO R4 WiFi
   UNO: sample 4ch @ 200 Hz, local smoothing, LED-matrix bars (no network needed)
   UNO -> HTTP POST batches (~5/s) over Wi-Fi -> laptop server
Laptop server (Node + TypeScript, same stack as helmet-agent):
   receiver -> SQLite (sessions/sets/reps/samples)
   signal engine: calibration, rep detection, scoring, flags (pure code)
   live dashboard (localhost): muscle map + bars + music player + voice
   voice: Gemini TTS (no ElevenLabs at this event), music ducking (Web Audio)
   agent: Gemini 4 Hydrogen writes summaries, answers questions
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
- **TTS = Gemini** (decided Nov 14 at the venue: no ElevenLabs here). Via `@google/genai`, response modality audio + `speechConfig.voiceConfig` with a prebuilt voice. Output is **raw PCM, 24 kHz, mono, 16-bit**: wrap it in a WAV header before playing. TTS model IDs seen Nov 14: `gemini-3.8-flash-lite-tts` (low latency, preferred), `gemini-3.8-flash-tts` (higher fidelity), `gemini-3.1-flash-tts-preview`. Check https://ai.google.dev/gemini-api/docs/speech-generation and use whatever the key accepts.
- Latency trick: **pre-generate Gemini TTS clips** at startup (cache the WAVs to disk so restarts are instant) for fixed phrases ("rep one" … "rep twenty", "delt took over", "elbows in", "clean rep", "left side's slacking") and stitch them, so mid-set call-outs don't wait on Gemini + TTS. Use live Gemini + TTS for set summaries and Q&A only.
- Cooldown: at most one call-out per ~3 s; never talk over yourself.
- Talking back uses the **laptop mic**, not the earbud/speaker mic (Bluetooth headset mode wrecks audio quality).
- Spotify ducking is a stretch goal only.

## Agent (Gemini)
- **Brain = Gemini 4 Hydrogen** (decided Nov 14: Google's fast, low-latency Gemini 4 model, built for agentic/high-throughput work; cheaper and faster than Gemini 4 Carbon). Get the exact model ID from `ai.models.list()` with our key or AI Studio; don't guess the string. Put it in one config constant.
- **Voice = a Gemini TTS model**, separate from Hydrogen (Hydrogen is text-only). Prefer the low-latency **`gemini-3.8-flash-lite-tts`**; fall back to `gemini-3.8-flash-tts` or whatever TTS ID the key accepts.
- Inputs: structured rep/set records from SQLite. Output: one-line cue or short summary. Tone: blunt gym coach, no medical language.
- Q&A examples it must handle: "How was that set?", "Which rep did I cheat?", "Which arm is weaker?", "Compare my last two sets."

## Coach context (the coach knows you, your plan, and last time)
A coach is only a coach if it remembers. Files in `data/coach/`:
- `profile.json`: who Mike is, main lift, goals, weak points, coaching style, sensor quirks (TODO fields for Mike).
- `plan.json`: program rules (rep range, max cheat reps, progression and deload rules, imbalance target) + today's planned sets.
- `history/YYYY-MM-DD.json`: one summary per day (per-set, per-rep %MVC, delt_share, takeaways). `history/2026-11-13.json` is **real**: last night's bench test (strict ≈ 0.10 delt share, swing ≈ 0.46), raw samples in `history/raw/`.

Server builds ONE context packet, `buildCoachContext()`, = profile + plan rules + today's planned vs done sets + the most recent history day's takeaways + the live/last set. It's passed to Gemini 4 Hydrogen for every summary/Q&A and exposed over MCP. At session end, the server writes today's `history/2026-11-14.json` from SQLite (code computes the numbers; Hydrogen may add one line of takeaways). Coach lines it should be able to say: "Last time your swing reps were 46% delt; today you're at 22%, nice." / "Plan says 10 reps; you cheated rep 7 and 8, so same weight next time."

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
| `get_coach_context` | the context packet above: profile, plan, today vs plan, last session |
| `get_history` | day summaries (default: last 7 days), incl. the real Nov 13 bench test |
| `update_plan` | change today's targets/weights (e.g. "bump band curls to 12 reps"); writes `plan.json` |

Muscle-map body art is ready in `assets/muscle-map/`: `anterior.json` = 33 front-view polygons (viewBox 0 0 100 200) tagged `muscle` + `side` (right/left/center, person's side; front view so person's right is on the viewer's left), extracted from react-body-highlighter@2.0.5 (MIT, license file alongside; keep it). `preview.html` shows the 4 tracked muscles shaded by %MVC with sliders. Draw polygons directly (the library itself lights both sides together, so don't use its component).
**mcp-use widget wiring (copy helmet-agent's pattern exactly):** React component at `server/resources/muscle-map/widget.tsx`; the tool declares `widget: { name: "muscle-map", invoking: "Opening the muscle map…", invoked: "Muscle map shown" }` and its handler returns `widget({ props: {...rep/set data...}, message: "<one-line summary for the model>" })` (import `MCPServer, widget` from `"mcp-use/server"`). Reference: helmet-agent `server/src/cloud-demo.ts` (`show_last_hit` → `resources/helmet/widget.tsx`). `show_last_set` and `compare_arms` should both return this widget. Keep heavy aggregation in SQLite, not in the widget.
Muscle-map widget: front body outline; tracked muscles (L/R biceps, L/R front delt) shaded red by %MVC; untracked muscles stay gray (never imply we measured them). Views: last rep, last set, session cumulative.

## Demo
1. You on stage: calibrate (15 s) -> strict curls, map lights biceps -> deliberate swing on the last reps -> music ducks, coach: "Rep 6, your delt took over" -> on-body LED bars show it -> ask Claude "which rep did I cheat and which arm is weaker?"
2. **Beat the agent:** a judge whispers "clean" or "cheat" before each rep; the agent calls it before the reveal. Goal 5/5.
3. Walk-ups: one arm, 2 sensors (biceps + delt), fresh pads, 60 s setup, 5 reps, scoreboard.

Sponsors: **Gemini/DeepMind** (agent brain **and** voice via Gemini TTS; stretch: phone camera so it sees + feels the rep). No ElevenLabs at this event. Stripe optional: test-mode "$1 to challenge, beat it and get $5 back." Skip Brex.

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
