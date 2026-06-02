# Scoring

How a single run becomes a number, and how two runs become a verdict.

## The composite

Each (task, config) run yields a **composite score in `[0, 1]`**, combining
three dimensions:

```
obj01   = objective checks passed / total            (1.0 when a task has no checks)
judge01 = judge.score0to1                             (omitted when no rubric/judge)

base    = (W_OBJ · obj01 + W_JUDGE · judge01) / (W_OBJ + W_JUDGE_eff)
composite = clamp(base + costAdjustment, 0, 1)
```

Constants (`src/scoring/composite.ts`):

| Constant | Value | Role |
| -------- | :---: | ---- |
| `W_OBJ` | `0.6` | Objective weight. |
| `W_JUDGE` | `0.4` | Judge weight. **`W_JUDGE_eff = 0` when there's no judge score**, so objective alone fully determines `base`. |
| `COST_WEIGHT` | `0.1` | Magnitude cap of the cost adjustment. |

So objective correctness dominates, the judge refines it, and cost nudges.

### Objective dimension

`runObjectiveChecks` executes every check against the post-run sandbox and
returns `{ passed, total }`. `obj01 = passed/total`; a task with **no checks**
scores a neutral `1.0` on this axis (it can't fail what it doesn't assert).

### Judge dimension

Best-effort and optional. Returns `{ score0to1, rationale }` or `undefined`.
Two interchangeable backends:

- **SDK** (`judgeWithLLM`) — Anthropic SDK, prompt-cached. Needs `ANTHROPIC_API_KEY`.
- **CLI** (`claudeCliJudge`) — runs `claude -p --output-format json`. Works on a
  Claude subscription with **no API key**. Pure text reasoning: no sandbox, no
  `--dangerously-skip-permissions`.

If neither is available, the dimension is dropped (re-weighted out) — judging
**never throws** to break a run.

### Cost dimension

`costMetrics` projects tokens, tool calls, steps, and wall-clock from the run.
The candidate's cost is scored **relative to the baseline run** (`reference`):
cheaper → positive adjustment, pricier → negative, bounded by `COST_WEIGHT`. The
baseline itself is scored with a neutral cost term.

> Cost is the **noisy** axis on live runs — see [Concepts → determinism](./concepts.md#a-note-on-determinism).

## From scores to a verdict

The comparator sums per-task composite deltas and applies the thresholds
(`ThresholdsSchema`, all overridable):

| Threshold | Default | Effect |
| --------- | :-----: | ------ |
| `minCompositeGain` | `0.01` | Net gain must exceed this to be `improved` (else `neutral`). |
| `regressionCompositeDrop` | `0.05` | A per-task composite drop beyond this magnitude is a **hard regression**. |
| `objectiveDropIsRegression` | `true` | Any drop in objective checks passed on any task is a **hard regression**, regardless of gains elsewhere. |

### Verdict

- `improved` — net gain `> minCompositeGain` **and** zero hard regressions.
- `neutral` — no meaningful change.
- `regressed` — at least one hard regression (objective drop, per-task drop
  beyond threshold, dropped task, or non-finite score).

### Promotion

`shouldPromote()` returns true **only** for `improved` with zero hard
regressions — the single condition under which the `pr` module will open a PR.
The gate is **fail-closed**: ambiguity never promotes.

## Tuning

Pass custom thresholds through the orchestrator/programmatic API when the
defaults don't fit your risk tolerance — e.g. raise `minCompositeGain` to demand
a larger win, or widen `regressionCompositeDrop` to tolerate small wobbles. The
hard objective rule should generally stay on.
