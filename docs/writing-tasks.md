# Writing Tasks

A **task** is one unit of work the agent attempts, plus how to score the result.
Tasks live as `task.json` files, each beside the fixture repo it operates on.

## Anatomy

A task directory:

```
my-tasks/
  fix-typo/
    task.json
    README.md          # + any other fixture files the task needs
```

`task.json`:

```json
{
  "id": "fix-readme-typo",
  "title": "Fix the typos in README.md",
  "agent": "claude-code",
  "fixtureDir": ".",
  "prompt": "README.md has two typos: 'libary' -> 'library' and 'recieve' -> 'receive'. Fix both and change nothing else.",
  "checks": [
    { "kind": "fileExists",   "path": "README.md" },
    { "kind": "fileContains", "path": "README.md", "substring": "library" },
    { "kind": "fileContains", "path": "README.md", "substring": "receive" }
  ],
  "timeoutMs": 60000
}
```

### Fields

| Field | Type | Notes |
| ----- | ---- | ----- |
| `id` | string | Unique within the suite. |
| `title` | string | Human-readable. |
| `agent` | `claude-code` \| `cursor` \| `codex` | Which agent this task targets. |
| `fixtureDir` | string | Path to the fixture repo, **relative to the task file's own directory** (`"."` = this dir). Copied fresh into a sandbox per run. |
| `prompt` | string | Handed to the agent headlessly. |
| `checks` | ObjectiveCheck[] | Evaluated after the run (default `[]`). |
| `judgeRubric` | `{ criteria: string }` | Optional. Enables the LLM judge for this task. |
| `timeoutMs` | int > 0 | Per-task wall-clock budget (default `120000`). |

> The fixture's `.git` and `node_modules` are **not** copied into the sandbox.

## Objective checks

Deterministic pass/fail. Four kinds (discriminated on `kind`):

```jsonc
// 1. command — run a shell command in the sandbox; pass on the expected exit
{ "kind": "command", "cmd": "npm run lint", "expectExitZero": true }

// 2. fileExists — a path (relative to the sandbox) must exist
{ "kind": "fileExists", "path": "src/util/slugify.ts" }

// 3. fileContains — a file must contain a substring
{ "kind": "fileContains", "path": "src/util/slugify.ts", "substring": "export function slugify" }

// 4. testSuite — run a test command; passes when it exits 0
{ "kind": "testSuite", "cmd": "npm test" }
```

`expectExitZero` defaults to `true`; set it `false` to assert a command *fails*.
Design checks so they are **unambiguous and config-independent** — they should
verify the *outcome*, not how the agent got there.

## Judge rubric

Add a rubric to score quality beyond pass/fail. Keep criteria specific and
behavior-focused:

```json
{
  "judgeRubric": {
    "criteria": "Did the agent make the minimal change? Penalize touching unrelated files, missing edge cases, or undocumented exported functions."
  }
}
```

When a `judgeRubric` is present and a judge backend is available, the run is
scored qualitatively (weight `0.4`). With no rubric, the judge dimension is
simply omitted and objective alone carries the base score. See [Scoring](./scoring.md).

## Tips for tasks that discriminate

The point is to tell a *good* config from a *bad* one. A task only does that if
the config can plausibly change the outcome:

- Pick tasks where guidance matters (conventions, edge cases, "don't do X").
- Mix objective checks (the floor) with a rubric (the nuance).
- Avoid tasks a strong agent always passes regardless of config — they produce
  `neutral` and tell you nothing.
- Keep fixtures small; the sandbox is copied per run, twice per task.

## Loading your suite

```bash
skillci tasks --tasks ./my-tasks            # list & sanity-check
skillci run --agent claude-code --tasks ./my-tasks \
  --baseline ./base --candidate ./cand
```

Each `task.json` is validated against the schema on load; an invalid task fails
fast with a clear error.
