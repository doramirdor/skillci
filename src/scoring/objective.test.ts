import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { CommandRunner } from './objective.js';
import { runObjectiveChecks } from './objective.js';
import type { SandboxResult, Task } from '../core/index.js';

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeSandbox(files: Record<string, string> = {}): Promise<SandboxResult> {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'skillci-obj-'));
  tmpDirs.push(workdir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(workdir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return {
    workdir,
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    fileDiff: [],
  };
}

function task(checks: Task['checks']): Task {
  return {
    id: 't1',
    title: 'test task',
    agent: 'claude-code',
    fixtureDir: '/fixtures/x',
    prompt: 'do the thing',
    checks,
    timeoutMs: 1000,
  };
}

describe('runObjectiveChecks', () => {
  it('returns neutral empty result when there are no checks', async () => {
    const sandbox = await makeSandbox();
    const result = await runObjectiveChecks(sandbox, task([]));
    expect(result).toEqual({ passed: 0, total: 0, details: [] });
  });

  it('evaluates fileExists against the real filesystem', async () => {
    const sandbox = await makeSandbox({ 'src/a.ts': 'hi' });
    const result = await runObjectiveChecks(
      sandbox,
      task([
        { kind: 'fileExists', path: 'src/a.ts' },
        { kind: 'fileExists', path: 'src/missing.ts' },
      ]),
    );
    expect(result.total).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.details[0]?.passed).toBe(true);
    expect(result.details[1]?.passed).toBe(false);
  });

  it('evaluates fileContains', async () => {
    const sandbox = await makeSandbox({ 'README.md': 'hello world' });
    const result = await runObjectiveChecks(
      sandbox,
      task([
        { kind: 'fileContains', path: 'README.md', substring: 'world' },
        { kind: 'fileContains', path: 'README.md', substring: 'nope' },
        { kind: 'fileContains', path: 'absent.md', substring: 'x' },
      ]),
    );
    expect(result.passed).toBe(1);
    expect(result.total).toBe(3);
  });

  it('uses the injected command runner (offline) for command checks', async () => {
    const sandbox = await makeSandbox();
    const calls: Array<{ cmd: string; cwd: string }> = [];
    const runner: CommandRunner = async (cmd, cwd) => {
      calls.push({ cmd, cwd });
      return { exitCode: cmd.includes('pass') ? 0 : 3, stdout: '', stderr: 'boom' };
    };
    const result = await runObjectiveChecks(
      sandbox,
      task([
        { kind: 'command', cmd: 'pass-me', expectExitZero: true },
        { kind: 'command', cmd: 'fail-me', expectExitZero: true },
        // expecting non-zero: a failing command should PASS this check
        { kind: 'command', cmd: 'fail-me', expectExitZero: false },
      ]),
      { runner },
    );
    expect(calls.every((c) => c.cwd === sandbox.workdir)).toBe(true);
    expect(result.details[0]?.passed).toBe(true);
    expect(result.details[1]?.passed).toBe(false);
    expect(result.details[2]?.passed).toBe(true);
    expect(result.passed).toBe(2);
  });

  it('treats a testSuite as pass only on exit 0', async () => {
    const sandbox = await makeSandbox();
    const runner: CommandRunner = async (cmd) => ({
      exitCode: cmd === 'green' ? 0 : 1,
      stdout: '',
      stderr: '',
    });
    const result = await runObjectiveChecks(
      sandbox,
      task([
        { kind: 'testSuite', cmd: 'green' },
        { kind: 'testSuite', cmd: 'red' },
      ]),
      { runner },
    );
    expect(result.passed).toBe(1);
    expect(result.details[1]?.message).toContain('failed');
  });
});
