# Getting Started

This guide takes you from clone to your first verdict — offline first (zero
cost), then live.

## Prerequisites

- **Node ≥ 20** (CI runs 20 and 22).
- For **live** runs against Claude: the `claude` CLI installed and authenticated
  (a Claude Code **subscription/OAuth session is enough — no API key required**).
- Optional: `gh` (GitHub CLI) if you want SkillCI to open PRs.

## 1. Install & verify (offline)

```bash
git clone https://github.com/doramirdor/skillci
cd skillci
npm install

npm run typecheck   # tsc --noEmit
npm test            # full suite, fully offline
npm run demo        # end-to-end run via the deterministic mock adapter
```

`npm run demo` exercises the *entire* pipeline — discover config → sandbox →
run → score → compare → verdict → PR dry-run — with no network and no keys. You
should see a colorized report ending in `VERDICT: IMPROVED` and exit code `0`.

## 2. Understand the output

A run prints, per task, the composite score for baseline → candidate and the
deltas, then a totals block and a verdict:

```
SkillCI — VERDICT: IMPROVED
  add-input-validation: composite 0.98 -> 1 (+0.02), objΔ 0, costΔ -0.01
  ...
Totals
  objective 7/7 -> 7/7
  net composite +0.04
  PROMOTABLE — eligible to open a PR
```

- **objΔ** — change in objective checks passed.
- **costΔ** — cost-term change (cheaper candidate = positive).
- **PROMOTABLE** appears only when the verdict is `improved` with zero hard
  regressions. See [Concepts](./concepts.md).

## 3. Your first live run (subscription, no API key)

Build the CLI, then evaluate a real config change with the real Claude agent:

```bash
npm run build

node dist/cli/index.js run \
  --agent claude-code \
  --baseline ./path/to/baseline-config \
  --candidate ./path/to/candidate-config
```

- `--baseline` / `--candidate` are **directories** containing agent config
  (e.g. a `CLAUDE.md` and/or a `.claude/` tree). SkillCI discovers the artifacts
  in each and applies them to the sandbox before each run.
- With no `--tasks`, the bundled sample tasks are used. See
  [Writing Tasks](./writing-tasks.md) to author your own.
- The agent runs via `claude -p`. The LLM judge also runs via `claude -p` when
  no `ANTHROPIC_API_KEY` is set; export that key to use the Anthropic SDK judge
  instead.

> **Exit codes:** `0` for `improved`/`neutral`, **non-zero only for `regressed`** —
> so you can use the command directly as a CI gate.

## 4. A minimal config pair to try

```
baseline/CLAUDE.md     ->  "# Project\nA small TypeScript project."
candidate/CLAUDE.md    ->  baseline + "## Conventions\n- Make the minimal change.\n- ..."
```

```bash
node dist/cli/index.js run --agent claude-code \
  --baseline ./baseline --candidate ./candidate
```

SkillCI runs each bundled task twice and tells you whether the candidate's extra
guidance actually helped — and at what cost.

## Project layout

```
src/
  core/         shared types + zod schemas (the contracts)
  artifacts/    discover & normalize agent config
  sandbox/      isolated fixture workdirs + command exec
  agents/       Claude / Cursor / Codex adapters + mock
  tasks/        task + fixture loader
  scoring/      objective checks · LLM judge · cost · composite
  compare/      deltas + verdict + shouldPromote()
  report/       JSON / markdown / terminal reports
  pr/           gh-based PR opener (gated)
  orchestrator/ wires a full run
  cli/          the `skillci` command
fixtures/       bundled sample tasks
docs/           you are here
```

## Next

- [Concepts](./concepts.md) — the verdict model and scoring.
- [Writing Tasks](./writing-tasks.md) — author your own evaluation suite.
- [CI Integration](./ci-integration.md) — make it a PR gate.
