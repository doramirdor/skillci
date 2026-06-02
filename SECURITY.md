# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

Email **amirdor@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept), and
- any suggested remediation.

You'll get an acknowledgement within a few days, and we'll keep you updated as we
investigate and ship a fix. Please give us reasonable time to address the issue
before any public disclosure.

## Scope notes

SkillCI runs coding agents **headlessly with `--dangerously-skip-permissions`
inside disposable, isolated sandboxes**. This is intentional — the sandbox is a
throwaway copy of a fixture repo. Do **not** point SkillCI's live mode at
untrusted task fixtures or untrusted config artifacts on a machine where the
sandbox is not adequately isolated, since the agent can execute arbitrary
commands within that sandbox.

## Supported versions

The project is pre-1.0; only the latest `main` receives security fixes.
