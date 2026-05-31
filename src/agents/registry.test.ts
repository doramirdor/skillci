import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { MockAgentAdapter } from './mock-adapter.js';
import { SUPPORTED_AGENT_KINDS, getAdapter } from './registry.js';
import {
  makeConfigSet,
  makeRunArgs,
  makeTask,
  makeWorkdir,
} from './test-helpers.js';

describe('getAdapter', () => {
  it('returns real adapters by default, one per kind', () => {
    expect(getAdapter('claude-code')).toBeInstanceOf(ClaudeCodeAdapter);
    expect(getAdapter('cursor')).toBeInstanceOf(CursorAdapter);
    expect(getAdapter('codex')).toBeInstanceOf(CodexAdapter);
  });

  it('returns the mock adapter for claude-code when mock:true', () => {
    const a = getAdapter('claude-code', { mock: true });
    expect(a).toBeInstanceOf(MockAgentAdapter);
    expect(a.kind).toBe('claude-code');
  });

  it('returns a mock that reports the requested kind for cursor/codex', async () => {
    const cursor = getAdapter('cursor', { mock: true });
    const codex = getAdapter('codex', { mock: true });
    expect(cursor.kind).toBe('cursor');
    expect(codex.kind).toBe('codex');
    await expect(cursor.isAvailable()).resolves.toBe(true);
    await expect(codex.isAvailable()).resolves.toBe(true);
  });

  it('mock adapter from registry actually runs offline', async () => {
    const workdir = await makeWorkdir();
    try {
      const adapter = getAdapter('cursor', { mock: true });
      const res = await adapter.run(
        makeRunArgs(workdir, makeTask({ agent: 'cursor' }), makeConfigSet('cursor', ['x'])),
      );
      expect(res.steps).toBeGreaterThan(0);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it('forwards mockOptions (qualityBias) to the mock', async () => {
    const workdir = await makeWorkdir();
    try {
      const adapter = getAdapter('claude-code', {
        mock: true,
        mockOptions: { qualityBias: 1 },
      });
      const res = await adapter.run(
        makeRunArgs(
          workdir,
          makeTask({ checks: [{ kind: 'fileExists', path: 'a.txt' }] }),
          makeConfigSet('claude-code', ['c']),
        ),
      );
      expect((res.raw as { quality: number }).quality).toBeGreaterThan(0.49);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it('exposes the supported agent kinds', () => {
    expect(SUPPORTED_AGENT_KINDS).toEqual(['claude-code', 'cursor', 'codex']);
  });
});
