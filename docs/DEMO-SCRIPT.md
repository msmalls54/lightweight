# Demo script: 3 minutes

Mike on stage, sensors on, 35 lb dumbbell (or band). Laptop on the projector showing the dashboard, Bluetooth speaker on.

## Pre-demo checklist (T-10 min)

- [ ] **Fresh pads** on all 4 sensors (shave, alcohol wipe, dry). Tape the cables, not the pads.
- [ ] Link Shields: **ENV** and **ON** (a flat ~8,150 on a channel = it's on RAW).
- [ ] **Power bank** charged and connected to the UNO. Laptop is NOT plugged into the worn UNO.
- [ ] **Phone hotspot** on, 2.4 GHz, **phone plugged in**. Laptop joined (172.20.10.2); dashboard shows a heartbeat and RSSI.
- [ ] `npm run dev` running (no hot reload). **One** dashboard tab, and it's the speaker tab.
- [ ] **Quiet mode OFF.** Speaker **paired**, volume up, music file picked and playing low.
- [ ] No calibration step needed (saved + automatic). Do one warm-up set so the max self-corrects; bars move on a test flex.
- [ ] Replay box: last good session selected, ready (fallback).
- [ ] Claude open with the Lightweight MCP connected (verified Nov 14; the tunnel link changes if the tunnel restarts, so re-add the connector then. Fallback: the screenshot).
- [ ] Screenshots on the desktop: muscle-map widget in Claude, a set report card.
- [ ] Judge briefed for beat-the-agent (whisper "clean" or "cheat" before each rep).

## Script

| Time | Beat | Say / do | On screen / audio | Fallback |
|---|---|---|---|---|
| 0:00–0:15 | **Hook** | "Every lifter cheats reps. A coach next to you sees it. Your phone can't. We gave an AI coach a sense of your body." | Dashboard, body map. | — |
| 0:15–0:35 | **Body on screen** | Point at the 4 sensors: "Biceps do the curl. The front delt is the cheat check: when you swing, the shoulder starts the weight." Flex once. | Biceps light up on the map, bars move. | No live signal: start **Replay** of the last good session, keep talking over it. |
| 0:35–1:05 | **Strict reps** | Curl 3–4 strict reps, slow. "Strict: biceps does the work." | Rep feed: clean, clean, clean. Music ducks for "Rep one / two / three". | Live set fails: **Replay**. No audio: **Quiet mode** text on screen, read it out. |
| 1:05–1:35 | **Swing** | Swing the next rep: lean back, shoulder up. | Coach: **"Rep 5. Your delt took over."** Music ducks; the front delt pulses red on the map; rep flagged in the feed. Set ends: "Set's done. One cheat rep." then the summary ("Rep 5: right shoulder at 8 times normal, that's a swing."). Report card appears. | Not flagged: show the Replay set with reps 4 and 8 caught at 7–9×. No audio: read the coach text on screen. |
| 1:35–1:55 | **"How's my workout?"** | Say it to the laptop mic (or press the button). | "29 of 40 reps clean so far. Rest of the session: end each set at the first cheat." "Workout so far" card. | Mic misses it: press the button. No audio: read the card. |
| 1:55–2:20 | **Ask Claude** | In Claude: "Which rep did I cheat, and which arm is weaker?" | Claude answers from the MCP tools; muscle-map widget with the per-rep scrubber. | Tunnel/connection fails or not verified: mcp-use **inspector** (`/inspector`) running `show_last_set`, or the **screenshot**. |
| 2:20–2:50 | **Beat the agent** | Judge whispers "clean" or "cheat" to Mike before each rep; Mike does 3–4 reps. "The judge knows. Does the agent?" | Each rep flagged or clean, live; call-outs on cheats. Score it out loud: agent vs judge. Scoreboard: `challenge_status`. | Disagreement: "That's a data point: every walk-up becomes a labelled rep." |
| 2:50–3:00 | **Close** | "Lightweight: an AI coach that can feel your muscles. Come try to beat it." | Dashboard. | — |

## If everything breaks

1. **Replay** the best recorded session: dashboard, voice and cards behave exactly like live.
2. **Quiet mode** if audio misbehaves: every line still shows as text.
3. **Screenshots** for Claude and the report card.
4. Talk numbers: 0 strict reps flagged across 3 real recordings; live swings on reps 4 and 8 caught at 7–9× normal.

## Words to use

- Say **"front delt"** or **"shoulder"**. Never "snitch".
- "Relative muscle activation", not force, not muscle growth, not medical.
- The weight never changes: "progress = more clean reps at 35 lb".
