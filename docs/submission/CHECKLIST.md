# Submission checklist: Lightweight (VexoHacks, deadline 6 PM PST, Nov 14)

## Ready (in `docs/submission/`)
- [x] `DEVPOST-PASTE.md`: every form field, paste-ready
- [x] `cover-1500x1000.png`: thumbnail, 3:2
- [x] `architecture.png`: rendered from the README mermaid diagram (2200×694)
- [x] 7 dashboard screenshots, 1600×1000 (`01`–`07`), from a replay of real session `s-1114-154430-oku` on a separate keyless copy of the server (port 3100, copy of the DB)
- [x] `08-claude-muscle-map.jpg`: copy of the already-committed `docs/img/claude-muscle-map.jpg` (735×460, small; fine as a gallery image, not as the thumbnail)
- [x] GitHub repo is public and `main` has no unpushed commits (local HEAD = origin/main at check time)

## Still missing
- [x] **Video demo link:** https://youtu.be/9WVd2LuDzkw (in the README; paste it into Devpost's video field)
- [ ] **Devpost link** from the organizers, then create the project and join the VexoHacks hackathon
- [ ] `docs/submission/` is not committed (nothing was committed or pushed by this pass)
- [ ] `data/coach/history/2026-11-14.json` is untracked (was already so before this pass); commit it if today's history should be in the repo

## Only the owner can provide
- [ ] Video (record, upload, paste link)
- [ ] Photos: sensors on the arm, UNO + shield stack on the belt, speaker on the strap. The gallery has none of the hardware today.
- [ ] Team/builder photo, if the form asks
- [ ] Track/prize selection on the form (Google DeepMind, Vexo), and any organizer-specific questions (team members, table number, "which sponsor tech did you use"): the form could not be seen, so none of this is verified
- [ ] Decide the open wording points listed at the bottom of `DEVPOST-PASTE.md` (test count 163 vs 162, 40 vs 41 labelled reps, "next Gemma run")
- [ ] Devpost limits were not checked against the live form: tagline ≤ 200 characters and thumbnail 3:2, JPG/PNG/GIF ≤ 5 MB are from memory

## Things to know about the screenshots
- Header shows **"REPLAY 15%"**, **"No device · No heartbeat"**, and **"Muted · audio: muted tab"** in orange (shots 01–03); 04–05 show "LIVE · No device · No session". They were taken on a muted second instance with no sensor attached. Honest, but not as clean as a live shot. A live screenshot from the filming session would replace 01/02 nicely.
- Report cards in 03/04 are tagged **"CODE"**, not "GEMINI": the second instance ran without API keys, so the summary is the code-written line. The older "Set 20 report" visible in 01/02/05 is the real Gemini one.
- 03/04 show the warning **"Sensor maxed out: move this pad a finger-width toward the outside of the shoulder"** and "biceps peak 100%", "delt peak 114%". True to the recording (the right delt saturated), but it is a visible flaw.
- "Workout so far" (all dashboard shots) says **20 sets · 88 reps · 27 cheats** and "Trend: sloppier as you go: fatigue is setting in." Real data from today, including deliberate swings.
- In 01/02 the right column still shows the previous set's report (Set 20) while Set 21 is running. That is how the dashboard works, but a reader may think it belongs to the set on screen.
- In 01 the big counter says "Rep 3" while the left timeline says "Set 21 LIVE 2 clean" (timeline one rep behind at that instant).
- 04 was taken after the replay was stopped: header says "No session" and the timeline ends at Set 20 while the card says "Set 21 report".
- The flagged rep is 1.6× the clean reference ("smaller cheat"), not the 7–9× quoted in the story. Fine, just don't caption it as 7–9×.
- Timeline lists sets 5–20 only in view (it scrolls). No tokens, URLs, emails or other chats appear in any image.

## README check (not edited)
Links and image paths all resolve: `docs/dashboard-fake-device.jpg`, `server/src/engine/README.md`, `HARDWARE-SETUP.md`, `firmware/README.md`, `server/tests/engine-real.test.ts`, `data/coach/history/raw/`, `firmware/lightweight/arduino_secrets.example.h`, `server/scripts/fake-device.ts`, `assets/muscle-map/` license. The mermaid block renders (it rendered with mermaid 10.9.1 for `architecture.png`).

Problems:
1. Line 5: `Demo video: _TODO: link_`.
2. **Hero image is the old dashboard** (`docs/dashboard-fake-device.jpg`, 800×450, synthetic data). It shows the old layout and the label "front delt · **snitch**", a word DEMO-SCRIPT says never to use. Suggest replacing it with `docs/submission/02-dashboard-cheat-flagged.png` and a new caption.
3. "The one unflagged swing rep **in each recording**" is wrong for the 35 lb right-arm recording, where the table says 3 of 3 swings were flagged. Should be "in the other two recordings".
4. "We tested the tools and the widget in the mcp-use inspector" is out of date: DEVPOST.md says it was verified in Claude itself. `docs/img/claude-muscle-map.jpg` exists but the README does not show it.
5. "replayed through the same pipeline at real speed" is fine; the replay route also takes `?speed=` (0.25–10).
6. No `LICENSE` file at the repo root (only the body-art license). Not required by the checklist, but Devpost judges sometimes look.
7. `CLAUDE.md` still says the voice is "Algenib"; code, README and DEVPOST say "Alnilam". Not user-facing.
