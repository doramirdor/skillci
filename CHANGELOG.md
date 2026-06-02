# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); the project uses [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **`claudeCliJudge`** — the LLM judge can run through `claude -p --output-format
  json` instead of the Anthropic SDK, so the *entire* pipeline (agent + judge)
  works on a Claude Code subscription with **no `ANTHROPIC_API_KEY`**. The CLI
  auto-selects: SDK when a key is present, else the CLI judge when judging Claude
  and its binary is available.
- Invocation-contract and CLI-judge regression tests; manual live smoke harness
  (`scripts/live-adapter-smoke.mjs`).
- GitHub-ready project assets: logo, banner, recorded demo GIF, expanded README,
  LICENSE, CONTRIBUTING, issue/PR templates.

### Changed
- **`ClaudeCodeAdapter` now gates on the `claude` binary only.** The CLI carries
  its own auth (API key *or* subscription/OAuth), so requiring `ANTHROPIC_API_KEY`
  wrongly rejected working subscription auth. The key requirement now lives solely
  in the LLM judge's SDK backend. Mirrors `CursorAdapter`.
- The Claude adapter passes `--dangerously-skip-permissions`. Headless `claude -p`
  is default-deny on tool permissions, so without it the agent could not edit
  files / run commands and every editing task silently scored as a failure. Runs
  are always inside a disposable sandbox.

## [0.1.0] - 2026-05-31

### Added
- Initial MVP: contracts, artifact discovery, sandbox, agent adapters
  (Claude/Cursor/Codex + mock), task loader + sample fixtures, three-dimensional
  scoring (objective + LLM judge + cost), comparator with fail-closed regression
  gate, reporting, `gh`-based PR opener, and the `skillci run|validate|tasks` CLI.
