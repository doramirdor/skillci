import { describe, expect, it } from 'vitest';
import { parseClaudeEnvelope } from './claude-adapter.js';
import { AgentOutputParseError } from './errors.js';

/**
 * Unit tests for the pure `claude --output-format json` telemetry normalizer.
 * These exercise the success path (which the network/CLI-gated `run()` cannot
 * reach offline) directly: cache-token summation, cost/turns mapping, and the
 * parse-error and zeroed-fallback branches.
 */
describe('parseClaudeEnvelope', () => {
  it('sums input + cache-read + cache-creation tokens into inputTokens', () => {
    const envelope = JSON.stringify({
      result: 'done',
      num_turns: 4,
      total_cost_usd: 0.1234,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      },
    });

    const r = parseClaudeEnvelope(envelope, '', 0, 1500);

    expect(r.inputTokens).toBe(125); // 100 + 20 + 5
    expect(r.outputTokens).toBe(50);
    expect(r.costUsd).toBeCloseTo(0.1234, 6);
    expect(r.steps).toBe(4);
    expect(r.toolCalls).toBe(4); // approximated by turns
    expect(r.transcript).toBe('done');
    expect(r.wallClockMs).toBe(1500);
  });

  it('zero-fills missing usage/cost/turns fields instead of producing NaN', () => {
    const r = parseClaudeEnvelope(JSON.stringify({ result: 'x' }), '', 0, 10);

    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.costUsd).toBe(0);
    expect(r.steps).toBe(0);
    expect(r.toolCalls).toBe(0);
    expect(Number.isFinite(r.inputTokens)).toBe(true);
  });

  it('falls back to raw stdout as transcript when result is not a string', () => {
    const stdout = JSON.stringify({ num_turns: 1, usage: { output_tokens: 3 } });
    const r = parseClaudeEnvelope(stdout, '', 0, 5);
    expect(r.transcript).toBe(stdout);
  });

  it('throws a typed AgentOutputParseError on non-JSON stdout', () => {
    expect(() => parseClaudeEnvelope('not json', 'boom', 1, 5)).toThrow(
      AgentOutputParseError,
    );
    try {
      parseClaudeEnvelope('not json', 'boom', 1, 5);
    } catch (err) {
      expect(err).toBeInstanceOf(AgentOutputParseError);
      const e = err as AgentOutputParseError;
      expect(e.kind).toBe('claude-code');
      expect(e.raw).toMatchObject({ stdout: 'not json', stderr: 'boom', exitCode: 1 });
    }
  });
});
