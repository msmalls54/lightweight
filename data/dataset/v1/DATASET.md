---
license: cc-by-4.0
pretty_name: Lightweight EMG curl reps (v1)
language:
  - en
task_categories:
  - tabular-classification
  - text-generation
size_categories:
  - n<1K
tags:
  - emg
  - surface-emg
  - wearables
  - fitness
  - strength-training
  - gemma
  - synthetic
configs:
  - config_name: reps
    data_files: reps.jsonl
  - config_name: windows
    data_files: windows.jsonl
  - config_name: gemma_sft
    data_files: gemma_sft.jsonl
---

# Lightweight EMG curl reps, v1

Biceps curl reps measured with surface EMG on both biceps and both **front delts (cheat check)**. Each rep comes with the signal engine's per-rep features, a strict/swing label, the engine's own cheat flag, a 4-channel time series, and a Gemma chat pair that turns the code's verdict into a short spoken coach line.

Built for **Lightweight**, an AI coach that can feel your muscles (VexoHacks, Nov 14 2026). Two uses:

1. **Fine-tune Gemma to phrase the coach's call-outs**, so the voice can run small and close to the body. The model never decides whether a rep was a cheat: code decides, the model only phrases (the prompt says so, and the targets are written by code).
2. **A strict-vs-swing classifier baseline** on real reps, to compare with the hand-tuned engine.

What's new in v1 (vs v0):
- **Live 200 Hz sessions** from the event, replayed from the stored raw batches with the current engine.
- **Mike's per-rep labels** on two live sets, including one rep he called "loose".
- Plain wording: the delt channel is the "front delt (cheat check)", and coach lines describe the shoulder relative to **your own clean reps**, never as a raw delt share.
- A **classifier baseline** (`baseline.md`) and a **few-shot Gemma eval** (`gemma_eval.md`).

## Files and counts

| File | Rows | Real | Synthetic | One row is |
|---|---|---|---|---|
| `reps.jsonl` | 106 | 62 | 44 | one detected rep: context, engine features, labels, engine flag |
| `windows.jsonl` | 106 | 62 | 44 | the same rep as a 4 x 128 %MVC time series (rep start to end) |
| `gemma_sft.jsonl` | 126 | 75 (62 rep cues + 13 set summaries) | 51 (44 + 7) | one Gemma chat pair: user = numbers + code verdict, model = coach line |
| `baseline.md` / `.json` | | | | strict-vs-swing classifier, leave-one-recording-out on real rows |
| `gemma_eval.md` / `.jsonl` | | | | few-shot Gemma on 20 held-out real pairs, scored |

Real labels: **25 strict, 15 swing, 1 loose, 21 unlabelled** (engine flag only).

| Recording | Kind | Rate | Reps | Label (source) | Engine-flagged |
|---|---|---|---|---|---|
| `2026-11-13-bench` | CSV, band, R arm | ~20 Hz | 7 (3 strict, 4 swing) | phase instruction | 1 |
| `2026-11-14-right-35lb-strict-vs-swing` | CSV, 35 lb, R arm | ~20 Hz | 8 (5 strict, 3 swing) | phase instruction | 3 |
| `2026-11-14-fulltest-35lb-bilateral` | CSV, 35 lb, both arms | ~20 Hz | 13 (7 strict, 6 swing) | phase instruction | 5 |
| `live:s-1114-122526-r82` | live, 35 lb, both arms | 200 Hz | 20: set 1 = 7 strict, 2 swing, 1 loose; set 2 unlabelled | **human, per rep** (set 1) | 8 (3 in set 1) |
| `live:s-1114-123449-zdw` | live, 35 lb, both arms | 200 Hz | 3 strict | **human, per rep** | 0 |
| `live:s-1114-120548-fpi` | live, 35 lb, both arms | 200 Hz | 11 unlabelled | none | 0 |

On Mike's labelled live set (r82 set 1), the engine flags both intended swings (reps 4 and 8, at 8.7x and 7.4x his clean reps on the way up). It also flags the "loose" rep 5 (2.3x) and none of the 7 strict reps. The 11 `fpi` reps are mostly calibration flexes and dumbbell handling caught while a set was armed during the first live run. They are not real curls, so they carry no label.

## Data fields

### `reps.jsonl`

| Field | Type | Meaning |
|---|---|---|
| `id` | string | `<recording_id>/set<n>/rep<n>-<arm>`; shared by all files (SFT ids add `/cue` or `/summary`) |
| `recording_id`, `source`, `person`, `session_id` | string | provenance. `source` = `real` / `synthetic`. `person` = `mike` (the builder), `synthetic`, or `walkup-N` |
| `exercise`, `variant`, `load_lb`, `load_desc`, `arms_on` | | what was lifted. All v1 rows are `standing` curls; band rows have `load_lb: null` |
| `arm` | `R`/`L` | for bilateral reps: the cheating arm if any, else the arm whose shoulder worked harder. All 4 channels are in the arrays |
| `set_index`, `set_label`, `rep` | | 1-based set and rep; `set_label` = phase label, preset name or `armed set N` |
| `label_instructed` | `strict` / `swing` / `loose` / null | see Labels |
| `label_source` | `phase_instruction` / `human_per_rep` / `generator_intent` / null | where the label came from |
| `label_note`, `phase_label_at_biceps_peak` | string | caveats (timing lag, which live rep it was matched to) |
| `engine_flag`, `engine_reason`, `label_engine_agree` | bool, string, bool | the signal engine's verdict at export time (`agree` is null for unlabelled and `loose` reps) |
| `start_ms`, `end_ms`, `duration_ms`, `up_ms`, `down_ms` | number | rep window (engine time), time to 90% of the biceps peak, time from the last 90% sample to the end |
| `peak_pct`, `mean_pct` | 4 floats | %MVC per channel over the rep: `[R biceps, R front delt, L biceps, L front delt]` |
| `delt_share` | float | `delt_mean / (delt_mean + biceps_mean)` for `arm`. A feature, never spoken |
| `up_delt_ratio` | float | front delt / biceps mean while the biceps climbs from 30% to 90% of its peak (the engine's main cheat feature) |
| `up_delt_x_clean` | float / null | `up_delt_ratio` as a multiple of this lifter's clean reps (null before the engine has 2 clean reps to compare with) |
| `baseline_delt_share`, `baseline_up_delt_ratio` | float / null | the clean reference the rep was judged against |
| `r_share` | float / null | `R_bi_mean / (R_bi_mean + L_bi_mean)`; null with one arm |
| `had_rep_event`, `sample_hz`, `calibration` | | rep emitted live (vs only at set end), source rate, rest/MVC used |

### `windows.jsonl`

The same `id`, provenance and label fields, plus `length` (128), `duration_ms`, `n_source_samples`, `channels` (`R_biceps, R_front_delt, L_biceps, L_front_delt`) and `pct`: 4 x 128 floats, %MVC, linearly resampled from `start_ms` to `end_ms`, so duration is normalized away. Real CSV windows come from 10-43 samples (20 Hz, heavily upsampled); live windows from 119-529 samples (200 Hz).

### `gemma_sft.jsonl`

`{"id", "kind", "source", "recording_id", ..., "messages": [{"role": "user", ...}, {"role": "model", ...}]}` in Gemma chat roles (no system role). Strip the metadata keys (or map `model` → `assistant`) for your trainer.

- **`rep_cue`**: the user turn gives exercise, load, arm, set/rep, the biceps peak, the front delt (cheat check) on the way up as a multiple of the lifter's clean reps, tempo, and the **code verdict**. The model turn is a code-written line. Examples: "Rep four: cheat. Your right shoulder did 8.7 times its normal share on the way up, that's a swing." / "Rep three. Clean." / "Rep two. Right side's slacking." `cue_keys` and `voice_clip_text` record the pre-generated voice clips the live coach plays for that rep.
- **`set_summary`**: the user turn holds the set facts as JSON (counts, cheat reps, per-rep verdict and shoulder multiple, engine decision). The model turn is the coach's code-written summary (`fallbackSummary`). Example: "Reps 4 and 8: your right shoulder did 9 and 7 times its normal share on the way up, that's a swing. Rep 5 was a smaller cheat at 2 times normal. Next set, stop at the first cheat and rest longer, same weight."
- **Wording rules:**
  - **Checked by the exporter**, which refuses to write a target that breaks them: no "snitch", no raw delt share or shoulder percentage.
  - **Never written by the coach code** in the first place: a weight change (the plan holds the load constant), medical words.

## Labels

- **`label_instructed`** is kept separate from the engine flag and never merged with it.
  - **CSV recordings:** the phase instruction (`strict_curls`/`STRICT` → strict, `cheat_curls`/`CHEAT` → swing). That's an instruction per phase, not an observation per rep: a rep in a swing phase can be a light or failed swing.
  - **Live r82 set 1 and zdw:** **Mike labelled each rep himself.** In r82 set 1, reps 4 and 8 are intended swings and rep 5 is `loose` ("kind of activated, going fast"); the rest are strict. All 3 zdw reps are strict.
    - His rep numbers are the ones he saw live (older engine). Each re-detected rep is matched to the live rep it overlaps most in time; all 13 matched 1:1.
  - **Synthetic:** the generator's intent for the matched generator rep.
- **`engine_flag`** comes from `server/src/engine/` at export time. The engine judges each rep against the lifter's **own clean reps** in the session.
  - Since Nov 14 it makes **no call before it has 2 clean reps** to compare with. That's why only 1 of the 4 Nov 13 swings is flagged: that swing phase is replayed as its own session, with no clean set before it.
  - Re-export after any engine change.
- **Timing caveats.** CSV phase labels were typed by hand and are seconds off the movement:
  - Nov 13 and Nov 14 bilateral: labels lag. Two bilateral strict reps peak under `relax4`; they're kept with a `label_note`.
  - Nov 14 right arm: labels lead by ~2.5-3 s.

## Collection

- **Hardware:** 4x SparkFun MyoWare 2.0 on 24 mm snap electrodes, Link Shield on **ENV** (rectified, smoothed envelope, not raw EMG), into an Arduino UNO R4 WiFi, 14-bit ADC (0..16383; ENV saturates at ~14,960; rest ~500-900).
- **Placement:** biceps on the belly, in line with the fibers. Front delt 2 finger-widths below the bony shoulder tip. Battery powered, shaved and alcohol-wiped skin.
- **Rate:** the 3 CSV recordings were logged at ~20 Hz. Live sessions stream 200 Hz in 200 ms batches over Wi-Fi.
- **Calibration:** `pct = clamp((raw - rest) / (mvc - rest), 0, 1.5)`.
  - **CSV recordings:** rest from relaxed phases; MVC at the ENV ceiling (the 3 s flex holds under-read what curls reach).
  - **Live sessions:** the stored session calibration, plus the engine's raise-only MVC updates from earlier sets.
  - %MVC is relative activation for one person, one pad placement, one session.
- **Live replay:** the stored batches go through the current engine exactly as the server ran them. A set is armed after each `set_start` event (its payload is the set context) and ended at `set_stop`. After an automatic set end, the set re-arms if the server's `auto_next` flag is on. Auto-end is 30 s (server setting); everything else uses engine defaults.
- **Synthetic:** `server/src/engine/fixtures.ts` presets (clean, swing, fatigue drift, heavy eccentric, heavy up-phase swing, bilateral imbalance, fast tempo), fixed seeds, 200 Hz. They're idealized shapes generated to match the engine's rules. Use them for vocabulary and pipeline tests, **never as evidence that a classifier works**.

## Baseline (see `baseline.md`)

Strict vs swing on **real labelled rows only** (40 reps, 15 swing, 5 recordings), leave-one-recording-out. Features are absolute per-rep numbers (up-phase delt/biceps, delt share, delt and biceps peak/mean, up time, duration), with no clean reference.

| Model | Accuracy | Precision (swing) | Recall (swing) |
|---|---|---|---|
| Logistic regression (pure TS, L2) | 0.95 | 1.00 | 0.87 |
| Engine flag (fixed rules) | 0.90 | 1.00 | 0.73 |
| Decision stump | 0.72 | 0.61 | 0.73 |
| Majority class (strict) | 0.63 | n/a | 0.00 |

Read with care:
- The engine's thresholds were tuned by hand on the three CSV recordings, so its row is not a held-out score. The live r82/zdw sets are its fairest test: 12/12 there.
- Most engine misses are the Nov 13 swing set replayed with no clean reference.
- One fold is one recording, and there is only one person.
- The logistic regression rated Mike's "loose" rep P(swing) = 0.01; the engine flagged it.

## Gemma eval (see `gemma_eval.md`)

Few-shot `gemma-4-26b-a4b-it` on our Gemini API key: 5 synthetic examples in the prompt, **20 held-out real pairs** (14 rep cues, 6 set summaries), no fine-tuning. This is the before-fine-tune bar.

| | n | Verdict right | ≤ 20 words | No banned words | All three |
|---|---|---|---|---|---|
| Gemma, all | 20 | 18/20 | 19/20 | 20/20 | **18/20** |
| Gemma, rep cues | 14 | 13/14 | 14/14 | 14/14 | 13/14 |
| Gemma, set summaries | 6 | 5/6 | 5/6 | 6/6 | 5/6 |
| Code-written targets (sanity) | 20 | 20/20 | 14/20 | 20/20 | 14/20 |

- **Verdict:** a rep cue must keep the code's cheat/clean verdict and name the rep; a summary must name every cheat rep.
- **Banned:** "snitch", a raw delt percentage or "delt share", a load change, medical words. These are the coach's own output filters.

What it shows:
- Gemma keeps the code's verdicts and the wording rules.
- **The two failures:**
  - One empty answer: Gemma 4 spent its 2048-token budget thinking.
  - One summary of Mike's labelled set said "3 cheats … up to 9 times" without naming reps 4, 5 and 8, at 31 words.
- **Where it drifts:** it often drops the arm ("your shoulder" vs "your right shoulder"). Sometimes it adds details the code didn't give, e.g. "Slow down." on a cheat rep, or "even more controlled than normal".
- **Latency:** median ~21 s per call, with ~1,050 thinking tokens per call. That's fine for a benchmark, too slow for a mid-set call-out. A fine-tune (or thinking turned down) is what makes it usable live.
- The code-written summaries themselves run past 20 words (6/20 targets fail that check); the coach allows up to 40 spoken words for summaries.

## Fine-tune Gemma (untested snippet)

Not run for v1: no GPU at the event. This is a minimal Hugging Face TRL + LoRA sketch for `gemma_sft.jsonl`. Swap in the Gemma checkpoint you have access to; a small instruction-tuned one suits a voice that should run close to the body.

```python
# pip install "trl>=0.12" peft datasets transformers accelerate   (untested here)
from datasets import load_dataset
from peft import LoraConfig
from trl import SFTConfig, SFTTrainer

ds = load_dataset("json", data_files="gemma_sft.jsonl", split="train")
# Gemma's template calls the reply role "model"; TRL's chat format expects "assistant".
ds = ds.map(lambda r: {"messages": [
    {"role": "user", "content": r["messages"][0]["content"]},
    {"role": "assistant", "content": r["messages"][1]["content"]},
]}, remove_columns=ds.column_names)

trainer = SFTTrainer(
    model="google/gemma-3-1b-it",            # placeholder: use the Gemma checkpoint you have
    train_dataset=ds,
    args=SFTConfig(output_dir="gemma-coach-lora", num_train_epochs=3,
                   per_device_train_batch_size=4, learning_rate=2e-4, logging_steps=10),
    peft_config=LoraConfig(r=16, lora_alpha=32, target_modules="all-linear", task_type="CAUSAL_LM"),
)
trainer.train()
```

Hold out real rows by `recording_id` when you evaluate, and re-run `server/scripts/gemma-eval.ts`'s scorer: verdict kept, ≤ 20 words, no banned wording.

## How it grows

- **Beat-the-agent walk-ups:** a judge whispers "clean" or "cheat" before each rep, and the agent calls it before the reveal. Logging that call per rep gives a **human per-rep label** that's independent of both the phase instruction and the engine. Every walk-up adds labelled reps from a new body (anonymized as `walkup-N`).
- **Every live session already stores its raw 200 Hz batches** and set events in SQLite. Re-running `export-dataset.ts --db <copy>` replays them through the current engine, so the dataset grows and stays in sync with engine changes.
- **Next:** more people, preacher and hammer variants, fresh calibration per session, and per-rep labels from the judge instead of phase instructions.

## Limits and intended use

- **Tiny:** 62 real reps (41 labelled), 1 person, 2 days, standing curls only, band and 35 lb. Any metric here is anecdotal.
- **Relative, not medical:** %MVC is relative muscle activation for one person and one pad placement. It isn't force, strength, muscle growth or a medical measurement, and MyoWare isn't a medical device. Don't compare across people or sessions without recalibrating.
- **Labels:** phase instructions are coarse and hand-timed. Only 13 real reps have per-rep human labels.
- **Out of scope:** medical or injury claims, force estimates, judging anyone other than the calibrated wearer.

## Regenerate

```
cp data/lightweight.sqlite* /tmp/lw/          # always a COPY (opening it may checkpoint the WAL)
cd server
npx tsx scripts/export-dataset.ts --db /tmp/lw/lightweight.sqlite   # reps/windows/gemma_sft
npx tsx scripts/baseline.ts                                          # baseline.md/.json
npx tsx scripts/gemma-eval.ts                                        # gemma_eval.md/.jsonl (needs GEMINI_API_KEY in .env)
```

## License and provenance

Data: **CC-BY-4.0**. Recorded by the project builder on himself (Nov 13-14 2026) for the Lightweight hackathon build. He consented and labelled his own live reps. Synthetic rows are generated by project code. The live SQLite file itself isn't published; only the derived rows are.
