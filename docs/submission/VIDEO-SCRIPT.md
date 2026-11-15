# Video script: Lightweight (about 2 minutes)

Narration is read over the clips. Each beat lists what is on screen. Word count: about 290 (roughly 1:55 at a calm pace).

| # | Time | On screen | Narration |
|---|---|---|---|
| 1 | 0:00–0:10 | Phone video: Mike wired up, dashboard beside him. Title: "Lightweight" | Every lifter cheats reps. A coach standing next to you sees it. Your phone can't. Lightweight gives an AI coach a sense of your body. |
| 2 | 0:10–0:28 | Close on the sensors, then the board on the belt | Four muscle sensors sit on my biceps and the front of my shoulders. They read how hard each muscle is working, two hundred times a second. A small board on my belt sends that over Wi-Fi to my laptop. No soldering, all snap-together parts. |
| 3 | 0:28–0:48 | Screen recording: strict reps, body map lit, rep feed "clean" | On a strict curl, the biceps does the work. Code compares every rep to my own clean reps. The body on screen lights up with what it feels, and each rep is counted out loud. |
| 4 | 0:48–1:05 | Phone video + screen: the swing, shoulder flashes red, rep flagged | When I swing the weight, my shoulder fires on the way up. That rep gets flagged, and the coach says so, mid-set. Code decides every call. The AI only explains it. |
| 5 | 1:05–1:20 | Speaker on the strap; report card on screen | The coach talks through a Bluetooth speaker on my strap, or earbuds, so I never look at a screen. After the set I get a report: which reps I cheated, my tempo, left against right, and what to do next set. |
| 6 | 1:20–1:35 | "Workout so far" card, then Claude with the muscle map | Gemini is the coach's brain and its voice. It knows my plan and my history, so I can ask how my workout is going. And through MCP, Claude can read the same data and show which muscle did the work. |
| 7 | 1:35–1:48 | Dataset numbers on a card; Lift library page | We also built a dataset for Gemma: over two thousand reps, real and synthetic. A model trained only on the synthetic ones scored ninety-six percent on my real reps. Curls today; any lift is one config entry. |
| 8 | 1:48–1:55 | Dashboard, logo | Lightweight. An AI coach that can feel your muscles. |

## Facts behind each line (so nothing is overclaimed)

- 4 MyoWare 2.0 EMG sensors, 200 Hz, Arduino UNO R4 WiFi, phone hotspot. Relative muscle activation only: not force, not medical.
- Cheat rule: shoulder/biceps on the way up, compared with the lifter's own clean reps. Code flags; Gemini words it.
- Voice: Gemini TTS (voice Alnilam), 57 pre-generated clips for instant call-outs. Brain: Gemini 4 Hydrogen.
- Gemma: dataset v2 = 2,428 reps (85 real, 2,343 synthetic); synthetic-only training scored 0.96 accuracy on the 26 real test reps; few-shot Gemma kept the code's verdict on 18 of 20. Nothing is fine-tuned.
- MCP: 10 tools and a muscle-map widget, verified in Claude through a custom connector.
- Lift library: curls live today; other lifts are "config ready, not yet tested".
