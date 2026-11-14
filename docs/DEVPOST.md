# Devpost: Lightweight

Paste-ready sections. Everything below is verified today (Nov 14) unless it says "in progress".

---

## Name
Lightweight

## Tagline
A wearable that lets an AI coach feel your muscles and call out your cheat reps out loud. Try to beat it.

---

## Inspiration

Every lifter cheats reps. On the last few curls you lean back, swing, let your shoulder finish the rep, and the set still counts. A good coach standing next to you sees it instantly. Your phone can't, and neither can any AI: they only know what you type into them.

We wanted to give an agent a sense of your body. Not a camera guess and not a rep counter, but the actual muscles: is the biceps doing the work, or did the shoulder take over? Then let the coach say it out loud, mid-set, like a real one would.

## What it does

- **Feels the lift.** Four EMG sensors read your left and right biceps (the muscle you're training) and your left and right front delts (the cheat check) 200 times a second.
- **Catches the swing.** On every rep, code compares how hard your shoulder works on the way up with your own clean reps. A swing makes it fire several times harder than normal, and that rep gets flagged.
- **Calls it out loud, over your music.** "Rep six. Your delt took over." The music ducks while the coach talks. Call-outs are pre-generated clips, so they play instantly, mid-set.
- **Explains the set.** After each set the coach names the cheat reps and why ("Reps 4 and 8: right shoulder at 7 to 9 times normal, that's a swing"), shows a card with tempo and left/right balance, and repeats the plan's decision: stop at the first cheat, same weight.
- **Knows your workout.** "How's my workout going?" gets a 20-word answer: clean reps so far, the trend across sets, and the one thing to fix for the rest of the session.
- **Knows you.** The coach reads Mike's profile, his plan (35 lb stays 35 lb; progress means more clean reps) and his history, and only compares a set to past sets of the same lift.
- **Lets Claude see your body.** An MCP server exposes reps, sets, arm balance and history as tools, plus a muscle-map widget that shades the four sensed muscles by effort. Verified in Claude itself (claude.ai custom connector over a token-gated tunnel): Claude called the tools and rendered the muscle map from a real set.
- **Beat the agent.** Walk-ups get a fresh profile (never Mike's data), 5 curls, and a scoreboard: 5 reps with zero flags beats the agent.

## How we built it

- **Hardware, no soldering:** 4× MyoWare 2.0 EMG sensors on their envelope (ENV) output, snapped to Link Shields, 3.5 mm cables into the MyoWare Arduino Shield on an **Arduino UNO R4 WiFi**, all on a USB-C power bank in a running belt.
- **Firmware:** 200 Hz timer-interrupt sampling (14-bit ADC), 40-sample batches POSTed every 200 ms over a **2.4 GHz phone hotspot**, an offline queue and a heartbeat.
- **Server:** Node + TypeScript on **mcp-use** (Hono), SQLite storing every raw batch so any session can be replayed through the exact same pipeline.
- **Signal engine (pure code, unit-tested):** calibration (relax, then flex each muscle) to %MVC, hysteresis rep detection, a per-person clean reference, and the cheat rule on the up phase of each rep.
- **Coach brain: Gemini 4 Hydrogen.** One context packet (profile, plan, today's sets, like-for-like history). Code computes every number and every decision; Hydrogen only words them, and its output is checked (every cheat rep named, no weight changes, no medical words, no raw percentages) or replaced by a code-written line.
- **Voice: Gemini TTS, voice "Alnilam".** 40 call-out clips pre-generated and cached; live speech only for the first sentence of each summary.
- **Dashboard:** live bars, a front-body muscle map, a rep feed, set report cards, a "Workout so far" card, music ducking, voice commands from the laptop mic, a Quiet mode and Replay.
- **MCP:** 10 tools (`get_reps`, `show_last_set`, `compare_arms`, `get_coach_context`, `get_history`, `update_plan`, `challenge_status`, …) and a muscle-map widget for Claude/ChatGPT.
- **Built with parallel Claude Code sessions:** one each for firmware, signal engine, server/dashboard and voice/coach, coding against a shared contract (`BUILD.md`) and merged by a lead session.

## Challenges we ran into

- **One sensor read a flat 8,150.** That's half-scale: the MyoWare Link Shield's output switch was on RAW, not ENV. The switch is easy to misread; we now check for exactly that value.
- **The venue Wi-Fi was 5/6 GHz only.** The UNO R4 only speaks 2.4 GHz, so everything runs over an iPhone hotspot (UNO to laptop round trip 90–165 ms).
- **Heavy curls made the shoulder fire on clean reps.** At 35 lb, the front delt works hard on strict reps too, so the whole-rep shoulder share (0.35–0.46 strict vs 0.51–0.54 swing) barely separates them. Looking at the data, the difference lives in the **up phase**: a strict rep's shoulder works mostly on the way down to hold the arm still, a swing fires it on the way up. Shoulder/biceps on the way up: **0.41–0.76 strict vs 1.04–1.31 swing**. That became the cheat rule.
- **Our first live run was scored by a stale engine.** Hot reload kept the old engine in memory, so the first live set was judged by yesterday's rules. We now run without hot reload during live sets.
- **Gemini TTS latency swung from 3 s to 26 s** between runs. Mid-set call-outs were never affected (pre-generated clips), but set summaries were. We now speak only the first sentence (≤ 15 words), measured both TTS models live and moved summaries to the one that answered (gemini-3.8-flash-tts, ~3.3 s; the lite model was timing out), and added a safety net: if the Gemini audio isn't there within 5 s, the browser's own voice says the line and the late audio is dropped.
- **Wording.** An early summary told Mike his "delt share hit 51 percent, compared to 10 percent yesterday": a 35 lb dumbbell compared to a band, as a scary raw number. Now the coach only compares the same exercise, variant and load, and talks about the shoulder relative to your own clean reps ("8 times its normal share"), never raw percentages.

## Accomplishments that we're proud of

- **Three real recordings, replayed through the engine in our test suite:**
  - Nov 13, band curls: 3 strict reps, **0 flagged**; 4 swings, 3 flagged.
  - Nov 14, 35 lb dumbbell, right arm: 5 strict, **0 flagged**; 3 swings, **3 flagged**.
  - Nov 14, 35 lb dumbbells, both arms: 7 strict, **0 flagged**; 6 swings, 5 flagged.
  - The swings that weren't flagged were light swings at strict-level shoulder effort.
- **Live, on the body:** in a 10-rep set of 35 lb curls, Mike swung reps 4 and 8 on purpose. The engine caught both at **7–9× his normal shoulder share**, and the coach said so.
- **Zero strict reps flagged** across all three recordings.
- Code decides every flag and every decision; the LLM never judges a rep.
- A complete pipeline in one day: firmware to voice coach to Claude tools, with 118 automated tests on the server.

## What we learned

- EMG is honest but needs context: the same muscle signal means different things on the way up and the way down. The best feature came from looking at real recordings, not from the plan.
- Under load, "the shoulder works" is normal. What matters is how it works compared to your own clean reps.
- Voice UX is a latency problem first: pre-generate what you can, speak less, and always have a fallback.
- Let code decide and the LLM explain: easier to test, and the coach can't be talked into a wrong call.
- Parallel AI coding sessions work well when they share a written contract.

## What's next

- **Any lift is a config.** Target muscle + cheat muscle + thresholds: lateral raises (traps), rows (biceps), squats (lower back).
- **PT and rehab:** "is the right muscle doing the work?" is exactly the question in rehab exercises.
- **A dataset that grows with every walk-up.** Every beat-the-agent attempt adds labelled reps (the judge's call vs the engine's) to the dataset, so the next Gemma run trains on more real reps.
- **Vexo hears you, Lightweight feels you, both in Claude.**

## Built with

Arduino UNO R4 WiFi · SparkFun MyoWare 2.0 EMG · C++ (Arduino) · TypeScript · Node.js · mcp-use · Hono · SQLite (better-sqlite3) · Zod · React (muscle-map widget) · Gemini 4 Hydrogen · Gemini TTS (gemini-3.8-flash-tts / flash-lite-tts, voice Alnilam) · @google/genai · Gemma · Web Audio API · Web Speech API · Model Context Protocol · Claude Code · react-body-highlighter (body art, MIT)

---

## Tracks

### Google DeepMind
Gemini runs the coach end to end. **Gemini 4 Hydrogen** is the brain: one context packet per call (profile, plan, today's sets, like-for-like history), per-set spoken summaries and report cards, a "Workout so far" card, and Q&A ("which rep did I cheat?", "which arm is weaker?"). Code computes every number and decision; Hydrogen phrases them, and every output is checked before it reaches the speaker. **Gemini TTS** (voice Alnilam) is the voice: 40 pre-generated call-out clips for instant mid-set feedback, plus live first-sentence speech for summaries, with model choice based on latency we measured live. **Gemma:** we built a dataset for it (v1, in `data/dataset/v1/`): **106 reps** (62 real, 44 synthetic), each with engine features, the engine's flag and a 4-channel time series, plus **126 Gemma chat pairs** (numbers + the code's verdict in, a short coach line out). Real labels: 25 strict, 15 swing, 1 "loose", from phase instructions and Mike labelling his own live reps. Baseline, leave-one-recording-out on the 40 real labelled reps: logistic regression **accuracy 0.95, precision 1.00, recall 0.87**; the engine's hand-tuned rule 0.90 / 1.00 / 0.73 (its thresholds were tuned on 3 of those recordings; on the live labelled sets it got 12/12). Few-shot **gemma-4-26b-a4b-it** on 20 held-out real pairs: kept the code's verdict 18/20, stayed within 20 words 19/20, used no banned words 20/20. **Nothing is fine-tuned yet**: that's the before-fine-tune baseline. The dataset grows with every beat-the-agent walk-up: each attempt adds labelled reps.

### Vexo
_[Vexo paragraph: confirm the angle with Mike.]_ Lightweight is a body sense for agents: the same way Vexo lets Claude hear you, Lightweight lets Claude feel you. Through MCP, Claude can read your reps, see which muscle did the work on a body map, compare your arms and change your plan, all from the sensor data. Together, an agent hears what you say and feels what your body does. _(Verified in Claude itself on Nov 14 via a custom connector.)_
