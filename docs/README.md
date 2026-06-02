# SkillCI Documentation

Welcome! SkillCI is **CI/CD for coding-agent configuration** — it tests, scores,
and gates changes to your skills, hooks, rules, and `CLAUDE.md` before you trust
them in Claude Code, Cursor, or Codex.

## Start here

| Guide | What it covers |
| ----- | -------------- |
| [Getting Started](./getting-started.md) | Install, run the offline demo, your first live evaluation, project layout. **Read this first.** |
| [Concepts](./concepts.md) | Baseline vs candidate, the verdict model, the three scoring dimensions, the regression gate. |
| [CLI Reference](./cli-reference.md) | Every command, flag, and exit code. |
| [Writing Tasks](./writing-tasks.md) | Author task fixtures, objective checks, and judge rubrics. |
| [Scoring](./scoring.md) | The composite formula, thresholds, and how a verdict is decided. |
| [Agents & Auth](./agents-and-auth.md) | Claude/Cursor/Codex adapters, auth models, and adding a new adapter. |
| [CI Integration](./ci-integration.md) | Wire SkillCI into GitHub Actions as a PR gate. |
| [Architecture](./architecture.md) | Module-by-module map, data flow, and the shared contracts. |
| [Troubleshooting](./troubleshooting.md) | Common issues and FAQ. |

## The one-paragraph mental model

You point SkillCI at two versions of an agent's config — the **baseline**
(trusted) and a **candidate** (proposed change). It runs a suite of sandboxed
**tasks** twice, once per config, driving a real coding agent headlessly. Each
run is scored three ways (objective checks, LLM judge, cost), the scores are
compared, and a **verdict** (`improved` / `neutral` / `regressed`) comes out. A
PR is opened **only** when the candidate is `improved` with zero hard
regressions. Everything also runs fully offline via a deterministic mock.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) and the
[Architecture guide](./architecture.md).
