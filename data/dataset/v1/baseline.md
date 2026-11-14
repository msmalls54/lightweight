# Baseline: strict vs swing from engine features (v1)

Real labelled reps only: **40** (15 swing, 25 strict) from **5** recordings. Synthetic rows are not used. Leave-one-recording-out: each recording is held out once, the models train on the rest.

Features (absolute, per rep, the rep's own arm; no clean reference): `up_delt_ratio`, `delt_share`, `delt_peak`, `delt_mean`, `biceps_peak`, `biceps_mean`, `up_s`, `duration_s`. Logistic regression: standardized, L2 0.1, 3000 GD steps, threshold 0.5. Stump: best single feature/threshold on the training folds.

## Pooled over the held-out folds (positive = swing)

| Model | n | Accuracy | Precision | Recall | Confusion |
|---|---|---|---|---|---|
| engine_flag (fixed rules) | 40 | 0.90 | 1.00 | 0.73 | TP 11 FP 0 TN 25 FN 4 |
| logistic regression | 40 | 0.95 | 1.00 | 0.87 | TP 13 FP 0 TN 25 FN 2 |
| decision stump | 40 | 0.72 | 0.61 | 0.73 | TP 11 FP 7 TN 18 FN 4 |
| majority class | 40 | 0.63 | n/a | 0.00 | TP 0 FP 0 TN 25 FN 15 |

## Per held-out recording

| Held out | n (swing) | engine acc | logreg acc | stump acc | stump rule learned |
|---|---|---|---|---|---|
| 2026-11-13-bench | 7 (4) | 0.57 | 0.86 | 0.71 | delt_mean > 0.562 |
| 2026-11-14-right-35lb-strict-vs-swing | 8 (3) | 1.00 | 1.00 | 0.75 | delt_share > 0.527 |
| 2026-11-14-fulltest-35lb-bilateral | 13 (6) | 0.92 | 0.92 | 0.54 | up_delt_ratio > 0.832 |
| live:s-1114-122526-r82 | 9 (2) | 1.00 | 1.00 | 1.00 | delt_peak > 0.962 |
| live:s-1114-123449-zdw | 3 (0) | 1.00 | 1.00 | 0.67 | delt_peak > 0.962 |

## Mike's "loose" rep (not in the metrics)

- `live:s-1114-122526-r82/set1/rep5-R`: engine flag true, logreg P(swing) 0.01, stump strict

## Logistic regression trained on all real rows (standardized weights)

| Feature | Weight |
|---|---|
| up_delt_ratio | 0.51 |
| delt_share | 0.30 |
| delt_peak | 0.36 |
| delt_mean | 0.51 |
| biceps_peak | 0.33 |
| biceps_mean | 0.29 |
| up_s | -0.37 |
| duration_s | -0.82 |

## Read this before quoting a number

- **Tiny:** one person, 5 recordings, 2 days. Each fold is one recording, so one odd recording moves the pooled numbers a lot.
- **The engine is not a held-out model.** Its thresholds were tuned by hand on these same real recordings (Nov 13 band, both Nov 14 35 lb files), so its row is closer to a training score than a test score. Only the live sessions (r82, zdw) were recorded after the last threshold change; they are its fairest test.
- **Labels are instructions, not observations**, except the live r82/zdw sets, which Mike labelled per rep. A rep in a "swing" phase can be a light or failed swing.
- **The engine has state the classifier lacks:** it compares each rep with the lifter's own clean reps in the session. The classifier sees one rep at a time, in absolute %MVC, which depends on pad placement and calibration.
- Synthetic rows are deliberately excluded: they are generated to match the engine's rules, so scoring on them would be circular.
