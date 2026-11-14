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

1. **Onset:** the first sample ≥ `lo` (0.15) after the signal was below `lo`. The rep window starts here.
2. **Start:** the signal crosses up through `hi` (0.35). Ignored if it's within `minGapMs` (400 ms) of the last rep's end; it must drop again before it can count.
3. **End:** the signal drops below `max(lo, min(endLevelMax, endPeakFrac × rep peak))`. For a hard rep (peak 1.0) that's 0.25, so the slow envelope decay after hard reps doesn't drag the rep out or split it in two.
4. Windows shorter than `minRepMs` (400 ms, onset → end) are thrown away as twitches.

Per rep: peak and mean %MVC for all 4 channels over the window. `up_ms` = onset → first sample ≥ 90% of biceps peak. `down_ms` = last sample ≥ 90% → end. `delt_share = delt_mean / (delt_mean + biceps_mean)` for that arm.

## Cheat flag (per arm)

- **Baseline** = mean `delt_share` of that arm's first 2 reps in the set, **capped at `baselineCap` (0.25)**. Reps 1–2 have `baseline_delt_share: null` and are compared against the cap. The cap stops a set that swings from rep 1 from hiding all its cheats behind a high baseline. Without it, the real Nov 13 swing set's baseline would be 0.42 and rep 3 (0.48) would pass.
- `delt_share > baseline + 0.15` → `cheat_reason: "delt_share_jump"`. Checked first.
- Otherwise, delt peak %MVC > 0.5 → `"delt_peak"`.

## CoachDecision (set end)

Rules from `data/coach/plan.json`, with the values copied into config (no file reads). **The load never changes.**
1. First cheat rep < `earlyCheatBeforeRep` (6) in `earlyCheatSetsInRow` (2, per plan's "two sets in a row") consecutive sets of the session → `stop_at_first_cheat_rest_longer`. The first such set returns `continue` with a warning in `reason`. Set `earlyCheatSetsInRow: 1` to fire on the first one. Sets with 0 reps don't touch the streak; a set without an early cheat resets it.
2. More than half the reps (and ≥ 3 reps) have `up_ms < 300` → `slow_the_tempo`.
3. Else `continue`. The reason sums up clean vs cheat and mentions the plan's 1-cheat-rep-per-set limit.

## Real data (Nov 13 bench, `tests/engine-real.test.ts`)

Rest 570/495, MVC 14960, 20 Hz, each phase fed as its own set:

| Phase | Reps | delt_share per rep | Flagged |
|---|---|---|---|
| strict_curls | 3 | 0.096, 0.093, 0.098 (mean 0.096) | none |
| cheat_curls | 4 | 0.219, 0.657, 0.476, 0.565 (mean 0.48) | reps 2–4 (`delt_share_jump`) |

Swing rep 1 (share 0.22, delt peak 0.35) is a light swing and stays unflagged under both rules. The phase labels in the CSV lag the movement: each "curls" phase ends mid-rep, and the following "rest" phase holds one more rep.

## How to tune

1. Record a set (the server stores raw batches). Replay it into `new Engine({...})` in a scratch test and print `end.reps`. `tests/engine-real.test.ts` shows how to turn rows into batches.
2. **Missed reps:** lower `hi`. **Reps split in two:** raise `endPeakFrac`/`endLevelMax` or `minGapMs`. **Twitches counted:** raise `minRepMs`. Don't go above ~0.5 s: real swing reps can be that short.
3. **False cheats on strict reps:** raise `deltShareJump` or `deltPeakMax`. Check the delt pad placement first (CLAUDE.md: 2 finger-widths below the shoulder tip). **Missed swings:** lower them.
4. Per-variant: `new Engine({ variantOverrides: { preacher: { deltPeakMax: 0.4 } } })`.
5. Run `npm test`. The real-CSV test must stay green.
