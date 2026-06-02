import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, SandboxResult, Task } from '../core/index.js';

/**
 * Unit tests for the `claude -p`-backed judge. `execa` is mocked so these run
 * fully offline: we assert the invocation shape (no `--dangerously-skip-permissions`
 * — the judge needs no tools), envelope parsing, and best-effort degradation.
 */
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

const { claudeCliJudge } = await import('./judge.js');

const TASK: Task = {
  id: 't1',
  title: 'Do the thing',
  agent: 'claude-code',
  fixtureDir: '/tmp/fx',
  prompt: 'Do the thing.',
  checks: [],
  timeoutMs: 60_000,
  judgeRubric: { criteria: 'Did the agent do the thing correctly and minimally?' },
};
const RUN: AgentRunResult = {
  transcript: 'I did the thing.',
  toolCalls: 1,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.01,
  steps: 1,
  wallClockMs: 100,
  raw: {},
};
const SANDBOX: SandboxResult = {
  workdir: '/tmp/fx',
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 0,
  fileDiff: [],
};

afterEach(() => execaMock.mockReset());

describe('claudeCliJudge', () => {
  it('parses the verdict from the JSON envelope `result` field', async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        result: '{"score": 0.8, "rationale": "Did it minimally."}',
      }),
      stderr: '',
    });

    const score = await claudeCliJudge(TASK, RUN, SANDBOX);
    expect(score).toEqual({ score0to1: 0.8, rationale: 'Did it minimally.' });

    // Invocation shape: `claude -p <prompt> --output-format json`, and crucially
    // NO --dangerously-skip-permissions (the judge is pure text reasoning).
    const [bin, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('returns undefined when the task has no rubric (no CLI call)', async () => {
    const { judgeRubric: _omit, ...noRubric } = TASK;
    const score = await claudeCliJudge(noRubric as Task, RUN, SANDBOX);
    expect(score).toBeUndefined();
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('returns undefined on a non-zero CLI exit', async () => {
    execaMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom' });
    expect(await claudeCliJudge(TASK, RUN, SANDBOX)).toBeUndefined();
  });

  it('returns undefined when stdout has no parseable verdict', async () => {
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: 'I have no idea, sorry.' }),
      stderr: '',
    });
    expect(await claudeCliJudge(TASK, RUN, SANDBOX)).toBeUndefined();
  });
});
