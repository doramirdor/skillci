# CLI Reference

```
skillci <command> [options]
```

Invoke via the built binary (`node dist/cli/index.js …`), or `npm run demo` for
the offline run. After `npm link` / global install, the `skillci` binary is on
your PATH.

## `skillci run`

Run a baseline-vs-candidate evaluation (or the offline demo) and print the report.

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--agent <kind>` | `claude-code` | Target agent: `claude-code` \| `cursor` \| `codex`. |
| `--baseline <dir>` | — | Directory holding the baseline (trusted) config. |
| `--candidate <dir>` | — | Directory holding the candidate (proposed) config. |
| `--tasks <dir>` | bundled samples | Directory of task definitions. |
| `--demo` | `false` | Fully-offline run over the sample tasks via the mock adapter. |
| `--open-pr` | `false` | Open a real PR when promotable (otherwise dry-run). |
| `--no-color` | — | Disable colorized output. |

**Behavior notes**

- If `--baseline` or `--candidate` is omitted, `run` falls back to **demo mode**.
- The real agent adapter is used when available; otherwise it falls back to the
  offline mock (and says so).
- Judge backend: Anthropic SDK when `ANTHROPIC_API_KEY` is set, else the
  `claude -p` CLI judge when judging Claude and its binary is present, else skipped.

**Exit codes**

| Code | When |
| :--: | ---- |
| `0` | Verdict `improved` or `neutral`. |
| non-zero | Verdict `regressed` (use as a CI gate). |

**Examples**

```bash
# Offline, deterministic
skillci run --demo

# Live, on a Claude subscription (no API key)
skillci run --agent claude-code --baseline ./cfg/base --candidate ./cfg/cand

# Custom task suite, open a PR if promotable
skillci run --agent claude-code --baseline ./base --candidate ./cand \
  --tasks ./my-tasks --open-pr
```

## `skillci validate <dir>`

Discover and validate the config artifacts for an agent in a directory — a quick
sanity check that your skills/hooks/rules parse before you evaluate them.

| Flag | Description |
| ---- | ----------- |
| `--agent <kind>` | Agent to interpret the directory as (default `claude-code`). |
| `--baseline <dir>` | Optional baseline to diff against (reports added/removed/modified artifacts). |

```bash
skillci validate ./my-config --agent claude-code
skillci validate ./pr-config --agent claude-code --baseline ./main-config
```

## `skillci tasks`

List the available task definitions (bundled samples by default).

| Flag | Description |
| ---- | ----------- |
| `--tasks <dir>` | List tasks from a custom directory instead of the samples. |

```bash
skillci tasks
skillci tasks --tasks ./my-tasks
```

Output shows each task's id, target agent, title, check count, and whether it's
judged.

## Global

- `skillci --help` / `skillci <command> --help` — usage.
- `skillci --version` — version.
