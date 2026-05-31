import { describe, expect, it } from 'vitest';

import { costMetrics } from './cost.js';
import type { AgentRunResult } from '../core/index.js';

function run(partial: Partial<AgentRunResult>): AgentRunResult {
  return {
    transcript: '',
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    steps: 0,
    wallClockMs: 0,
    raw: {},
    ...partial,
  };
}

describe('costMetrics', () => {
  it('sums input + output tokens', () => {
    const c = costMetrics(run({ inputTokens: 1000, outputTokens: 250 }));
    expect(c.tokens).toBe(1250);
  });

  it('maps telemetry fields through', () => {
    const c = costMetrics(
      run({ toolCalls: 7, steps: 3, wallClockMs: 4200, costUsd: 0.42 }),
    );
    expect(c).toMatchObject({ toolCalls: 7, steps: 3, wallClockMs: 4200, costUsd: 0.42 });
  });

  it('floors negative / NaN telemetry to 0', () => {
    const c = costMetrics(
      run({ inputTokens: -5, outputTokens: Number.NaN, toolCalls: -1, costUsd: -9 }),
    );
    expect(c.tokens).toBe(0);
    expect(c.toolCalls).toBe(0);
    expect(c.costUsd).toBe(0);
  });
});
