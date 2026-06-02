# Concepts

The core ideas behind SkillCI and how a verdict is decided.

## Config artifacts

The things SkillCI tests are **agent configuration artifacts** — the files that
steer a coding agent's behavior:

- **Claude Code:** `CLAUDE.md`, `.claude/skills/**`, `.claude/hooks/**`,
  `.claude/commands/*.md`, `.claude/settings.json`.
- **Cursor:** `.cursor/rules/*.mdc`, `.cursorrules`.
- **Codex:** `AGENTS.md` / codex config.

A directory of these, discovered and normalized, becomes a **`ConfigSet`**.

## Baseline vs. candidate

- **Baseline** — the current, trusted config. The control.
- **Candidate** — the proposed change. The treatment.

SkillCI runs the same task suite under each and compares. This A/B structure is
what lets it attribute a behavior change to the config change rather than to
noise — though see the [caveat on variance](#a-note-on-determinism).

## Tasks & fixtures

A **task** is a unit of work the agent attempts:

- a **fixture** repo (copied fresh into an isolated sandbox per run),
- a **prompt** handed to the agent headlessly,
- **objective checks** evaluated after the run,
- an optional **judge rubric**,
- a per-task **timeout**.

See [Writing Tasks](./writing-tasks.md).

## The three scoring dimensions

Every run is scored on three axes, folded into one **composite** in `[0, 1]`:

| Dimension | Weight | Meaning |
| --------- | :----: | ------- |
| **Objective** | `0.6` | Deterministic checks: did files/commands/tests come out right? |
| **LLM-as-judge** | `0.4` | Rubric-scored quality for what objective checks can't capture. |
| **Cost / efficiency** | `±0.1` adj. | Tokens/steps/time — a *relative* bonus or penalty vs. the baseline run. |

Objective and judge form a weighted base (the judge is re-weighted out when
absent, so objective alone still scores). Cost is a small adjustment on top. See
[Scoring](./scoring.md) for the exact formula.

## The verdict

The comparator aggregates per-task composites into one of three verdicts:

| Verdict | Meaning |
| ------- | ------- |
| `improved` | Candidate is better, with **zero hard regressions**. |
| `neutral` | No meaningful change. |
| `regressed` | Candidate is worse on at least one hard dimension. |

## The regression gate (fail-closed)

A candidate is **blocked from promotion** if any of these hold (defaults shown):

- **Objective drop** — fewer objective checks pass on any task
  (`objectiveDropIsRegression: true`).
- **Per-task composite drop** beyond `regressionCompositeDrop: 0.05`.
- **Net composite gain** `≤ minCompositeGain: 0.01` → at best `neutral`, not `improved`.
- A **dropped task** or any **non-finite** score.

Promotion (`shouldPromote()` → open a PR) requires `improved` **and** zero hard
regressions. The gate is deliberately conservative: when in doubt, it does **not**
promote.

`skillci run` exits non-zero **only** on `regressed`, so a `neutral` candidate
doesn't break your build — it just doesn't get a PR.

## A note on determinism

Objective checks, the composite math, and the gate are deterministic. **Real
agent runs are not** — token cost and the agent's exact output vary run-to-run.
A single live run is a useful signal, not a verdict to bet the farm on. For
trustworthy automated promotion, average multiple runs and/or widen the cost
tolerance (see the roadmap in the [README](../README.md)). The offline demo and
the test suite are fully deterministic.

## Where the pieces live

See [Architecture](./architecture.md) for the module map and data flow.
