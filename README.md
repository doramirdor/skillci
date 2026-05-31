# SkillCI

**A CI/CD layer for coding-agent configuration.** SkillCI tests, validates, and
promotes agent config artifacts — skills, hooks, rules, instructions, slash
commands, settings — *before* a team trusts them in Claude Code, Cursor, or
Codex.

You wouldn't merge an untested code change. SkillCI applies the same rigor to
the configuration that steers your coding agents.

## The flow: baseline vs. candidate vs. regression

1. A **candidate** is a proposed change to one or more agent config artifacts.
2. SkillCI runs a suite of sandboxed repo **tasks** twice: once with the
   **baseline** (current, trusted) config, once with the **candidate** config.
3. Each task runs a target coding agent **headlessly** against an isolated
   fixture repo with a defined prompt.
4. A **comparator** aggregates scores, computes baseline-vs-candidate deltas,
   and emits a **verdict**: `improved` / `neutral` / `regressed` (with an
   explicit list of regressions).
5. A **pull request is opened ONLY** when the verdict is `improved` with **zero
   hard regressions**.

## Three scoring dimensions

Every task outcome is scored three ways and aggregated into a single composite:

1. **Objective checks** — deterministic pass/fail: command exit codes, file
   existence, file contents, test suites, expected diffs.
2. **LLM-as-judge** — a rubric-scored qualitative judgment (with prompt
   caching) for things objective checks can't capture.
3. **Cost / efficiency** — tokens, tool calls, steps, and wall-clock time.

## Supported agents (all three in the MVP)

| Agent       | Artifacts                                                       | Headless invocation                       |
| ----------- | -------------------------------------------------------------- | ----------------------------------------- |
| Claude Code | skills, hooks, slash commands, `CLAUDE.md`, `.claude/settings.json` | `claude -p "<prompt>" --output-format json` |
| Cursor      | `.cursor/rules/*.mdc`, `.cursorrules`                          | `cursor-agent` CLI (best-effort)          |
| Codex       | `AGENTS.md` / codex config                                    | `codex exec`                              |

Everything runs **fully offline** in tests and in the demo via a deterministic
`MockAgentAdapter` — no network, no API keys. Real adapters are used only when
their CLI/API key is available and degrade gracefully otherwise.

## Quickstart

```bash
npm install
npm run demo      # offline, deterministic end-to-end run via the mock adapter
npm test          # run the test suite (offline)
npm run typecheck # type-check without emitting
```

## Architecture

SkillCI is built as self-contained modules, each in its own directory with
colocated tests. All of them compile against the shared contracts in
[`src/core/contracts.ts`](src/core/contracts.ts).

| Module                | Responsibility                                                            |
| --------------------- | ------------------------------------------------------------------------- |
| `core`                | Canonical type contracts and zod schemas for the whole domain.            |
| `artifacts`           | Discover & normalize agent config into `Artifact` / `ConfigSet`.          |
| `sandbox`             | Create isolated fixture workdirs, run commands, compute file diffs.       |
| `agents`              | Agent adapters (Claude/Cursor/Codex + deterministic mock).                |
| `tasks`               | Load and validate task suites and fixtures.                               |
| `scoring`             | Apply objective checks, LLM judge, and cost telemetry into `Score`s.      |
| `compare`             | Aggregate scores, compute deltas, and emit the `Verdict`.                 |
| `report`              | Render human-readable run reports.                                        |
| `pr`                  | Open a GitHub PR (via `gh`) when the verdict warrants it.                 |
| `cli` / `orchestrator`| Wire it all together; the `skillci run` command.                          |

## License

MIT
