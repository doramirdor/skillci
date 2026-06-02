# CI Integration

Use SkillCI as a **PR gate**: every change to your agent config gets evaluated,
and a regression blocks the merge.

## The idea

`skillci run` exits **non-zero only when the verdict is `regressed`**. Drop it in
a job triggered on PRs that touch config paths, point it at the trusted config
(baseline) and the PR's config (candidate), and let the exit code gate the merge.

## GitHub Actions

A ready-to-copy template lives at
[`.github/workflows/skillci-gate.example.yml`](../.github/workflows/skillci-gate.example.yml).
Minimal shape:

```yaml
name: skillci-gate
on:
  pull_request:
    paths:
      - '.claude/**'
      - 'CLAUDE.md'
      - '.cursor/**'
      - 'AGENTS.md'

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # need base + head to diff configs

      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      - name: Install SkillCI
        run: |
          git clone --depth 1 https://github.com/doramirdor/skillci skillci-tool
          cd skillci-tool && npm ci && npm run build && npm link

      - name: Gate the config change
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}   # optional → SDK judge
        run: |
          # Materialize baseline (PR base) and candidate (PR head) config dirs,
          # then evaluate. Exits non-zero only on a regression.
          skillci run --agent claude-code \
            --baseline "$BASELINE_DIR" --candidate "$CANDIDATE_DIR"
```

## Auth in CI

- **Subscription/OAuth** isn't available on a fresh CI runner, so for **live**
  Claude runs in CI you'll typically provide `ANTHROPIC_API_KEY` (used by the
  SDK judge, and the `claude` CLI can use it too).
- **No key?** The job still runs end-to-end via the **mock adapter** — useful for
  exercising the pipeline, parsing, and the gate wiring, but it won't reflect real
  agent behavior. For a meaningful live gate, supply a key.
- Store keys as repository/organization **secrets**, never in the workflow file.

## Exit codes & branch protection

| Verdict | Exit | PR effect |
| ------- | :--: | --------- |
| `improved` | 0 | passes (and is promotable) |
| `neutral` | 0 | passes — no PR opened, but doesn't block |
| `regressed` | non-zero | **fails the job** |

Make the `skillci-gate` job a **required status check** in branch protection so a
regression actually blocks merge.

## Opening PRs automatically

With `--open-pr` and `gh` authenticated, SkillCI opens a PR when the candidate is
promotable (`improved`, zero hard regressions). Without it, promotion is a
**dry-run** (the plan is computed and reported, no PR created) — the default, and
the right choice for a gate that only needs to pass/fail.

## A note on variance

Live verdicts are non-deterministic (cost especially). For an unattended gate,
prefer gating on **hard objective regressions** (deterministic) and treat the
composite/cost delta as advisory until you add multi-run averaging. See
[Concepts → determinism](./concepts.md#a-note-on-determinism).

## This repo's own CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs typecheck + tests
+ the offline demo on Node 20 and 22 for every push/PR — the demo doubles as an
end-to-end gate (non-zero on a regressed verdict), fully offline.
