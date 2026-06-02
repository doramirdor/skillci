import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { AgentOutputParseError, AgentUnavailableError } from './errors.js';
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
  const savedOpenAiKey = process.env.OPENAI_API_KEY;
  let workdir: string;

  beforeEach(async () => {
    // Force a barren environment: no PATH (no binaries), no API keys.
    process.env.PATH = '';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    workdir = await makeWorkdir();
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAiKey;
    await rm(workdir, { recursive: true, force: true });
  });

  it('ClaudeCodeAdapter.isAvailable() is false with empty PATH', async () => {
    await expect(new ClaudeCodeAdapter().isAvailable()).resolves.toBe(false);
  });

  it('ClaudeCodeAdapter.run() throws a typed missing-binary error', async () => {
    const adapter = new ClaudeCodeAdapter();
    const args = makeRunArgs(workdir, makeTask(), makeConfigSet('claude-code', ['c']));
    await expect(adapter.run(args)).rejects.toBeInstanceOf(AgentUnavailableError);
    try {
      await adapter.run(args);
    } catch (err) {
      expect(err).toBeInstanceOf(AgentUnavailableError);
      const e = err as AgentUnavailableError;
      expect(e.kind).toBe('claude-code');
      expect(e.reason).toBe('missing-binary');
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

  it('CodexAdapter.isAvailable() is false without API key', async () => {
    await expect(new CodexAdapter().isAvailable()).resolves.toBe(false);
  });

  it('CodexAdapter.run() throws a typed missing-api-key error', async () => {
    const adapter = new CodexAdapter();
    const args = makeRunArgs(workdir, makeTask({ agent: 'codex' }), makeConfigSet('codex', ['c']));
    try {
      await adapter.run(args);
      throw new Error('expected run() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentUnavailableError);
      const e = err as AgentUnavailableError;
      expect(e.kind).toBe('codex');
      expect(e.reason).toBe('missing-api-key');
    }
  });

  it('adapters declare the correct kind', () => {
    expect(new ClaudeCodeAdapter().kind).toBe('claude-code');
    expect(new CursorAdapter().kind).toBe('cursor');
    expect(new CodexAdapter().kind).toBe('codex');
  });
});

/**
 * Pins each adapter's auth contract independently of binary presence. We put a
 * *real* executable named `claude`/`codex` on PATH but clear the API keys.
 *
 * - Codex is KEY-gated: even with the binary present, no `OPENAI_API_KEY` means
 *   isAvailable()===false and run() throws a typed missing-api-key error.
 * - Claude is BINARY-gated (the CLI owns its own auth — API key OR
 *   subscription/OAuth — exactly like Cursor): with the binary present it is
 *   available, and an un-authed/empty CLI invocation surfaces as a typed
 *   AgentOutputParseError rather than a fabricated success.
 *
 * Skipped on Windows (the fake shell-script binaries are POSIX).
 */
const describeKeyGate = process.platform === 'win32' ? describe.skip : describe;

describeKeyGate('key-gated adapters degrade gracefully when binary present but key absent', () => {
  const savedPath = process.env.PATH;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedOpenAiKey = process.env.OPENAI_API_KEY;
  let binDir: string;
  let workdir: string;

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'skillci-fakebin-'));
    // Minimal POSIX executables so `command -v` resolves them on PATH.
    for (const name of ['claude', 'codex']) {
      const p = join(binDir, name);
      await writeFile(p, '#!/bin/sh\nexit 0\n');
      await chmod(p, 0o755);
    }
    // Real PATH appended so `command`/`sh` still resolve, plus our fake bins.
    process.env.PATH = `${binDir}:${savedPath ?? ''}`;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    workdir = await makeWorkdir();
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAiKey;
    await rm(binDir, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  });

  it('ClaudeCodeAdapter is AVAILABLE with binary on PATH despite no API key (CLI owns auth)', async () => {
    const adapter = new ClaudeCodeAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(true);
    // The fake `claude` exits 0 with empty stdout (un-authed/no telemetry). The
    // adapter must surface that as a typed parse error, not a fabricated success.
    const args = makeRunArgs(workdir, makeTask(), makeConfigSet('claude-code', ['c']));
    try {
      await adapter.run(args);
      throw new Error('expected run() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentOutputParseError);
      expect((err as AgentOutputParseError).kind).toBe('claude-code');
    }
  });

  it('CodexAdapter is unavailable and run() throws missing-api-key despite binary on PATH', async () => {
    const adapter = new CodexAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(false);
    const args = makeRunArgs(workdir, makeTask({ agent: 'codex' }), makeConfigSet('codex', ['c']));
    try {
      await adapter.run(args);
      throw new Error('expected run() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentUnavailableError);
      expect((err as AgentUnavailableError).reason).toBe('missing-api-key');
    }
  });
});
