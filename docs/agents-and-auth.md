# Agents & Auth

How SkillCI drives each coding agent, what auth each needs, and how to add a new
adapter.

## The adapter contract

Every agent implements `AgentAdapter`:

```ts
interface AgentAdapter {
  readonly kind: AgentKind;            // 'claude-code' | 'cursor' | 'codex'
  isAvailable(): Promise<boolean>;     // can it run in this environment?
  run(args): Promise<AgentRunResult>;  // drive it headlessly, return telemetry
}
```

`run()` normalizes whatever the agent CLI emits into a common `AgentRunResult`
(transcript, tokens, cost, steps, tool calls, wall-clock). Adapters **degrade
gracefully**: when unavailable they throw a typed `AgentUnavailableError` rather
than crashing, and the orchestrator falls back to the deterministic mock.

## Claude Code

| | |
| --- | --- |
| **Availability** | the `claude` binary on PATH — **that's it**. |
| **Auth** | the CLI owns its own auth: an `ANTHROPIC_API_KEY` **or** a Claude Code subscription/OAuth session. SkillCI does **not** require the env key. |
| **Invocation** | `claude -p "<prompt>" --output-format json --dangerously-skip-permissions` |

Why `--dangerously-skip-permissions`: headless `claude -p` is default-deny on
tool permissions, so without it the agent can't edit files or run commands and
every editing task silently scores as a failure. Runs always happen inside a
**disposable, isolated sandbox**, which is exactly what the flag is for.

> The Claude adapter gates on the binary only — mirroring Cursor — because the
> CLI manages auth itself. The API-key requirement lives solely in the LLM
> judge's SDK backend (see [Scoring](./scoring.md)).

## Cursor

| | |
| --- | --- |
| **Availability** | the `cursor-agent` binary on PATH. |
| **Auth** | Cursor manages its own auth (no separate key check). |
| **Invocation** | `cursor-agent -p "<prompt>" --output-format json` (best-effort). |

Cursor's headless surface is less stable; the adapter parses JSON telemetry when
present and otherwise falls back to text with zeroed token/cost fields. A
timed-out or non-zero run surfaces a typed error rather than a fake success.

## Codex

| | |
| --- | --- |
| **Availability** | the `codex` binary **and** `OPENAI_API_KEY`. |
| **Auth** | key-gated (`OPENAI_API_KEY`). |
| **Invocation** | `codex exec "<prompt>"` (non-interactive). |

Codex's machine output varies by version; the adapter tries JSON first, falls
back to text with zeroed telemetry, and surfaces typed errors on timeout/failure.

## The mock adapter

`MockAgentAdapter` is deterministic and offline — no network, no keys. It powers
the test suite and `npm run demo`, and is the fallback whenever a real adapter is
unavailable. This is what makes the whole pipeline runnable in CI for free.

## Adding a new adapter

1. Create `src/agents/<name>-adapter.ts` implementing `AgentAdapter`.
2. `isAvailable()` — probe the binary (`hasBinary`) and, only if the CLI can't
   self-auth, the key (`hasEnv`). Prefer binary-only when the CLI owns its auth.
3. `run()` — spawn via `execa` inside `args.sandbox.workdir`, honor
   `task.timeoutMs`, and normalize output into `AgentRunResult`. Don't fabricate
   a zeroed "success" for a timeout/non-zero run — throw a typed error.
4. Register it so `getAdapter(kind)` resolves it.
5. Tests: mock `execa` to pin the **invocation contract** (flags, cwd) and the
   availability logic. Never spawn real CLIs in unit tests. See
   `claude-invocation.test.ts` and `real-adapters.test.ts` for the pattern.
