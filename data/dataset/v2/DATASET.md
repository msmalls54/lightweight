---
license: cc-by-4.0
pretty_name: Lightweight EMG curl reps (v2, real + fitted synthetic)
language:
  - en
task_categories:
  - tabular-classification
  - text-generation
size_categories:
  - 1K<n<10K
tags:
  - emg
  - surface-emg
  - wearables
  - fitness
  - personal-trainer
  - gemma
  - synthetic
configs:
  - config_name: gemma_sft
    data_files:
      - split: train
        path: gemma_sft_train.jsonl
      - split: validation
        path: gemma_sft_validation.jsonl
      - split: test
        path: gemma_sft_test.jsonl
  - config_name: reps
    data_files: reps.jsonl
  - config_name: windows
    data_files: windows.jsonl
  - config_name: sets
    data_files: sets.jsonl
---

# Lightweight EMG curl reps, v2

**Goal:** valid data to train a small **personal-trainer Gemma** that phrases the call-outs of an AI coach that can feel your muscles. Surface EMG reads both biceps and both **front delts (cheat check)**. The signal engine decides every verdict in code; the model only learns to say it well.

v2 = the **real** reps (the v1 recordings, plus live runs 3 and 4, all re-judged by the final engine with the server's config) + **2,343 synthetic reps** from a generator fitted to the real reps. **Validation and test are real reps only**, split by recording. Nothing has been fine-tuned yet. v1 stays in `data/dataset/v1`.

## Files and counts

| File | Rows | What |
|---|---|---|
| `gemma_sft_train.jsonl` | 2,741 | 2,704 synthetic + 37 real chat pairs |
| `gemma_sft_validation.jsonl` | 22 | **real only** |
| `gemma_sft_test.jsonl` | 44 | **real only** |
| `reps.jsonl` | 2,428 | one detected rep: context, engine features, labels, engine verdict, `split` |
| `windows.jsonl` | 2,428 | the same reps as 4 x 128 %MVC time series |
| `sets.jsonl` | 298 (18 real + 280 synthetic) | one set: the engine's full `set_end` (verdicts, decision, `delt_saturated`), context |
| `fit_stats.json` | | the real-rep statistics the generator was fitted to |
| `baseline.md` / `.json` | | does synthetic transfer to real? (classifier) |
| `gemma_eval.md` / `.jsonl` | | few-shot Gemma, shots from train, scored on real test |

SFT kinds:

| Kind | Train (synthetic + real) | Validation | Test |
|---|---|---|---|
| `rep_cue` (≤ 20 words) | 2,338 + 28 | 19 | 38 |
| `set_summary` | 280 + 9 | 3 | 6 |
| `workout_summary` | 83 | - | - |
| `calibration_check` (sensor faults) | 3 | - | - |

## Splits (no leakage)

Splits are by **recording**: no recording appears in two splits, and synthetic rows are train only.

| Split | Real recordings | Real labels |
|---|---|---|
| **test** | `live:s-1114-122526-r82`<br>`live:s-1114-140601-kau`<br>`2026-11-14-right-35lb-strict-vs-swing` | 21 strict, 5 swing, 1 loose (per-rep human labels on r82 set 1 and kau) + 11 unlabelled |
| **validation** | `2026-11-14-fulltest-35lb-bilateral`<br>`live:s-1114-123449-zdw` | 10 strict, 6 swing + 3 unlabelled |
| **train** | `2026-11-13-bench`<br>`live:s-1114-120548-fpi`<br>`live:s-1114-134519-i7p` | 3 strict, 4 swing + 21 unlabelled |

Report metrics on real validation/test only. The synthetic generator was fitted on statistics from all labelled real recordings (see Limits).

## Real data

- 85 real reps from 8 recordings: the three ~20 Hz CSVs and five live 200 Hz sessions.
- Replayed from the stored raw batches through the **final engine** with the server's `ENGINE_CONFIG` (8 s auto-end, MVC percentile 0.99), using the server's own `set_start`/`set_stop` events.
- **Live run 3** (`i7p`): bilateral 35 lb, 7 slow reps that saturate the sensor. Unlabelled; the engine flags one.
- **Live run 4** (`kau`): 9 reps that Mike labelled **all clean**. The R delt pad sat far forward and saturated on every rep; the L delt climbed with fatigue. The engine: 0 cheats, 1 loose, `delt_saturated: ["R"]`.
- Labels and fields are as in v1 (see `data/dataset/v1/DATASET.md`). New fields:
  - `loose` (gradual fatigue rise, not a cheat)
  - `split`, `generator_version`, `seed`
  - per set: `delt_saturated`

## Synthetic data: how it's made and what it's for

**What it's for:**
- Giving a phrasing model enough varied, correctly-judged situations to learn the coach's voice: verdict categories, contexts, set and workout summaries, sensor faults.
- Pre-training or augmenting a classifier.

**What it's not:**
- Evidence that anything works on real people. All metrics below are on real reps.

**How it's made** (`server/scripts/build-dataset-v2.ts`, `generator_version: lw-synth-v2.0`, `seed` per session, global seed 2026):

1. **Fit to real reps.** `fit_stats.json` holds per condition (band one arm, 35 lb one arm, 35 lb bilateral) and per label (strict/swing): rep duration, up time, biceps peak and its saturation rate, up-phase delt/biceps ratio, delt peak. The generator draws from distributions matched to these. Checked after generation (means, non-high-baseline sessions):

   | Condition, label | Real duration / up / up ratio | Synthetic |
   |---|---|---|
   | band, strict | 1.15 s / 0.30 s / 0.08 | 1.22 / 0.32 / 0.05 |
   | band, swing | 0.66 / 0.22 / 1.05 | 0.84 / 0.22 / 0.79 |
   | 35 lb one arm, strict | 1.60 / 0.62 / 0.61 | 1.66 / 0.47 / 0.57 |
   | 35 lb one arm, swing | 0.94 / 0.46 / 1.17 | 1.20 / 0.34 / 1.23 |
   | 35 lb bilateral, strict | 1.73 / 0.54 / 0.88 | 1.64 / 0.48 / 0.53 |
   | 35 lb bilateral, swing | 1.16 / 0.36 / 1.36 | 1.21 / 0.35 / 1.47 |

2. **Sessions and sets.** 110 sessions (20% walk-ups with one set and no history), 280 sets of 5-12 reps, 2-4 sets per workout. Each session draws:
   - one condition
   - a pad sensitivity (strict up ratio: band ~0.08; 35 lb log-normal around 0.6, 0.15-1.1)
   - optionally a **high-baseline pad** (12%: the delt is pinned at the ceiling on clean reps, like live run 4)
   - optionally a **sensor fault** (6%: dead delt channel, or a delt channel left on RAW at ~8,150)

   Set kinds:

   | Set kind | Reps | What it is |
   |---|---|---|
   | all strict | 735 | |
   | fatigue drift | 514 | up ratio +2-4% per rep, labelled `loose` from 40% of the set, sometimes a final swing |
   | abrupt mid-set swing | 342 | |
   | swings at the end | 308 | |
   | rushed tempo | 248 | 200-320 ms up |
   | L/R imbalance | 196 | bilateral, weaker L biceps 0.45-0.65 |

   Contexts: first set, mid-workout, late fatigue, walk-up with no history.
3. **Shapes.** `server/src/engine/fixtures.ts` `synth()` at 200 Hz: raised-cosine biceps envelope; ENV saturation at the 14,960 ceiling, which makes the plateaus; delt on the way up vs down. Strict heavy reps use the delt more on the way down, swings on the way up. Noise is added on top.
4. **The real engine decides.** Every synthetic rep goes through `Engine` with the server config and a calibration from the generator's own rest/flex windows. The engine's verdict is `engine_flag`/`loose`; the generator's intent is `label_instructed` (`label_source: generator_intent`).
   - Agreement on strict/swing is 1,952/2,086.
   - Disagreements kept on purpose:
     - 114 strict reps flagged (3% on 35 lb one arm, 8% bilateral, mostly in fatigue and imbalance sets)
     - 17 swings missed (mostly on high-baseline pads, where a pinned delt hides the swing)
5. **Targets come from code.** A seeded template bank gives 3-5 phrasings per verdict category:
   - **Categories:** cheat (with "N times your clean reps"), big swing, cheat with no reference, loose, left/right slacking, too fast, clean, learning, near miss.
   - **Summaries:** set summaries add a context opener to the coach's `fallbackSummary` (plus a "move the pad" hint when `delt_saturated`). Workout summaries and calibration checks come from code too.
   - **Wording rules, enforced at build time** (the build fails otherwise): no "snitch", no raw delt share or shoulder percentage, no load change, no medical words, rep cues ≤ 20 words (max 19, mean 6.4).
   - **Dedupe:** exact (prompt, target) pairs are removed (9 dropped). 779 unique target lines.

## Baseline: does synthetic transfer? (`baseline.md`)

Logistic regression on the engine's absolute per-rep features, strict vs swing, evaluated on **real** reps only:

| Trained on | Real validation (16, 6 swing) | Real test (26, 5 swing) |
|---|---|---|
| **synthetic only** (2,086) | acc 0.88, P 0.75, R 1.00 | **acc 0.96, P 0.83, R 1.00** |
| synthetic + real train | 0.88 / 0.75 / 1.00 | 0.96 / 0.83 / 1.00 |
| real train only (7 band reps) | 0.50 / 0.43 / 1.00 | 0.54 / 0.29 / 1.00 |
| engine flag (fixed rules) | 0.94 / 1.00 / 0.83 | 1.00 / 1.00 / 1.00 |
| majority class | 0.63 | 0.81 |

The synthetic data transfers to this lifter's real 35 lb sessions much better than the 7 real training reps do. It doesn't beat the hand-tuned engine. The engine's thresholds were partly tuned on these recordings, so its test score is optimistic. The classifier rated Mike's "loose" rep P(swing) 0.20.

## Gemma eval (`gemma_eval.md`)

Few-shot `gemma-4-26b-a4b-it` (on our Gemini API key): 5 shots from the **synthetic train split**, 20 held-out pairs from the **real test split** (14 rep cues, 6 set summaries), no fine-tuning.

| | n | Verdict right | ≤ 20 words | No banned words | All three |
|---|---|---|---|---|---|
| Gemma, rep cues | 14 | 14/14 | 14/14 | 14/14 | **14/14** |
| Gemma, set summaries | 6 | 4/6 | 4/6 | 6/6 | 3/6 |
| Gemma, all | 20 | 18/20 | 18/20 | 20/20 | **17/20** (v1 shots: 18/20) |
| Code-written targets | 20 | 20/20 | 14/20 | 20/20 | 14/20 |

- Rep cues are solid.
- **Summaries are where it slips:**
  - On Mike's labelled set it named rep 4 but not 5 and 8.
  - Two summaries ran past 20 words. The code's own summaries are longer by design (the coach allows 40 spoken words), so ≤ 20 is a strict bar for that kind.
  - Once it added a detail beyond the facts ("rep 6 left shoulder was 1.4 times normal" on an all-clean set: true but irrelevant).
- **Latency:** median ~24 s per call, ~1,100 thinking tokens. A fine-tune on `gemma_sft_train.jsonl` (or thinking turned down) is what would make it usable mid-set.

## Fine-tune Gemma (untested snippet)

Not run: no GPU at the event. A minimal Hugging Face TRL + LoRA sketch on the v2 splits. Use the Gemma checkpoint you have access to; a small instruction-tuned one suits a coach voice that should run close to the body.

```python
# pip install "trl>=0.12" peft datasets transformers accelerate   (untested here)
from datasets import load_dataset
from peft import LoraConfig
from trl import SFTConfig, SFTTrainer

ds = load_dataset("json", data_files={
    "train": "gemma_sft_train.jsonl",
    "validation": "gemma_sft_validation.jsonl",   # real only
})
# Gemma's template calls the reply role "model"; TRL's chat format expects "assistant".
to_chat = lambda r: {"messages": [
    {"role": "user", "content": r["messages"][0]["content"]},
    {"role": "assistant", "content": r["messages"][1]["content"]},
]}
ds = ds.map(to_chat, remove_columns=ds["train"].column_names)

trainer = SFTTrainer(
    model="google/gemma-3-1b-it",            # placeholder: use the Gemma checkpoint you have
    train_dataset=ds["train"], eval_dataset=ds["validation"],
    args=SFTConfig(output_dir="gemma-coach-lora", num_train_epochs=2, per_device_train_batch_size=8,
                   learning_rate=2e-4, eval_strategy="epoch", logging_steps=20),
    peft_config=LoraConfig(r=16, lora_alpha=32, target_modules="all-linear", task_type="CAUSAL_LM"),
)
trainer.train()
```

Then score `gemma_sft_test.jsonl` (real only) with `server/scripts/gemma-eval.ts`'s checks: verdict kept, ≤ 20 words, no banned wording. Report test numbers next to the few-shot baseline below.

## How it grows

- **Beat-the-agent walk-ups:** a judge whispers "clean" or "cheat" before each rep. Logged per rep, that's a human label independent of the engine. Each walk-up is a new body (anonymized `walkup-N`).
- **Every live session already stores its raw 200 Hz batches** and set events. Re-running `export-dataset.ts --db <copy>` then `build-dataset-v2.ts` re-judges everything with the current engine. Re-fitting the generator to the growing real set keeps the synthetic data honest.

## Limits (read before using)

- **One lifter, curls only:** 85 real reps from one person on one day and the night before, standing curls with a band or 35 lb dumbbells. No preacher or hammer curls, no other people.
- **Synthetic shapes are modelled**, not recorded:
  - Raised-cosine envelopes, a hand-picked noise model, and a delt that follows the biceps shape.
  - Fitted to the means of a few dozen real reps; the spreads are partly guessed.
  - The fit used the labelled real recordings from all splits (statistics only, no individual reps), so synthetic → real test isn't fully independent.
  - Synthetic agreement between intent and engine is not a quality metric: the engine is the labeller.
- **Metrics are reported on real reps only**, and those sets are tiny (16 validation, 26 test strict/swing reps).
- **Labels:** real labels are phase instructions except Mike's per-rep labels (r82 set 1, zdw, kau). Synthetic labels are generator intent.
- **Nothing is fine-tuned yet.** The Gemma numbers are few-shot.
- **Relative, not medical:** %MVC is relative activation for one person and one pad placement. Not force, not strength, not a medical measurement, and MyoWare isn't a medical device.

## Regenerate

```
cp data/lightweight.sqlite* /tmp/lw/                 # always a COPY
cd server
npx tsx scripts/export-dataset.ts --db /tmp/lw/lightweight.sqlite --no-synthetic --out /tmp/lw/real
npx tsx scripts/build-dataset-v2.ts --real /tmp/lw/real          # -> data/dataset/v2 (--sessions, --seed)
npx tsx scripts/baseline-v2.ts                                   # baseline.md/.json
npx tsx scripts/gemma-eval.ts --data ../data/dataset/v2          # gemma_eval.md/.jsonl (GEMINI_API_KEY in .env)
```

## License and provenance

Data: **CC-BY-4.0**. Real reps were recorded by the project builder on himself (Nov 13-14 2026), who labelled his own live reps. Synthetic reps are generated by project code. The live SQLite file itself isn't published.
