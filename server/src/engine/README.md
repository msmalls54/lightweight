# Signal engine (`server/src/engine/`)

Pure TypeScript, no I/O. Raw 4-channel ENV batches go in; live frames, rep events and set ends come out. **Code decides cheats.** The LLM only explains them.

| File | What |
|---|---|
| `index.ts` | Public API (BUILD.md "② Signal engine API") + `EngineConfig`, `DEFAULT_CONFIG` |
| `types.ts` | `CH`, `Batch`, `Calibration`, `SetContext`, `LiveFrame`, `RepEvent`, `SetEndEvent`, `CoachDecision` |
| `config.ts` | **Every threshold.** Tune here |
| `calibration.ts` | rest/MVC → %MVC |
| `engine.ts` | `class Engine` |
| `fixtures.ts` | Synthetic EMG generator (`synth`, `hold`, `toBatches`, `presets`). Good for running the dashboard without hardware |

## API

```ts
import { Engine } from "./engine/index.js";
const engine = new Engine();                       // or new Engine({ hi: 0.4, earlyCheatSetsInRow: 1 })
const cal = engine.calibrate(restWin, mvcWin);     // 4 arrays of raw samples each; applied immediately
// cal.ok === false → show cal.problems (each starts with the channel, e.g. "R front delt (A1): ...")
// One-arm walk-up: engine.calibrate(restWin, mvcWin, ["R"]) only checks R channels.
engine.setCalibration(savedCal);                   // restore a stored calibration
engine.startSet({ session_id, set_id, person, exercise, variant: "standing", load_lb: 35, arms: ["R"] });
for (const ev of engine.ingest(batch)) { /* "live" | "rep" | "set_end" */ }
const end = engine.endSet();                       // null if no set is running
```

**Raising the MVC from real reps (additive, not in BUILD.md).** A 3 s FLEX hold undershoots what curls reach: 10,000 vs ~14,900 on Nov 14. Pool it with the first strict set:
```ts
import { mvcFromWindows, raiseMvc } from "./engine/index.js";
mvcFromWindows([flexWin, strictSetWin]);          // pure: per-channel p95 of all samples pooled (4 arrays per window)
const cal2 = raiseMvc(cal, [strictSetWin]);       // pure: MVC raised where the windows go higher, never lowered
engine.setCalibration(cal2);                      // or: engine.raiseMvc([strictSetWin])
```
`setCalibration` rescales the clean references already learned this session (they're in %MVC), so the next set is judged consistently; tested on the Nov 14 right-arm file. Call it between sets. Over a whole set (rest samples included), p95 gives ~12,900 for that file; pass `percentile` 0.98–0.99 to get closer to the peaks.

Behavior worth knowing:
- **Before calibration** pct uses rest 550 / MVC 14960. Calibration channels that fail the checks also fall back to those defaults, so a dead pad reads ~0 instead of garbage.
- **Calibration math:** rest = median of the rest window. MVC = 95th percentile of that muscle's flex window. `pct = clamp((x-rest)/(mvc-rest), 0, 1.5)`. A channel is rejected if `mvc-rest < 1000` (dead/bad pad) or rest > 4000 (not relaxed, or the Link Shield is on RAW, which sits around 8150).
- **Live frames:** one per 50 ms of sample time (~20 Hz), the latest sample's %MVC per channel.
- **Reps only inside a set.** With no `startSet`, `ingest` returns live frames only. After a `set_end` (auto or manual) the engine is idle again until the next `startSet`.
- **Auto set_end** fires from `ingest` `autoEndMs` (default 10 s, sample time) after the last rep. It needs at least one rep, so a started set never times out before the first curl.
- **%MVC clamps:** live frames and reported `peak_pct`/`mean_pct` are clamped to 1.5. Detection and scoring use %MVC clamped at `detectPctMax` (3), so a too-low MVC can't flatten every rep at 1.5 and merge them (the first live run had R biceps MVC 5118 vs ~14,000 in curls).
- **Self-calibrating MVC** (`autoRaiseMvc`, default on): at every set end with reps, each channel's MVC is raised to that set's own p99 (`autoRaisePercentile`), never lowered. The clean references are rescaled to match. `set_end.calibration` (additive) carries the new calibration when it changed: it's already applied, so persist it if you store calibrations.
- **`endSet()` keeps a rep that's still in progress** if it's already ≥ `minRepMs`. That rep is in `set_end.reps` but never got its own `rep` event. **Store reps from `set_end.reps`**, not only from `rep` events.
- **Duplicate or overlapping batches** (samples at or before the last seen time) are skipped. A big jump back in `t0_ms` (device restart) rebases the timeline so detection keeps going. Emitted times are then offset from device millis.
- **Both arms on** (`arms: ["R","L"]`): one detector on max(R biceps, L biceps), so a bilateral curl is **one** rep event, not two. Each arm that worked (biceps peak ≥ `hi`) gets scored. The event's `arm`/`delt_share` is the cheating arm if any, otherwise the arm with the higher delt share. `r_share = R_bi_mean / (R_bi_mean + L_bi_mean)`. Alternating curls count each side's curl as a rep.
- Numbers in events are rounded to 3 decimals. Times are ms.

## Rep detection

Signal = %MVC of the active arm's biceps (max of both when both arms are on).

1. **Onset:** the lowest point since the last rep ended, or the first sample back above `lo` (0.15) if the signal went below it. The rep window starts here. (Heavy continuous reps never relax below `lo` between reps.)
2. **Start:** the signal rises to `max(hi, valley + restartRise)` = max(0.35, valley + 0.2). The valley-relative part stops a lingering tail from starting a fake rep, and handles a too-low biceps MVC (FLEX hold < curls), which lifts the valleys between heavy reps to ~0.3. Within `minGapMs` (400 ms) of the last rep's end the start is *deferred*, not dropped: a rep that follows straight on still counts once the gap has passed.
3. **End:** the signal drops below `max(lo, min(endLevelMax, endPeakFrac × rep peak))` = 30% of the peak, between 0.15 and 0.4. Hard reps end on the way down, so the slow envelope decay doesn't drag them out or split them.
4. Windows shorter than `minRepMs` (400 ms, onset → end) are thrown away as twitches.

Per rep: peak and mean %MVC for all 4 channels over the window. `up_ms` = onset → first sample ≥ 90% of biceps peak. `down_ms` = last sample ≥ 90% → end. `delt_share = delt_mean / (delt_mean + biceps_mean)` for that arm.

**`up_delt_ratio`** (additive optional field, not in BUILD.md): delt mean / biceps mean over the **up phase only**, while the biceps climbs from 30% to 90% of its rep peak. Not from the window start: on touch-and-go heavy reps the delt is still busy with the previous rep's lowering at the bottom. `baseline_up_delt_ratio` = the reference's value.

## Cheat flag (per arm)

Every rep is judged against that arm's **clean reference**: up-phase delt/biceps ratio, delt share, delt mean %MVC and delt peak %MVC of a clean rep for this person, load and pad placement. There are no absolute delt limits: with 35 lb dumbbells the front delt works hard on strict reps too.

**Why the up phase:** a swing fires the delt on the way *up* (it starts the weight). A strict heavy rep uses the delt mostly on the way *down*, to stabilize the shoulder. Whole-rep numbers mix the two, so strict and swing look alike under load. Nov 14 right arm, 35 lb: whole-rep share 0.35–0.46 strict vs 0.51–0.54 swing; up ratio 0.41–0.76 strict vs 1.04–1.31 swing.

- **Reference:** once the arm has done 2 reps in the set, the per-feature *max* over the unflagged ones among them. Max, so a light warm-up rep 1 doesn't make rep 3 look like a cheat. Before that, the reference is the last clean reference from an earlier set **in the same session with the same exercise, variant and load**. Swinging from rep 1 is caught when a clean set came first. `baseline_delt_share` = the reference's share (null = no reference).
- **No reference** (first reps of the session for that exercise): only blatant reps are flagged: up ratio > `fallbackUpRatio` (1.2, delt above the biceps on the way up) or delt share > `fallbackShareMax` (0.6). Never `delt_peak`, and never the whole-rep jump rules.
- **A reference must look clean:** a rep that would be blatant by those no-reference rules never becomes the reference. A session reference that turns blatant after an MVC raise is dropped. (Live run 1: a delt-led rep read up ratio 0.65 under MVC 5118, but 1.9 under the real MVC.)
- **Main rule:** up ratio ≥ 1.35 × ref **and** ≥ ref + 0.15 → `"delt_share_jump"`.
- `delt_share > ref + 0.15` → `"delt_share_jump"`. This is what fires on band curls: the delt is quiet on clean reps.
- delt mean ≥ 1.5 × ref **and** ≥ ref + 0.15 → also `"delt_share_jump"` (the "delt took over" family; BUILD.md's union has no separate value). This is what fires under heavy load: a swing raises delt *and* biceps, so the share barely moves (+0.04–0.08), but the delt level jumps ~1.5–1.8×.
- delt peak > max(0.5, ref peak + 0.4) → `"delt_peak"`.

All the rules report `"delt_share_jump"` ("delt took over"), because BUILD.md's union has no separate value; `up_delt_ratio` vs `baseline_up_delt_ratio` shows the up-phase evidence.

Known limits: a heavy swing from rep 1 with no earlier clean set of the same exercise in the session is flagged only if it's blatant (up ratio > 1.2). Delt *onset* timing (delt crosses a level before the biceps) doesn't separate strict from swing: −208 to +180 ms on strict reps vs +56 to +163 ms on swings. So the engine uses how hard the delt works on the way up, not when it starts.

## CoachDecision (set end)

Rules from `data/coach/plan.json`, with the values copied into config (no file reads). **The load never changes.**
Checked in this order:
1. **Too many cheats:** cheat reps > `maxCheatRepsPerSet` (1, plan's `max_cheat_reps_per_set`) → `stop_at_first_cheat_rest_longer`, e.g. "3 cheat reps (first at rep 2); the plan allows 1 cheat rep. Next set, stop at the first cheat and rest longer. Same weight."
2. **Early-cheat streak:** first cheat rep < `earlyCheatBeforeRep` (6) in `earlyCheatSetsInRow` (2, per plan's "two sets in a row") consecutive sets of the session → `stop_at_first_cheat_rest_longer`. The first such set returns `continue` with a warning in `reason`. Set `earlyCheatSetsInRow: 1` to fire on the first one. The streak counts every set, including ones that rule 1 already stopped. Sets with 0 reps don't touch it; a set without an early cheat resets it.
3. **Tempo:** more than half the reps (and ≥ 3 reps) have `up_ms < 300` → `slow_the_tempo`.
4. Else `continue`. The reason sums up clean vs cheat.

## Real data (Nov 13 bench, `tests/engine-real.test.ts`)

Rest 570/495, MVC 14960, 20 Hz, each phase fed as its own set:

| Phase | Reps | delt_share per rep | Flagged |
|---|---|---|---|
| strict_curls | 3 | 0.096, 0.093, 0.098 (mean 0.096) | none |
| cheat_curls | 4 | 0.219, 0.657, 0.476, 0.565 (mean 0.48) | reps 2–4 (`delt_share_jump`) → `stop_at_first_cheat_rest_longer` |

Swing rep 1 (share 0.22, delt peak 0.35) is a light swing: unflagged when the swing phase is its own session, flagged (up ratio 0.28 vs 0.095) when it follows the strict set in one session. The phase labels in the CSV lag the movement: each "curls" phase ends mid-rep, and the following "rest" phase holds one more rep.

## Real data (Nov 14, 35 lb dumbbells, both arms, `2026-11-14-fulltest-35lb-bilateral.csv`)

One session: STRICT set, then CHEAT set. Same result with the lead's calibration (rest 602/932/804/1301, MVC 9691/14963/14938/14954) and with rest from the clean relax phases + MVC at the ceiling:

| Set | Reps | Flagged | R delt mean | L delt mean | R share |
|---|---|---|---|---|---|
| strict | 7 (2 spill into the relax4 label) | none | 0.45–0.52 | 0.30–0.44 | 0.49–0.52 |
| swing | 6 | reps 2–6 → `stop_at_first_cheat_rest_longer` | 0.75–0.86 | 0.49–0.65 | 0.54–0.58 |

Swing rep 1 has strict-level delt (R 0.49, up ratio 0.96 vs ref 1.04) and stays clean. Worst strict rep: up ratio 1.25× its reference (R rep 4).

## Real data (Nov 14, 35 lb dumbbell, right arm only, `2026-11-14-right-35lb-strict-vs-swing.csv`)

The phase labels start ~2.5–3 s before the movement; only the signal is used, the labels just bound the sets. One session, rest 550/620. Same result with MVC at the ceiling and with MVC from the holds (biceps 10,000, delt 14,300):

| Set | Reps | Flagged | up ratio (ceiling MVC) | ref | whole-rep share |
|---|---|---|---|---|---|
| strict | 5 | none | 0.41, 0.71, 0.46, 0.76, 0.69 | 0.71 | 0.35–0.46 |
| swing | 3 | all 3 → `stop_at_first_cheat_rest_longer` | 1.31, 1.15, 1.04 | 0.71 (from the strict set) | 0.51–0.54 |

Margins: worst strict rep 1.08× its reference, weakest swing 1.47×; threshold 1.35×. Before the up-phase rule only swing 1 was flagged.

## How to tune

1. Record a set (the server stores raw batches). Replay it into `new Engine({...})` in a scratch test and print `end.reps`. `tests/engine-real.test.ts` shows how to turn rows into batches.
2. **Missed reps:** lower `hi`. **Reps split in two:** raise `endPeakFrac`/`endLevelMax` or `minGapMs`. **Twitches counted:** raise `minRepMs`. Don't go above ~0.5 s: real swing reps can be that short.
3. **False cheats on strict reps:** compare `up_delt_ratio` with `baseline_up_delt_ratio`, and `delt_share` with `baseline_delt_share`, to see which rule fired. Up-phase false flags → raise `upRatioMult`/`upRatioJump`. Band-type false flags → raise `deltShareJump`. Heavy-load whole-rep false flags → raise `deltMeanRatio`/`deltMeanJump`. Check the delt pad placement first (CLAUDE.md: 2 finger-widths below the shoulder tip). **Missed swings:** lower them.
4. Per-variant: `new Engine({ variantOverrides: { preacher: { deltMeanRatio: 1.4 } } })`.
5. Run `npm test`. All real-CSV tests (`engine-real`, `engine-live`) must stay green.
