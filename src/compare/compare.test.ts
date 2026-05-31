import { describe, expect, it } from 'vitest';

import type {
  Comparison,
  CostScore,
  JudgeScore,
  ObjectiveScore,
  RunOutcome,
  Score,
} from '../core/index.js';
import { compareOutcomes, shouldPromote } from './index.js';

/* ------------------------------- builders -------------------------------- */

function objective(passed: number, total: number): ObjectiveScore {
  return {
    passed,
    total,
    details: Array.from({ length: total }, (_, i) => ({
      check: { kind: 'fileExists', path: `f${i}` },
      passed: i < passed,
    })),
  };
}

function cost(overrides: Partial<CostScore> = {}): CostScore {
  return {
    tokens: 1000,
    toolCalls: 5,
    steps: 3,
    wallClockMs: 2000,
    costUsd: 0.01,
    ...overrides,
  };
}

function score(
  taskId: string,
  opts: {
    composite: number;
    passed?: number;
    total?: number;
    judge?: number;
    costUsd?: number;
  },
): Score {
  const total = opts.total ?? 2;
  const passed = opts.passed ?? total;
  const judge: JudgeScore | undefined =
    opts.judge === undefined
      ? undefined
      : { score0to1: opts.judge, rationale: 'r' };
  return {
    taskId,
    objective: objective(passed, total),
    judge,
    cost: cost({ costUsd: opts.costUsd ?? 0.01 }),
    composite: opts.composite,
  };
}

function outcome(label: RunOutcome['configLabel'], scores: Score[]): RunOutcome {
  return { configLabel: label, scores };
}

function deltaFor(c: Comparison, taskId: string) {
  const d = c.perTaskDeltas.find((x) => x.taskId === taskId);
  if (!d) throw new Error(`no delta for ${taskId}`);
  return d;
}

/* -------------------------------- tests ---------------------------------- */

describe('compareOutcomes — improved', () => {
  it('classifies a clean composite gain as improved and promotable', () => {
    const baseline = outcome('baseline', [score('t1', { composite: 0.5 })]);
    const candidate = outcome('candidate', [score('t1', { composite: 0.8 })]);

    const c = compareOutcomes(baseline, candidate);

    expect(c.verdict).toBe('improved');
    expect(c.regressions).toEqual([]);
    expect(c.improvements.length).toBe(1);
    expect(deltaFor(c, 't1').compositeDelta).toBeCloseTo(0.3, 6);
    expect(deltaFor(c, 't1').isRegression).toBe(false);
    expect(shouldPromote(c)).toBe(true);
    expect(c.summary).toContain('IMPROVED');
  });

  it('aggregates gains across multiple tasks', () => {
    const baseline = outcome('baseline', [
      score('t1', { composite: 0.5 }),
      score('t2', { composite: 0.5 }),
    ]);
    const candidate = outcome('candidate', [
      score('t1', { composite: 0.55 }),
      score('t2', { composite: 0.6 }),
    ]);

    const c = compareOutcomes(baseline, candidate);

    expect(c.verdict).toBe('improved');
    expect(shouldPromote(c)).toBe(true);
  });

  it('reports judge and cost deltas when both sides have them', () => {
    const baseline = outcome('baseline', [
      score('t1', { composite: 0.5, judge: 0.6, costUsd: 0.02 }),
    ]);
    const candidate = outcome('candidate', [
      score('t1', { composite: 0.7, judge: 0.9, costUsd: 0.015 }),
    ]);

    const c = compareOutcomes(baseline, candidate);
    const d = deltaFor(c, 't1');

    expect(d.judgeDelta).toBeCloseTo(0.3, 6);
    expect(d.costUsdDelta).toBeCloseTo(-0.005, 6); // cheaper
  });
});

describe('compareOutcomes — neutral', () => {
  it('classifies a sub-threshold gain as neutral, not promotable', () => {
    const baseline = outcome('baseline', [score('t1', { composite: 0.5 })]);
    const candidate = outcome('candidate', [score('t1', { composite: 0.505 })]);

    // default minCompositeGain = 0.01; gain of 0.005 is below it
    const c = compareOutcomes(baseline, candidate);

    expect(c.verdict).toBe('neutral');
    expect(c.regressions).toEqual([]);
    expect(shouldPromote(c)).toBe(false);
    expect(c.summary).toContain('NEUTRAL');
  });

  it('treats identical outcomes as neutral', () => {
    const baseline = outcome('baseline', [score('t1', { composite: 0.5 })]);
    const candidate = outcome('candidate', [score('t1', { composite: 0.5 })]);

    const c = compareOutcomes(baseline, candidate);

    expect(c.verdict).toBe('neutral');
    expect(deltaFor(c, 't1').compositeDelta).toBe(0);
  });
});

describe('compareOutcomes — regressed (HARD RULES)', () => {
  it('HARD RULE: any objective pass-rate drop forces regressed even with composite gain', () => {
    // Candidate gains composite massively but drops one objective check.
    const baseline = outcome('baseline', [
      score('t1', { composite: 0.4, passed: 2, total: 2 }),
    ]);
    const candidate = outcome('candidate', [
      score('t1', { composite: 0.95, passed: 1, total: 2 }),
    ]);

    const c = compareOutcomes(baseline, candidate);

    expect(c.verdict).toBe('regressed');
    expect(c.regressions.length).toBeGreaterThan(0);
    expect(c.regressions[0]).toContain('objective regressed');
    expect(deltaFor(c, 't1').isRegression).toBe(true);
    expect(shouldPromote(c)).toBe(false);
  });

  it('objective drop is NOT a hard regression when objectiveDropIsRegression=false', () => {
    const baseline = outcome('baseline', [
      score('t1', { composite: 0.4, passed: 2, total: 2 }),
    ]);
    const candidate = outcome('candidate', [
      score('t1', { composite: 0.95, passed: 1, total: 2 }),
    ]);

    const c = compareOutcomes(baseline, candidate, {
      objectiveDropIsRegression: false,
    });

    // No hard regression now; large composite gain -> improved
    expect(c.verdict).toBe('improved');
    expect(c.regressions).toEqual([]);
    expect(shouldPromote(c)).toBe(true);
  });

  it('HARD RULE: composite drop beyond regression threshold forces regressed', () => {
    const baseline = outcome('baseline', [score('t1', { composite: 0.8 })]);
    const candidate = outcome('candidate', [score('t1', { composite: 0.7 })]);

    // drop of 0.1 > default regressionCompositeDrop 0.05
    const c = compareOutcomes(baseline, candidate);

    expect(c.verdict).toBe('regressed');
    expect(c.regressions[0]).toContain('composite regressed');
    expect(deltaFor(c, 't1').isRegression).toBe(true);
    expect(shouldPromote(c)).toBe(false);
  });

  it('a small composite drop within threshold is not a hard regression', () => {
    const baseline = outcome('baseline', [score('t1', { composite: 0.8 })]);
    const candidate = outcome('candidate', [score('t1', { composite: 0.78 })]);

    // drop 0.02 <= regressionCompositeDrop 0.05, no objective drop.
    // net gain -0.02 is within +/- minCompositeGain? minCompositeGain=0.01,
    // so -0.02 <= -0.01 -> aggregate regression.
    const c = compareOutcomes(baseline, candidate);

    expect(deltaFor(c, 't1').isRegression).toBe(false);
    expect(c.verdict).toBe('regressed'); // aggregate net-negative
    expect(c.regressions.some((r) => r.includes('aggregate composite'))).toBe(true);
  });

  it('a tiny composite drop inside the neutral band stays neutral', () => {
    const baseline = outcome('baseline', [score('t1', { composite: 0.8 })]);
    const candidate = outcome('candidate', [score('t1', { composite: 0.795 })]);

    // drop 0.005: within regression threshold AND within +/-minCompositeGain
    const c = compareOutcomes(baseline, candidate);

    expect(c.verdict).toBe('neutral');
    expect(c.regressions).toEqual([]);
  });

  it('HARD RULE: an absolute drop in passed checks regresses even when the rate holds', () => {
    // Baseline: 2/4 passed (rate 0.5). Candidate shrinks the check set to 1/2
    // (same rate 0.5) but passes fewer checks in absolute terms, and gains
    // composite. The rate-only gate would miss this; the count gate catches it.
    const baseline = outcome('baseline', [
      score('t1', { composite: 0.4, passed: 2, total: 4 }),
    ]);
    const candidate = outcome('candidate', [
      score('t1', { composite: 0.95, passed: 1, total: 2 }),
    ]);

    const c = compareOutcomes(baseline, candidate);

    expect(c.verdict).toBe('regressed');
    expect(c.regressions.some((r) => r.includes('objective regressed'))).toBe(true);
    expect(deltaFor(c, 't1').isRegression).toBe(true);
    expect(shouldPromote(c)).toBe(false);
  });

  it('HARD RULE: a baseline task absent from candidate is an explicit regression', () => {
    // Even with a tiny composite so the composite-drop threshold alone would
    // not fire, a dropped task must be flagged explicitly.
    const baseline = outcome('baseline', [
      score('t1', { composite: 0.5, passed: 3, total: 3 }),
      score('t2', { composite: 0.02, passed: 1, total: 1 }),
    ]);
    const candidate = outcome('candidate', [
      score('t1', { composite: 0.5, passed: 3, total: 3 }),
    ]);

    const c = compareOutcomes(baseline, candidate);

    expect(c.verdict).toBe('regressed');
    expect(
      c.regressions.some((r) => r.includes('absent from candidate run')),
    ).toBe(true);
    expect(deltaFor(c, 't2').isRegression).toBe(true);
    expect(shouldPromote(c)).toBe(false);
  });

  it('HARD RULE: a non-finite (NaN) composite fails closed rather than neutralizing', () => {
    const baseline = outcome('baseline', [score('t1', { composite: 0.5 })]);
    const candidate = outcome('candidate', [score('t1', { composite: Number.NaN })]);

    const c = compareOutcomes(baseline, candidate);

    expect(c.verdict).toBe('regressed');
    expect(c.regressions.some((r) => r.includes('non-finite'))).toBe(true);
    expect(deltaFor(c, 't1').isRegression).toBe(true);
    expect(shouldPromote(c)).toBe(false);
  });
});

describe('compareOutcomes — mixed', () => {
  it('one big gain + one hard regression => regressed (regression dominates)', () => {
    const baseline = outcome('baseline', [
      score('t1', { composite: 0.4 }),
      score('t2', { composite: 0.8, passed: 2, total: 2 }),
    ]);
    const candidate = outcome('candidate', [
      score('t1', { composite: 0.9 }), // big gain
      score('t2', { composite: 0.85, passed: 1, total: 2 }), // objective drop
    ]);

    const c = compareOutcomes(baseline, candidate);

    expect(c.verdict).toBe('regressed');
    // net composite is strongly positive, but the rule still blocks it
    expect(c.improvements.length).toBeGreaterThan(0);
    expect(c.regressions.length).toBeGreaterThan(0);
    expect(shouldPromote(c)).toBe(false);
  });

  it('mixed gains and small losses net positive with no hard regression => improved', () => {
    const baseline = outcome('baseline', [
      score('t1', { composite: 0.5 }),
      score('t2', { composite: 0.5 }),
    ]);
    const candidate = outcome('candidate', [
      score('t1', { composite: 0.6 }), // +0.1
      score('t2', { composite: 0.48 }), // -0.02 (within threshold)
    ]);

    const c = compareOutcomes(baseline, candidate);

    // net +0.08, no per-task crosses the 0.05 hard drop, no objective drop
    expect(c.verdict).toBe('improved');
    expect(c.regressions).toEqual([]);
    expect(shouldPromote(c)).toBe(true);
  });
});

describe('compareOutcomes — thresholds & edge cases', () => {
  it('respects a custom regressionCompositeDrop', () => {
    const baseline = outcome('baseline', [score('t1', { composite: 0.8 })]);
    const candidate = outcome('candidate', [score('t1', { composite: 0.75 })]);

    // drop 0.05; with a tighter threshold of 0.01 this is a hard regression
    const c = compareOutcomes(baseline, candidate, {
      regressionCompositeDrop: 0.01,
    });
    expect(c.verdict).toBe('regressed');
    expect(deltaFor(c, 't1').isRegression).toBe(true);
  });

  it('respects a custom minCompositeGain for the improved band', () => {
    const baseline = outcome('baseline', [score('t1', { composite: 0.5 })]);
    const candidate = outcome('candidate', [score('t1', { composite: 0.53 })]);

    // gain 0.03 < custom minCompositeGain 0.1 -> neutral
    const c = compareOutcomes(baseline, candidate, { minCompositeGain: 0.1 });
    expect(c.verdict).toBe('neutral');
  });

  it('handles tasks with zero objective checks (pass-rate treated as 1.0)', () => {
    const baseline = outcome('baseline', [
      score('t1', { composite: 0.5, passed: 0, total: 0 }),
    ]);
    const candidate = outcome('candidate', [
      score('t1', { composite: 0.7, passed: 0, total: 0 }),
    ]);

    const c = compareOutcomes(baseline, candidate);
    expect(c.verdict).toBe('improved');
    expect(deltaFor(c, 't1').isRegression).toBe(false);
  });

  it('a candidate-only task counts (baseline composite treated as 0)', () => {
    const baseline = outcome('baseline', [score('t1', { composite: 0.5 })]);
    const candidate = outcome('candidate', [
      score('t1', { composite: 0.5 }),
      score('t2', { composite: 0.3 }),
    ]);

    const c = compareOutcomes(baseline, candidate);
    const d = deltaFor(c, 't2');
    expect(d.baselineComposite).toBe(0);
    expect(d.compositeDelta).toBeCloseTo(0.3, 6);
    expect(c.verdict).toBe('improved');
  });

  it('a baseline-only task missing from candidate is a composite drop to 0', () => {
    const baseline = outcome('baseline', [
      score('t1', { composite: 0.5 }),
      score('t2', { composite: 0.5 }),
    ]);
    const candidate = outcome('candidate', [score('t1', { composite: 0.5 })]);

    const c = compareOutcomes(baseline, candidate);
    const d = deltaFor(c, 't2');
    expect(d.candidateComposite).toBe(0);
    expect(d.compositeDelta).toBeCloseTo(-0.5, 6);
    // drop 0.5 > 0.05 threshold => hard regression
    expect(d.isRegression).toBe(true);
    expect(c.verdict).toBe('regressed');
  });

  it('judgeDelta is undefined when either side lacks a judge score', () => {
    const baseline = outcome('baseline', [score('t1', { composite: 0.5, judge: 0.5 })]);
    const candidate = outcome('candidate', [score('t1', { composite: 0.7 })]);

    const c = compareOutcomes(baseline, candidate);
    expect(deltaFor(c, 't1').judgeDelta).toBeUndefined();
  });

  it('preserves baseline task ordering, then appends candidate-only tasks', () => {
    const baseline = outcome('baseline', [
      score('b1', { composite: 0.5 }),
      score('b2', { composite: 0.5 }),
    ]);
    const candidate = outcome('candidate', [
      score('b2', { composite: 0.55 }),
      score('b1', { composite: 0.55 }),
      score('c3', { composite: 0.55 }),
    ]);

    const c = compareOutcomes(baseline, candidate);
    expect(c.perTaskDeltas.map((d) => d.taskId)).toEqual(['b1', 'b2', 'c3']);
  });

  it('two empty outcomes are neutral and not promotable', () => {
    const c = compareOutcomes(outcome('baseline', []), outcome('candidate', []));
    expect(c.verdict).toBe('neutral');
    expect(c.perTaskDeltas).toEqual([]);
    expect(shouldPromote(c)).toBe(false);
  });

  it('partial thresholds are merged with schema defaults', () => {
    // Provide only one field; others should default.
    const baseline = outcome('baseline', [score('t1', { composite: 0.8 })]);
    const candidate = outcome('candidate', [score('t1', { composite: 0.7 })]);
    const c = compareOutcomes(baseline, candidate, { minCompositeGain: 0.5 });
    // default regressionCompositeDrop 0.05 still applies -> hard regression
    expect(c.verdict).toBe('regressed');
  });
});

describe('shouldPromote — defensive coupling', () => {
  it('returns false for a hand-built improved verdict that carries a regression', () => {
    const c: Comparison = {
      verdict: 'improved',
      perTaskDeltas: [],
      regressions: ['some leaked regression'],
      improvements: [],
      summary: 'x',
    };
    expect(shouldPromote(c)).toBe(false);
  });

  it('returns true only for improved with zero regressions', () => {
    const c: Comparison = {
      verdict: 'improved',
      perTaskDeltas: [],
      regressions: [],
      improvements: [],
      summary: 'x',
    };
    expect(shouldPromote(c)).toBe(true);
  });

  it('returns false for neutral and regressed', () => {
    const neutral: Comparison = {
      verdict: 'neutral',
      perTaskDeltas: [],
      regressions: [],
      improvements: [],
      summary: 'x',
    };
    const regressed: Comparison = {
      verdict: 'regressed',
      perTaskDeltas: [],
      regressions: ['r'],
      improvements: [],
      summary: 'x',
    };
    expect(shouldPromote(neutral)).toBe(false);
    expect(shouldPromote(regressed)).toBe(false);
  });
});
