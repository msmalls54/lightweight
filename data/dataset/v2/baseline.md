# Baseline v2: does synthetic data transfer to real reps?

Logistic regression (class-balanced, L2 0.1) on the engine's absolute per-rep features (`up_delt_ratio`, `delt_share`, `delt_peak`, `delt_mean`, `biceps_peak`, `biceps_mean`, `up_s`, `duration_s`), strict vs swing. Training sets differ; **evaluation is always on REAL reps** from recordings never used for training (split by recording).

Train sizes: synthetic 2086 (138 swing), real train 7 (4 swing). Real validation 16 (6 swing), real test 26 (5 swing).

| Trained on | Evaluated on (real) | n | Accuracy | Precision (swing) | Recall (swing) | Confusion |
|---|---|---|---|---|---|---|
| synthetic + real train | validation | 16 | 0.88 | 0.75 | 1.00 | TP 6 FP 2 TN 8 FN 0 |
| synthetic + real train | test | 26 | 0.96 | 0.83 | 1.00 | TP 5 FP 1 TN 20 FN 0 |
|  | loose rep `live:s-1114-122526-r82/set1/rep5-R` | 1 | P(swing) 0.20 | | | |
| synthetic only | validation | 16 | 0.88 | 0.75 | 1.00 | TP 6 FP 2 TN 8 FN 0 |
| synthetic only | test | 26 | 0.96 | 0.83 | 1.00 | TP 5 FP 1 TN 20 FN 0 |
| real train only (Nov 13 band, 7 reps) | validation | 16 | 0.50 | 0.43 | 1.00 | TP 6 FP 8 TN 2 FN 0 |
| real train only (Nov 13 band, 7 reps) | test | 26 | 0.54 | 0.29 | 1.00 | TP 5 FP 12 TN 9 FN 0 |
| engine flag (fixed rules, not trained) | validation | 16 | 0.94 | 1.00 | 0.83 | TP 5 FP 0 TN 10 FN 1 |
| engine flag (fixed rules, not trained) | test | 26 | 1.00 | 1.00 | 1.00 | TP 5 FP 0 TN 21 FN 0 |
| majority class (strict) | validation | 16 | 0.63 | n/a | 0.00 | TP 0 FP 0 TN 10 FN 6 |
| majority class (strict) | test | 26 | 0.81 | n/a | 0.00 | TP 0 FP 0 TN 21 FN 5 |

Read with care: the real validation/test sets are tiny (one lifter, 5 recordings), the engine's thresholds were tuned on some of these recordings, and synthetic shapes are modelled from the same few real recordings, so "transfer" here means "to this lifter's other sessions", not to new people.
