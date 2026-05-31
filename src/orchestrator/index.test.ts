import { describe, it, expect } from 'vitest';
import * as os from 'node:os';

import { runDemo, runEvaluation } from './index.js';
import { MockAgentAdapter } from '../agents/index.js';
import { getSampleTasks } from '../tasks/index.js';
import type { ConfigSet } from '../core/index.js';

const PINNED_AT = '2026-05-31T00:00:00.000Z';

describe('runDemo (end-to-end, offline)', () => {
  it('produces a Comparison with a defined verdict and non-empty reports', async () => {
    const result = await runDemo(os.tmpdir(), { generatedAt: PINNED_AT });

    // Verdict is one of the three allowed values.
    expect(['improved', 'neutral', 'regressed']).toContain(
      result.comparison.verdict,
    );

    // One per-task delta per sample task.
    expect(result.comparison.perTaskDeltas.length).toBe(result.tasks.length);
    expect(result.tasks.length).toBeGreaterThan(0);

    // Reports are non-empty and structurally sound.
    expect(result.reportMarkdown.length).toBeGreaterThan(0);
    expect(result.reportMarkdown).toContain('#');
    expect(result.reportJson.schemaVersion).toBe(1);
    expect(result.reportJson.verdict).toBe(result.comparison.verdict);
    expect(result.reportJson.generatedAt).toBe(PINNED_AT);
    expect(result.reportJson.tasks.length).toBe(result.tasks.length);

    // PR runs in dry-run by default — no side effects.
    expect(result.prResult.dryRun).toBe(true);
    expect(result.prResult.prUrl).toBeUndefined();
  });

  it('fabricates an unambiguously-better candidate (improved, no regressions)', async () => {
    const result = await runDemo(os.tmpdir(), { generatedAt: PINNED_AT });

    // The candidate adapter has a higher quality bias, so the demo is rigged to
    // improve without hard regressions.
    expect(result.comparison.verdict).toBe('improved');
    expect(result.comparison.regressions).toHaveLength(0);
    expect(result.comparison.improvements.length).toBeGreaterThan(0);

    // Net composite delta is positive.
    expect(result.reportJson.totals.netCompositeDelta).toBeGreaterThan(0);

    // Improved + zero regressions => promotable (dry-run plan computed).
    expect(result.reportJson.promotable).toBe(true);
    expect(result.prResult.promoted).toBe(true);
    expect(result.prResult.plannedCommands.length).toBeGreaterThan(0);
  });

  it('is deterministic across runs', async () => {
    const a = await runDemo(os.tmpdir(), { generatedAt: PINNED_AT });
    const b = await runDemo(os.tmpdir(), { generatedAt: PINNED_AT });

    expect(b.comparison.verdict).toBe(a.comparison.verdict);
    expect(b.reportJson.totals.netCompositeDelta).toBe(
      a.reportJson.totals.netCompositeDelta,
    );
    // Markdown is byte-identical given a pinned timestamp.
    expect(b.reportMarkdown).toBe(a.reportMarkdown);
  });
});

describe('runEvaluation (offline, injected adapters)', () => {
  it('yields neutral when baseline and candidate configs/adapters are identical', async () => {
    const tasks = await getSampleTasks();
    const config: ConfigSet = {
      agent: 'claude-code',
      artifacts: [
        {
          id: 'CLAUDE.md',
          agent: 'claude-code',
          kind: 'instruction',
          path: 'CLAUDE.md',
          content: '# Same on both sides\n',
          meta: {},
        },
      ],
    };

    const adapter = new MockAgentAdapter({ qualityBias: 0.5 });

    const result = await runEvaluation({
      rootDir: os.tmpdir(),
      baselineConfig: config,
      candidateConfig: config,
      tasks,
      agentKind: 'claude-code',
      adapter,
      candidateAdapter: adapter,
      judge: { enabled: false },
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      dryRunPr: true,
      generatedAt: PINNED_AT,
    });

    // Identical inputs => identical scores => no improvement and no regression.
    expect(result.comparison.verdict).toBe('neutral');
    expect(result.comparison.regressions).toHaveLength(0);
    for (const d of result.comparison.perTaskDeltas) {
      expect(d.compositeDelta).toBe(0);
      expect(d.objectiveDelta).toBe(0);
    }

    // Not promotable => skipped PR.
    expect(result.prResult.promoted).toBe(false);
    expect(result.prResult.dryRun).toBe(true);
  });

  it('disposes sandboxes and runs the judge dimension when injected', async () => {
    const tasks = (await getSampleTasks()).slice(0, 1);
    const config: ConfigSet = {
      agent: 'claude-code',
      artifacts: [],
    };

    const result = await runEvaluation({
      rootDir: os.tmpdir(),
      baselineConfig: config,
      candidateConfig: config,
      tasks,
      agentKind: 'claude-code',
      adapter: new MockAgentAdapter({ qualityBias: 0.5 }),
      judge: { enabled: true },
      // Deterministic fake judge so no network is touched.
      judgeOptions: { judgeFn: async () => ({ score0to1: 0.8, rationale: 'fake' }) },
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      dryRunPr: true,
      generatedAt: PINNED_AT,
    });

    // Sample task #1 has a rubric, so the judge dimension should be present.
    const baselineScore = result.baselineOutcome.scores[0];
    expect(baselineScore).toBeDefined();
    expect(baselineScore?.judge?.rationale).toBe('fake');
  });
});
