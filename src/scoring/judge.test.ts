import { describe, expect, it, vi } from 'vitest';

import {
  buildJudgeSystemPrompt,
  judgeWithLLM,
  parseJudgeResponse,
} from './judge.js';
import type { AgentRunResult, SandboxResult, Task } from '../core/index.js';

const sandbox: SandboxResult = {
  workdir: '/tmp/x',
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 0,
  fileDiff: [],
};

const runResult: AgentRunResult = {
  transcript: 'I refactored the function and added tests.',
  toolCalls: 4,
  inputTokens: 1000,
  outputTokens: 200,
  costUsd: 0.01,
  steps: 3,
  wallClockMs: 5000,
  raw: {},
};

function task(withRubric: boolean): Task {
  return {
    id: 't1',
    title: 'refactor',
    agent: 'claude-code',
    fixtureDir: '/fixtures/x',
    prompt: 'refactor cleanly',
    checks: [],
    judgeRubric: withRubric ? { criteria: 'Code is clean and tested.' } : undefined,
    timeoutMs: 1000,
  };
}

describe('judgeWithLLM', () => {
  it('returns undefined when there is no rubric', async () => {
    const result = await judgeWithLLM(task(false), runResult, sandbox);
    expect(result).toBeUndefined();
  });

  it('returns undefined offline (no key, no client, no injected fn)', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await judgeWithLLM(task(true), runResult, sandbox);
      expect(result).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('uses an injected fake judge fn', async () => {
    const result = await judgeWithLLM(task(true), runResult, sandbox, {
      judgeFn: async (t) => ({ score0to1: 0.75, rationale: `judged ${t.id}` }),
    });
    expect(result).toEqual({ score0to1: 0.75, rationale: 'judged t1' });
  });

  it('never throws if the injected judge fn throws', async () => {
    const result = await judgeWithLLM(task(true), runResult, sandbox, {
      judgeFn: async () => {
        throw new Error('boom');
      },
    });
    expect(result).toBeUndefined();
  });

  it('calls Anthropic with a cache_control system block and parses JSON', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"score": 0.9, "rationale": "great"}' }],
    });
    const client = { messages: { create } } as unknown as {
      messages: { create: typeof create };
    };
    const result = await judgeWithLLM(task(true), runResult, sandbox, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      apiKey: 'unused-because-client-injected',
    });
    expect(result).toEqual({ score0to1: 0.9, rationale: 'great' });
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0]?.[0];
    expect(Array.isArray(args.system)).toBe(true);
    expect(args.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(args.system[0].text).toContain('Code is clean and tested.');
  });

  it('degrades to undefined if the API call throws', async () => {
    const create = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { messages: { create } };
    const result = await judgeWithLLM(task(true), runResult, sandbox, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
    });
    expect(result).toBeUndefined();
  });
});

describe('buildJudgeSystemPrompt', () => {
  it('embeds the rubric criteria', () => {
    expect(buildJudgeSystemPrompt('be terse')).toContain('be terse');
  });
});

describe('parseJudgeResponse', () => {
  it('parses a clean JSON object', () => {
    expect(parseJudgeResponse('{"score":0.5,"rationale":"ok"}')).toEqual({
      score0to1: 0.5,
      rationale: 'ok',
    });
  });

  it('tolerates surrounding prose / fences', () => {
    const text = 'Here you go:\n```json\n{"score": 0.3, "rationale": "meh"}\n```\nThanks!';
    expect(parseJudgeResponse(text)).toEqual({ score0to1: 0.3, rationale: 'meh' });
  });

  it('clamps scores into [0,1]', () => {
    expect(parseJudgeResponse('{"score": 5}')?.score0to1).toBe(1);
    expect(parseJudgeResponse('{"score": -2}')?.score0to1).toBe(0);
  });

  it('returns undefined for unparseable or score-less input', () => {
    expect(parseJudgeResponse('no json here')).toBeUndefined();
    expect(parseJudgeResponse('{"rationale":"x"}')).toBeUndefined();
    expect(parseJudgeResponse('{bad json')).toBeUndefined();
  });
});
