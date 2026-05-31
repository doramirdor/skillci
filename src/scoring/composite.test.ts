import { describe, expect, it } from 'vitest';

import {
  COST_WEIGHT,
  composite,
  computeScore,
  costAdjustment,
  objectiveRatio,
} from './composite.js';
import type {
  AgentRunResult,
  CostScore,
  ObjectiveScore,
  SandboxResult,
  Task,
} from '../core/index.js';
import type { JudgeFn } from './judge.js';

const sandbox: SandboxResult = {
  workdir: '/tmp/x',
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 0,
  fileDiff: [],
};

function obj(passed: number, total: number): ObjectiveScore {
  return { passed, total, details: [] };
}

const baseCost: CostScore = {
  tokens: 1000,
  toolCalls: 5,
  steps: 3,
  wallClockMs: 1000,
  costUsd: 0.01,
};

describe('objectiveRatio', () => {
  it('is 1 when there are no checks', () => {
    expect(objectiveRatio(obj(0, 0))).toBe(1);
  });
  it('is the pass fraction otherwise', () => {
    expect(objectiveRatio(obj(3, 4))).toBe(0.75);
  });
});

describe('costAdjustment', () => {
  it('is 0 without a reference', () => {
    expect(costAdjustment(baseCost)).toBe(0);
  });

  it('rewards a cheaper run (positive, bounded)', () => {
    const cheaper: CostScore = { ...baseCost, costUsd: 0.005, tokens: 500 };
    const adj = costAdjustment(cheaper, { costUsd: 0.01, tokens: 1000 });
    expect(adj).toBeGreaterThan(0);
    expect(adj).toBeLessThanOrEqual(COST_WEIGHT);
  });

  it('penalizes a pricier run (negative, bounded)', () => {
    const pricier: CostScore = { ...baseCost, costUsd: 0.02, tokens: 2000 };
    const adj = costAdjustment(pricier, { costUsd: 0.01, tokens: 1000 });
    expect(adj).toBeLessThan(0);
    expect(adj).toBeGreaterThanOrEqual(-COST_WEIGHT);
  });

  it('is ~0 when run matches reference exactly', () => {
    const adj = costAdjustment(baseCost, {
      costUsd: 0.01,
      tokens: 1000,
      toolCalls: 5,
      steps: 3,
      wallClockMs: 1000,
    });
    expect(Math.abs(adj)).toBeLessThan(1e-9);
  });
});

describe('composite', () => {
  it('weights objective higher than judge', () => {
    // Perfect objective + zero judge should beat zero objective + perfect judge,
    // because W_OBJ (0.6) > W_JUDGE (0.4).
    const objHeavy = composite({
      objective: obj(1, 1),
      judge: { score0to1: 0, rationale: '' },
      cost: baseCost,
    });
    const judgeHeavy = composite({
      objective: obj(0, 1),
      judge: { score0to1: 1, rationale: '' },
      cost: baseCost,
    });
    expect(objHeavy).toBeGreaterThan(judgeHeavy);
  });

  it('drops the judge dimension when absent (no penalty for no rubric)', () => {
    const withoutJudge = composite({ objective: obj(1, 1), cost: baseCost });
    expect(withoutJudge).toBe(1);
  });

  it('full objective + full judge => 1.0', () => {
    const score = composite({
      objective: obj(2, 2),
      judge: { score0to1: 1, rationale: '' },
      cost: baseCost,
    });
    expect(score).toBeCloseTo(1, 10);
  });

  it('a cheaper candidate outranks an identical-quality pricier one', () => {
    const quality = { objective: obj(1, 2), judge: { score0to1: 0.5, rationale: '' } };
    const cheap = composite({
      ...quality,
      cost: { ...baseCost, costUsd: 0.005, tokens: 500 },
      reference: { costUsd: 0.01, tokens: 1000 },
    });
    const pricey = composite({
      ...quality,
      cost: { ...baseCost, costUsd: 0.02, tokens: 2000 },
      reference: { costUsd: 0.01, tokens: 1000 },
    });
    expect(cheap).toBeGreaterThan(pricey);
  });

  it('stays within [0,1]', () => {
    const low = composite({
      objective: obj(0, 5),
      judge: { score0to1: 0, rationale: '' },
      cost: { ...baseCost, costUsd: 100, tokens: 1e6 },
      reference: { costUsd: 0.01, tokens: 1000 },
    });
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThanOrEqual(1);
  });
});

describe('computeScore (integration, offline)', () => {
  const runResult: AgentRunResult = {
    transcript: 'done',
    toolCalls: 5,
    inputTokens: 800,
    outputTokens: 200,
    costUsd: 0.01,
    steps: 3,
    wallClockMs: 1000,
    raw: {},
  };

  function task(): Task {
    return {
      id: 'task-1',
      title: 'fix bug',
      agent: 'claude-code',
      fixtureDir: '/fixtures/x',
      prompt: 'fix the bug',
      checks: [
        { kind: 'command', cmd: 'a', expectExitZero: true },
        { kind: 'command', cmd: 'b', expectExitZero: true },
      ],
      judgeRubric: { criteria: 'correct fix' },
      timeoutMs: 1000,
    };
  }

  const allPass: import('./objective.js').CommandRunner = async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
  const allFail: import('./objective.js').CommandRunner = async () => ({
    exitCode: 1,
    stdout: '',
    stderr: '',
  });
  const fakeJudge: JudgeFn = async () => ({ score0to1: 0.8, rationale: 'ok' });

  it('assembles a complete Score from the three dimensions', async () => {
    const score = await computeScore(task(), runResult, sandbox, {
      objective: { runner: allPass },
      judge: { judgeFn: fakeJudge },
    });
    expect(score.taskId).toBe('task-1');
    expect(score.objective).toEqual({ passed: 2, total: 2, details: expect.any(Array) });
    expect(score.judge).toEqual({ score0to1: 0.8, rationale: 'ok' });
    expect(score.cost.tokens).toBe(1000);
    expect(score.composite).toBeGreaterThan(0.9);
  });

  it('a regression in objective checks lowers the composite', async () => {
    const good = await computeScore(task(), runResult, sandbox, {
      objective: { runner: allPass },
      judge: { judgeFn: fakeJudge },
    });
    const bad = await computeScore(task(), runResult, sandbox, {
      objective: { runner: allFail },
      judge: { judgeFn: fakeJudge },
    });
    expect(bad.composite).toBeLessThan(good.composite);
    expect(bad.objective.passed).toBe(0);
  });

  it('omits the judge when no key/client and no injected fn is available', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const score = await computeScore(task(), runResult, sandbox, {
        objective: { runner: allPass },
      });
      expect(score.judge).toBeUndefined();
      // objective-only, full pass => composite 1 (no cost reference).
      expect(score.composite).toBe(1);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
