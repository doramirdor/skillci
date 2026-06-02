# Troubleshooting & FAQ

## "Agent 'claude-code' is not available — using the offline MockAgentAdapter"

The real adapter couldn't be used, so SkillCI fell back to the mock. Checklist:

- Is the `claude` binary on PATH? `command -v claude`.
- Is it authenticated? Run `claude -p "say hi"` manually — if that works, the
  adapter will too (subscription/OAuth is fine; no API key needed).
- For Codex you additionally need `OPENAI_API_KEY`; for Cursor, the
  `cursor-agent` binary.

## The run uses the mock even though `claude` works

`run` falls back to **demo mode** when `--baseline` *or* `--candidate` is
missing. Pass both directories for a live evaluation.

## The agent runs but doesn't edit files / every task "fails" objective checks

The Claude adapter passes `--dangerously-skip-permissions` precisely to avoid
this (headless `claude -p` is otherwise default-deny on tools). If you've
customized the invocation, ensure that flag is present — without it the agent
can't write files or run commands.

## The judge is always skipped

The judge needs a backend:

- Set `ANTHROPIC_API_KEY` to use the **SDK** judge, **or**
- ensure the `claude` binary is present (and you're judging `claude-code`) to use
  the **CLI** judge automatically.

Also confirm the task actually has a `judgeRubric` — no rubric means no judging
(the dimension is dropped by design).

## Verdict flips between runs / cost numbers wobble

Expected. Real agent runs are **non-deterministic** — token cost especially. A
single live verdict is a signal, not gospel. Use the deterministic offline demo
for reproducible checks, and for automated promotion lean on hard objective
regressions plus multi-run averaging. See
[Concepts → determinism](./concepts.md#a-note-on-determinism).

## A command "hangs" or hits its timeout

Per-task budget is `timeoutMs` (default 120s). On timeout, SkillCI SIGKILLs the
whole **process group**, so even a shell that forked a child is reclaimed
promptly; the check is reported as a non-zero/timed-out result. If your task
legitimately needs longer, raise `timeoutMs` in the `task.json`.

## `npm ci` fails in CI

Ensure `package-lock.json` is committed and in sync with `package.json`. The CI
workflow uses `npm ci`, which requires a matching lockfile.

## GitHub Actions deprecation warning about Node 20

A non-blocking warning that `actions/checkout`/`setup-node` run on the Node 20
**action runtime** (unrelated to your test matrix). Bump action versions when a
Node-24-compatible release is available; nothing breaks today.

## "fixture directory does not exist"

`fixtureDir` in `task.json` is resolved **relative to the task file's own
directory**. Use `"."` for "the fixture lives next to this `task.json`," and
make sure the fixture files are present.

## Tests pass locally but fail in CI

CI is a different (often slower) environment with a different `/bin/sh` (dash on
Ubuntu). Timing- and shell-sensitive tests can behave differently — give such
tests explicit budgets and avoid relying on shell-specific behavior. (The sandbox
timeout test is a worked example: it needed process-group kill to be portable.)

## Where do I see the full report?

`skillci run` prints a colorized terminal report. The orchestrator also produces
markdown and JSON reports (`report` module) for programmatic use.

## Still stuck?

Open an issue (templates provided) with the command, the agent, offline-vs-live,
and the output. For security issues, see [SECURITY.md](../SECURITY.md).
