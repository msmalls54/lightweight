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

Behavior worth knowing:
- **Before calibration** pct uses rest 550 / MVC 14960. Calibration channels that fail the checks also fall back to those defaults, so a dead pad reads ~0 instead of garbage.
- **Calibration math:** rest = median of the rest window. MVC = 95th percentile of that muscle's flex window. `pct = clamp((x-rest)/(mvc-rest), 0, 1.5)`. A channel is rejected if `mvc-rest < 1000` (dead/bad pad) or rest > 4000 (not relaxed, or the Link Shield is on RAW, which sits around 8150).
- **Live frames:** one per 50 ms of sample time (~20 Hz), the latest sample's %MVC per channel.
- **Reps only inside a set.** With no `startSet`, `ingest` returns live frames only. After a `set_end` (auto or manual) the engine is idle again until the next `startSet`.
- **Auto set_end** fires from `ingest` 10 s (sample time) after the last rep. It needs at least one rep, so a started set never times out before the first curl.
- **`endSet()` keeps a rep that's still in progress** if it's already ≥ `minRepMs`. That rep is in `set_end.reps` but never got its own `rep` event. **Store reps from `set_end.reps`**, not only from `rep` events.
- **Duplicate or overlapping batches** (samples at or before the last seen time) are skipped. A big jump back in `t0_ms` (device restart) rebases the timeline so detection keeps going. Emitted times are then offset from device millis.
- **Both arms on** (`arms: ["R","L"]`): one detector on max(R biceps, L biceps), so a bilateral curl is **one** rep event, not two. Each arm that worked (biceps peak ≥ `hi`) gets scored. The event's `arm`/`delt_share` is the cheating arm if any, otherwise the arm with the higher delt share. `r_share = R_bi_mean / (R_bi_mean + L_bi_mean)`. Alternating curls count each side's curl as a rep.
- Numbers in events are rounded to 3 decimals. Times are ms.

## Rep detection

Signal = %MVC of the active arm's biceps (max of both when both arms are on).

1. **Onset:** the lowest point since the last rep ended, or the first sample back above `lo` (0.15) if the signal went below it. The rep window starts here. (Heavy continuous reps never relax below `lo` between reps.)
2. **Start:** the signal crosses up through `hi` (0.35). Within `minGapMs` (400 ms) of the last rep's end the start is *deferred*, not dropped: a rep that follows straight on still counts once the gap has passed.
3. **End:** the signal drops below `max(lo, min(endLevelMax, endPeakFrac × rep peak))`. For a hard rep (peak 1.0) that's 0.25, so the slow envelope decay after hard reps doesn't drag the rep out or split it in two.
4. Windows shorter than `minRepMs` (400 ms, onset → end) are thrown away as twitches.

Per rep: peak and mean %MVC for all 4 channels over the window. `up_ms` = onset → first sample ≥ 90% of biceps peak. `down_ms` = last sample ≥ 90% → end. `delt_share = delt_mean / (delt_mean + biceps_mean)` for that arm.

## Cheat flag (per arm)

Every rep is judged against that arm's **clean reference**: delt share, delt mean %MVC and delt peak %MVC of a clean rep for this person, load and pad placement. There are no absolute delt limits: with 35 lb dumbbells the front delt works hard on strict reps too.

- **Reference:** once the arm has done 2 reps in the set, the per-feature *max* over the unflagged ones among them. Max, so a light warm-up rep 1 doesn't make rep 3 look like a cheat. Before that, the reference is the last clean reference from an earlier set **in the same session with the same exercise, variant and load**. Swinging from rep 1 is caught when a clean set came first. `baseline_delt_share` = the reference's share (null = no reference).
- **No reference** (first reps of the session for that exercise): only a blatant delt share > `fallbackShareMax` (0.6) is flagged.
- `delt_share > ref + 0.15` → `"delt_share_jump"`. This is what fires on band curls: the delt is quiet on clean reps.
- delt mean ≥ 1.5 × ref **and** ≥ ref + 0.15 → also `"delt_share_jump"` (the "delt took over" family; BUILD.md's union has no separate value). This is what fires under heavy load: a swing raises delt *and* biceps, so the share barely moves (+0.04–0.08), but the delt level jumps ~1.5–1.8×.
- delt peak > max(0.5, ref peak + 0.4) → `"delt_peak"`.

Known limits: a heavy swing from rep 1, with no earlier clean set of the same exercise in the session, isn't flagged unless the share is > 0.6. Delt-fires-before-biceps timing doesn't separate strict from swing under load (the delt leads on strict 35 lb reps too), so it isn't used.

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

Swing rep 1 (share 0.22, delt peak 0.35) is a light swing and stays unflagged under both rules. The phase labels in the CSV lag the movement: each "curls" phase ends mid-rep, and the following "rest" phase holds one more rep.

## Real data (Nov 14, 35 lb dumbbells, both arms, `2026-11-14-fulltest-35lb-bilateral.csv`)

One session: STRICT set, then CHEAT set. Same result with the lead's calibration (rest 602/932/804/1301, MVC 9691/14963/14938/14954) and with rest from the clean relax phases + MVC at the ceiling:

| Set | Reps | Flagged | R delt mean | L delt mean | R share |
|---|---|---|---|---|---|
| strict | 7 (2 spill into the relax4 label) | none | 0.45–0.52 | 0.30–0.44 | 0.49–0.52 |
| swing | 6 | reps 2–6 → `stop_at_first_cheat_rest_longer` | 0.75–0.86 | 0.49–0.65 | 0.54–0.58 |

Swing rep 1 has strict-level delt (R 0.49) and stays clean. Tightest margin: strict L rep 5 at 1.42× its reference vs the smallest swing at 1.53× (R).

## How to tune

1. Record a set (the server stores raw batches). Replay it into `new Engine({...})` in a scratch test and print `end.reps`. `tests/engine-real.test.ts` shows how to turn rows into batches.
2. **Missed reps:** lower `hi`. **Reps split in two:** raise `endPeakFrac`/`endLevelMax` or `minGapMs`. **Twitches counted:** raise `minRepMs`. Don't go above ~0.5 s: real swing reps can be that short.
3. **False cheats on strict reps:** look at `cheat_reason` and compare the rep with `baseline_delt_share` / the first reps. Band-type false flags → raise `deltShareJump`. Heavy-load false flags → raise `deltMeanRatio`/`deltMeanJump`. Check the delt pad placement first (CLAUDE.md: 2 finger-widths below the shoulder tip). **Missed swings:** lower them.
4. Per-variant: `new Engine({ variantOverrides: { preacher: { deltMeanRatio: 1.4 } } })`.
5. Run `npm test`. Both real-CSV tests must stay green.
