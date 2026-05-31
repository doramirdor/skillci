/**
 * Cost / efficiency dimension — maps raw agent telemetry into a {@link CostScore}.
 *
 * This dimension is purely a projection of {@link AgentRunResult} telemetry; the
 * normalization into a bonus/penalty happens in the composite formula (see
 * `composite.ts`) where baseline context is available.
 */
import type { AgentRunResult, CostScore } from '../core/index.js';

/**
 * Project an {@link AgentRunResult} onto the {@link CostScore} sub-dimensions.
 * Negative or NaN telemetry values are floored to 0 so downstream math stays
 * well-behaved even with a misbehaving adapter.
 */
export function costMetrics(runResult: AgentRunResult): CostScore {
  const inputTokens = nonNeg(runResult.inputTokens);
  const outputTokens = nonNeg(runResult.outputTokens);
  return {
    tokens: inputTokens + outputTokens,
    toolCalls: nonNeg(runResult.toolCalls),
    steps: nonNeg(runResult.steps),
    wallClockMs: nonNeg(runResult.wallClockMs),
    costUsd: nonNeg(runResult.costUsd),
  };
}

function nonNeg(n: number): number {
  if (typeof n !== 'number' || Number.isNaN(n) || n < 0) return 0;
  return n;
}
