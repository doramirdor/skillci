import { describe, it, expect } from 'vitest';
import { compareOutcomes } from '../compare/index.js';
import type {
  Comparison,
  RunOutcome,
  Score,
} from '../core/index.js';
import {
  renderJsonReport,
  renderMarkdownReport,
  renderTerminalReport,
} from './index.js';

const PINNED = '2026-05-31T00:00:00.000Z';

/** Build a `Score` with sensible defaults so tests stay terse. */
function makeScore(partial: Partial<Score> & { taskId: string }): Score {
  return {
    taskId: partial.taskId,
    objective: partial.objective ?? { passed: 1, total: 1, details: [] },
    judge: partial.judge,
    cost: partial.cost ?? {
      tokens: 1000,
      toolCalls: 3,
      steps: 2,
      wallClockMs: 5000,
      costUsd: 0.01,
    },
    composite: partial.composite ?? 0.5,
  };
}

/** A baseline/candidate pair that the comparator scores as `improved`. */
function improvedPair(): { baseline: RunOutcome; candidate: RunOutcome } {
  const baseline: RunOutcome = {
    configLabel: 'baseline',
    scores: [
      makeScore({
        taskId: 'fix-bug',
        objective: { passed: 1, total: 2, details: [] },
        judge: { score0to1: 0.5, rationale: 'ok' },
        composite: 0.4,
      }),
      makeScore({ taskId: 'add-test', composite: 0.6 }),
    ],
  };
  const candidate: RunOutcome = {
    configLabel: 'candidate',
    scores: [
      makeScore({
        taskId: 'fix-bug',
        objective: { passed: 2, total: 2, details: [] },
        judge: { score0to1: 0.8, rationale: 'better' },
        composite: 0.7,
        cost: {
          tokens: 900,
          toolCalls: 2,
          steps: 2,
          wallClockMs: 4000,
          costUsd: 0.008,
        },
      }),
      makeScore({ taskId: 'add-test', composite: 0.65 }),
    ],
  };
  return { baseline, candidate };
}

/** A baseline/candidate pair the comparator scores as `regressed`. */
function regressedPair(): { baseline: RunOutcome; candidate: RunOutcome } {
  const baseline: RunOutcome = {
    configLabel: 'baseline',
    scores: [
      makeScore({
        taskId: 'fix-bug',
        objective: { passed: 2, total: 2, details: [] },
        composite: 0.8,
      }),
    ],
  };
  const candidate: RunOutcome = {
    configLabel: 'candidate',
    scores: [
      makeScore({
        taskId: 'fix-bug',
        objective: { passed: 1, total: 2, details: [] },
        composite: 0.4,
      }),
    ],
  };
  return { baseline, candidate };
}

describe('renderJsonReport', () => {
  it('produces a stable object carrying the verdict, rows and aggregates', () => {
    const { baseline, candidate } = improvedPair();
    const comparison = compareOutcomes(baseline, candidate);
    const json = renderJsonReport(comparison, baseline, candidate, {
      generatedAt: PINNED,
      candidateLabel: 'feature/new-skill',
    });

    expect(json.schemaVersion).toBe(1);
    expect(json.generatedAt).toBe(PINNED);
    expect(json.verdict).toBe('improved');
    expect(json.promotable).toBe(true);
    expect(json.candidateLabel).toBe('feature/new-skill');

    // one row per task, in order
    expect(json.tasks.map((t) => t.taskId)).toEqual(['fix-bug', 'add-test']);
    const fixBug = json.tasks[0]!;
    expect(fixBug.compositeDelta).toBeCloseTo(0.3, 6);
    expect(fixBug.objectiveDelta).toBe(1);
    expect(fixBug.judgeDelta).toBeCloseTo(0.3, 6);
    expect(fixBug.classification).toBe('improved');

    // aggregate totals
    expect(json.totals.taskCount).toBe(2);
    expect(json.totals.improved).toBe(2);
    expect(json.totals.regressed).toBe(0);
    expect(json.totals.objective.candidate.passed).toBe(3);
    expect(json.totals.cost.baseline.tokens).toBe(2000);
    expect(json.totals.netCostUsdDelta).toBeCloseTo(-0.002, 6);
  });

  it('reports a regressed verdict with regression strings and not promotable', () => {
    const { baseline, candidate } = regressedPair();
    const comparison = compareOutcomes(baseline, candidate);
    const json = renderJsonReport(comparison, baseline, candidate, {
      generatedAt: PINNED,
    });

    expect(json.verdict).toBe('regressed');
    expect(json.promotable).toBe(false);
    expect(json.regressions.length).toBeGreaterThan(0);
    expect(json.tasks[0]!.classification).toBe('regressed');
    expect(json.tasks[0]!.isRegression).toBe(true);
    // null judgeDelta when neither side has a judge score
    expect(json.tasks[0]!.judgeDelta).toBeNull();
  });

  it('is deterministic given a pinned timestamp', () => {
    const { baseline, candidate } = improvedPair();
    const comparison = compareOutcomes(baseline, candidate);
    const a = renderJsonReport(comparison, baseline, candidate, {
      generatedAt: PINNED,
    });
    const b = renderJsonReport(comparison, baseline, candidate, {
      generatedAt: PINNED,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('renderMarkdownReport', () => {
  it('contains the verdict banner, a per-task row and the scoring breakdown', () => {
    const { baseline, candidate } = improvedPair();
    const comparison = compareOutcomes(baseline, candidate);
    const md = renderMarkdownReport(comparison, baseline, candidate, {
      generatedAt: PINNED,
      candidateLabel: 'feature/new-skill',
    });

    expect(md).toContain('# SkillCI Report');
    expect(md).toContain('IMPROVED');
    // verdict summary line is quoted
    expect(md).toContain(`> ${comparison.summary}`);
    // per-task rows present
    expect(md).toContain('| fix-bug |');
    expect(md).toContain('| add-test |');
    // scoring breakdown + metadata
    expect(md).toContain('## Scoring breakdown');
    expect(md).toContain('Objective pass-rate');
    expect(md).toContain(`Generated at: ${PINNED}`);
    expect(md).toContain('Candidate: feature/new-skill');
  });

  it('lists explicit regression lines for a regressed comparison', () => {
    const { baseline, candidate } = regressedPair();
    const comparison = compareOutcomes(baseline, candidate);
    const md = renderMarkdownReport(comparison, baseline, candidate, {
      generatedAt: PINNED,
    });

    expect(md).toContain('REGRESSED');
    expect(md).toContain('## Regressions');
    // each comparator regression string appears
    for (const r of comparison.regressions) {
      expect(md).toContain(r);
    }
    // the regressed task row carries the marker
    expect(md).toContain('REGRESSED |');
  });

  it('handles an empty comparison gracefully', () => {
    const empty: Comparison = {
      verdict: 'neutral',
      perTaskDeltas: [],
      regressions: [],
      improvements: [],
      summary: 'NEUTRAL: 0 task(s).',
    };
    const outcome: RunOutcome = { configLabel: 'baseline', scores: [] };
    const md = renderMarkdownReport(empty, outcome, {
      ...outcome,
      configLabel: 'candidate',
    }, { generatedAt: PINNED });
    expect(md).toContain('_No tasks were compared._');
    expect(md).toContain('_None._');
  });
});

describe('renderTerminalReport', () => {
  it('renders a plain (color-free) summary with verdict and per-task lines', () => {
    const { baseline, candidate } = improvedPair();
    const comparison = compareOutcomes(baseline, candidate);
    const out = renderTerminalReport(comparison, baseline, candidate, {
      generatedAt: PINNED,
      color: false,
    });

    expect(out).toContain('VERDICT: IMPROVED');
    expect(out).toContain('fix-bug:');
    expect(out).toContain('add-test:');
    expect(out).toContain('PROMOTABLE');
    // color disabled => no ANSI escape codes
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\[/);
  });

  it('shows regression lines and a non-promotable footer when regressed', () => {
    const { baseline, candidate } = regressedPair();
    const comparison = compareOutcomes(baseline, candidate);
    const out = renderTerminalReport(comparison, baseline, candidate, {
      generatedAt: PINNED,
      color: false,
    });

    expect(out).toContain('VERDICT: REGRESSED');
    expect(out).toContain('Regressions');
    expect(out).toContain('[REGRESSED]');
    expect(out).toContain('NOT promotable');
    for (const r of comparison.regressions) {
      expect(out).toContain(r);
    }
  });

  it('emits ANSI codes when color is forced on', () => {
    const { baseline, candidate } = improvedPair();
    const comparison = compareOutcomes(baseline, candidate);
    const out = renderTerminalReport(comparison, baseline, candidate, {
      generatedAt: PINNED,
      color: true,
    });
    // eslint-disable-next-line no-control-regex
    expect(out).toMatch(/\[/);
  });
});
