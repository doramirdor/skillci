# Architecture

SkillCI is a set of small, single-responsibility modules under `src/<module>/`,
each with colocated `*.test.ts`, all compiling against the shared contracts in
[`src/core/contracts.ts`](../src/core/contracts.ts).

## Module map

| Module | Responsibility | Key exports |
| ------ | -------------- | ----------- |
| `core` | Canonical types + zod schemas for the whole domain. | `Task`, `ConfigSet`, `ObjectiveCheck`, `AgentRunResult`, `Score`, `Verdict`, `Comparison`, `Thresholds`, `AgentAdapter` |
| `artifacts` | Discover & normalize agent config; diff config sets. | `discoverConfigSet`, `applyConfigSet`, `diffConfigSets` |
| `sandbox` | Isolated fixture workdirs, command exec (timeout + process-group kill), file diffs. | `createSandbox`, `withSandbox`, `LocalSandboxBackend` |
| `agents` | Agent adapters + availability/error helpers. | `ClaudeCodeAdapter`, `CursorAdapter`, `CodexAdapter`, `MockAgentAdapter`, `getAdapter` |
| `tasks` | Load & validate task suites and fixtures. | `loadTasks`, `getSampleTasks` |
| `scoring` | Objective checks, LLM judge (SDK/CLI), cost, composite. | `runObjectiveChecks`, `judgeWithLLM`, `claudeCliJudge`, `costMetrics`, `composite`, `computeScore` |
| `compare` | Aggregate scores → deltas → verdict; promotion rule. | `compareOutcomes`, `shouldPromote` |
| `report` | Render JSON / markdown / colorized terminal reports. | `renderTerminalReport`, `renderMarkdownReport`, `renderJsonReport` |
| `pr` | Open a GitHub PR via `gh`, gated on verdict (dry-run default). | PR opener |
| `orchestrator` | Wire a full baseline-vs-candidate run. | `runEvaluation`, `runDemo` |
| `cli` | The `skillci run\|validate\|tasks` commands. | bin entry |

## Data flow (one `run`)

```
discoverConfigSet(baseline) ─┐
discoverConfigSet(candidate) ┘
                             │
   for each task:            ▼
     ┌─────────────── runOneSide(baseline) ───────────────┐
     │ createSandbox(fixture) → applyConfigSet            │
     │ → adapter.run(claude -p …) → AgentRunResult        │
     │ → computeScore:                                    │
     │     runObjectiveChecks · judge · costMetrics       │
     │     → composite → Score                            │
     └────────────────────────────────────────────────────┘
     (same for candidate, scored RELATIVE to baseline cost)
                             │
   compareOutcomes(baseline, candidate, thresholds)
                             │
              Comparison { verdict, regressions, deltas }
                             │
        renderReport(…)  +  shouldPromote() → pr.open() / dry-run
                             │
              CLI exit: non-zero iff verdict === 'regressed'
```

## Design principles

- **One source of truth.** Every module compiles against `core/contracts.ts`
  (types + zod). Schemas validate at the boundaries (task loading, config
  discovery, judge output) so bad data fails fast with a typed error.
- **Offline by default.** The `MockAgentAdapter` makes the entire pipeline run
  with no network/keys — that's what tests and the demo use, and the fallback
  when a real agent is unavailable.
- **Graceful degradation.** Real adapters and the judge never throw to crash a
  run — missing CLI/key → typed unavailability or a dropped (re-weighted)
  dimension.
- **Fail-closed gate.** `compare` treats any objective drop, over-threshold
  per-task drop, dropped task, or non-finite score as a hard regression; promotion
  requires `improved` with none of those.
- **Sandboxes are disposable.** Each run gets a fresh recursive copy of the
  fixture (minus `.git`/`node_modules`) under `os.tmpdir()`, always disposed —
  even on throw (`withSandbox`). Command timeouts kill the whole **process group**
  so a forked grandchild can't keep the run alive.
- **Pluggable backends/backplanes.** `SandboxBackend` (local today, container
  later), `AgentAdapter` (per agent), and the judge `JudgeFn` (SDK or CLI) are all
  swappable behind interfaces.

## Testing model

- Unit tests are colocated and offline. CLIs are never spawned for real in unit
  tests — `execa` is mocked to pin invocation contracts.
- `compare`, `composite`, and the gate are exhaustively unit-tested
  (deterministic).
- The offline demo (`npm run demo`) is an end-to-end smoke that doubles as a CI
  gate. See [CI Integration](./ci-integration.md).
