# Contributing to SkillCI

Thanks for your interest! SkillCI is a TypeScript/Node (ESM, strict) project.

## Setup

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest, fully offline
npm run build       # emit dist/
npm run demo        # offline end-to-end run
```

## Ground rules

- **Everything must run offline.** Tests and the demo use the deterministic
  `MockAgentAdapter` — no network, no API keys. Real adapters/judge are gated on
  CLI/auth availability and must **degrade gracefully** (never throw to crash a run).
- **Colocate tests** as `*.test.ts` next to the code they cover.
- **Compile against `src/core/contracts.ts`.** Shared types and zod schemas live
  there; extend them rather than inventing parallel shapes.
- **Keep the regression gate fail-closed.** Any change to `compare/` must preserve
  the invariant that an objective pass-rate drop (or dropped task, or non-finite
  score) blocks promotion.

## Before opening a PR

1. `npm run typecheck && npm test && npm run build` all green.
2. `npm run demo` still prints `VERDICT: IMPROVED` and exits `0`.
3. Add/adjust tests for your change.
4. Describe the change and how you verified it.

## Adding a new agent adapter

Implement `AgentAdapter` (`isAvailable()` + `run()`), gate on the agent's own
auth model, normalize its output into `AgentRunResult`, and add availability +
invocation tests (mock `execa` — don't spawn real CLIs in unit tests).

By submitting a contribution you agree to license it under the project's
[MIT License](LICENSE).
