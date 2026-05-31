import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { AgentUnavailableError } from './errors.js';
import {
  makeConfigSet,
  makeRunArgs,
  makeTask,
  makeWorkdir,
} from './test-helpers.js';

/**
 * These tests run fully offline. We make unavailability *deterministic* by
 * scrubbing the API key and emptying PATH so no agent binary can be found,
 * regardless of what is installed on the host CI machine.
 */
describe('real adapters degrade gracefully when unavailable', () => {
  const savedPath = process.env.PATH;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  let workdir: string;

  beforeEach(async () => {
    // Force a barren environment: no PATH (no binaries), no API key.
    process.env.PATH = '';
    delete process.env.ANTHROPIC_API_KEY;
    workdir = await makeWorkdir();
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    await rm(workdir, { recursive: true, force: true });
  });

  it('ClaudeCodeAdapter.isAvailable() is false without API key', async () => {
    await expect(new ClaudeCodeAdapter().isAvailable()).resolves.toBe(false);
  });

  it('ClaudeCodeAdapter.run() throws a typed missing-api-key error', async () => {
    const adapter = new ClaudeCodeAdapter();
    const args = makeRunArgs(workdir, makeTask(), makeConfigSet('claude-code', ['c']));
    await expect(adapter.run(args)).rejects.toBeInstanceOf(AgentUnavailableError);
    try {
      await adapter.run(args);
    } catch (err) {
      expect(err).toBeInstanceOf(AgentUnavailableError);
      const e = err as AgentUnavailableError;
      expect(e.kind).toBe('claude-code');
      expect(e.reason).toBe('missing-api-key');
    }
  });

  it('CursorAdapter.isAvailable() is false with empty PATH', async () => {
    await expect(new CursorAdapter().isAvailable()).resolves.toBe(false);
  });

  it('CursorAdapter.run() throws a typed missing-binary error', async () => {
    const adapter = new CursorAdapter();
    const args = makeRunArgs(workdir, makeTask({ agent: 'cursor' }), makeConfigSet('cursor', ['c']));
    try {
      await adapter.run(args);
      throw new Error('expected run() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentUnavailableError);
      const e = err as AgentUnavailableError;
      expect(e.kind).toBe('cursor');
      expect(e.reason).toBe('missing-binary');
    }
  });

  it('CodexAdapter.isAvailable() is false with empty PATH', async () => {
    await expect(new CodexAdapter().isAvailable()).resolves.toBe(false);
  });

  it('CodexAdapter.run() throws a typed missing-binary error', async () => {
    const adapter = new CodexAdapter();
    const args = makeRunArgs(workdir, makeTask({ agent: 'codex' }), makeConfigSet('codex', ['c']));
    try {
      await adapter.run(args);
      throw new Error('expected run() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentUnavailableError);
      const e = err as AgentUnavailableError;
      expect(e.kind).toBe('codex');
      expect(e.reason).toBe('missing-binary');
    }
  });

  it('adapters declare the correct kind', () => {
    expect(new ClaudeCodeAdapter().kind).toBe('claude-code');
    expect(new CursorAdapter().kind).toBe('cursor');
    expect(new CodexAdapter().kind).toBe('codex');
  });
});
