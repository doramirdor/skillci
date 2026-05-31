import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgentAdapter } from './mock-adapter.js';
import {
  fileContains,
  fileExists,
  makeConfigSet,
  makeRunArgs,
  makeTask,
  makeWorkdir,
} from './test-helpers.js';

describe('MockAgentAdapter', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await makeWorkdir();
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('is always available offline (no binary, key, or network)', async () => {
    await expect(new MockAgentAdapter().isAvailable()).resolves.toBe(true);
  });

  it('returns well-formed telemetry with sane bounds', async () => {
    const adapter = new MockAgentAdapter();
    const task = makeTask();
    const cfg = makeConfigSet('claude-code', ['baseline']);
    const res = await adapter.run(makeRunArgs(workdir, task, cfg));

    expect(res.steps).toBeGreaterThanOrEqual(2);
    expect(res.toolCalls).toBeGreaterThanOrEqual(1);
    expect(res.inputTokens).toBeGreaterThan(0);
    expect(res.outputTokens).toBeGreaterThan(0);
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.wallClockMs).toBeGreaterThanOrEqual(200);
    expect(typeof res.transcript).toBe('string');
    expect(res.transcript).toContain(task.id);
  });

  it('is fully deterministic for identical (task, config) inputs', async () => {
    const task = makeTask();
    const cfg = makeConfigSet('claude-code', ['some config content']);

    const wd1 = workdir;
    const a = await new MockAgentAdapter().run(makeRunArgs(wd1, task, cfg));

    const wd2 = await makeWorkdir();
    try {
      const b = await new MockAgentAdapter().run(makeRunArgs(wd2, task, cfg));
      // Telemetry identical.
      expect(b.toolCalls).toBe(a.toolCalls);
      expect(b.inputTokens).toBe(a.inputTokens);
      expect(b.outputTokens).toBe(a.outputTokens);
      expect(b.steps).toBe(a.steps);
      expect(b.costUsd).toBe(a.costUsd);
      expect(b.wallClockMs).toBe(a.wallClockMs);
      // raw seed identical.
      expect((b.raw as { seed: number }).seed).toBe(
        (a.raw as { seed: number }).seed,
      );
    } finally {
      await rm(wd2, { recursive: true, force: true });
    }
  });

  it('produces stable but DIFFERENT results for baseline vs candidate configs', async () => {
    const task = makeTask();
    const baseline = makeConfigSet('claude-code', ['baseline config v1']);
    const candidate = makeConfigSet('claude-code', ['candidate config v2 improved']);

    const wdB = workdir;
    const wdC = await makeWorkdir();
    try {
      const resB = await new MockAgentAdapter().run(makeRunArgs(wdB, task, baseline));
      const resC = await new MockAgentAdapter().run(makeRunArgs(wdC, task, candidate));

      const seedB = (resB.raw as { seed: number }).seed;
      const seedC = (resC.raw as { seed: number }).seed;
      expect(seedB).not.toBe(seedC);
    } finally {
      await rm(wdC, { recursive: true, force: true });
    }
  });

  it('writes files that satisfy fileExists / fileContains checks deterministically', async () => {
    // With qualityBias 1, satisfy probability is high; assert files are written.
    const adapter = new MockAgentAdapter({ qualityBias: 1 });
    const task = makeTask({
      checks: [
        fileExists('src/created.ts'),
        fileContains('README.md', 'SKILLCI_MARKER'),
      ],
    });
    const cfg = makeConfigSet('claude-code', ['cfg']);
    const res = await adapter.run(makeRunArgs(workdir, task, cfg));

    const wrote = (res.raw as { wrote: string[] }).wrote;
    expect(wrote.length).toBeGreaterThan(0);

    // Every reported write actually exists on disk.
    for (const rel of wrote) {
      await expect(stat(join(workdir, rel))).resolves.toBeDefined();
    }

    // If README.md was satisfied, it contains the substring.
    if (wrote.includes('README.md')) {
      const content = await readFile(join(workdir, 'README.md'), 'utf8');
      expect(content).toContain('SKILLCI_MARKER');
    }
  });

  it('higher qualityBias satisfies at least as many checks as lower bias (same seed line)', async () => {
    const checks = Array.from({ length: 12 }, (_, i) => fileExists(`f/${i}.txt`));
    const task = makeTask({ checks });
    const cfg = makeConfigSet('claude-code', ['fixed-config']);

    const wdLow = workdir;
    const wdHigh = await makeWorkdir();
    try {
      const low = await new MockAgentAdapter({ qualityBias: 0 }).run(
        makeRunArgs(wdLow, task, cfg),
      );
      const high = await new MockAgentAdapter({ qualityBias: 1 }).run(
        makeRunArgs(wdHigh, task, cfg),
      );
      const lowCount = (low.raw as { wrote: string[] }).wrote.length;
      const highCount = (high.raw as { wrote: string[] }).wrote.length;
      expect(highCount).toBeGreaterThanOrEqual(lowCount);
    } finally {
      await rm(wdHigh, { recursive: true, force: true });
    }
  });

  it('does not fake command/testSuite checks (only writes files)', async () => {
    const adapter = new MockAgentAdapter({ qualityBias: 1 });
    const task = makeTask({
      checks: [{ kind: 'command', cmd: 'npm test', expectExitZero: true }],
    });
    const cfg = makeConfigSet('claude-code', ['cfg']);
    const res = await adapter.run(makeRunArgs(workdir, task, cfg));
    expect((res.raw as { wrote: string[] }).wrote).toEqual([]);
  });

  it('refuses path traversal in check paths (writes nothing dangerous)', async () => {
    const adapter = new MockAgentAdapter({ qualityBias: 1 });
    const task = makeTask({
      checks: [
        fileExists('../escape.txt'),
        fileExists('/etc/passwd'),
      ],
    });
    const cfg = makeConfigSet('claude-code', ['cfg']);
    const res = await adapter.run(makeRunArgs(workdir, task, cfg));
    // Both unsafe paths are dropped; nothing written.
    expect((res.raw as { wrote: string[] }).wrote).toEqual([]);
  });

  it('handles a task with no checks (writes nothing, still returns telemetry)', async () => {
    const adapter = new MockAgentAdapter();
    const res = await adapter.run(
      makeRunArgs(workdir, makeTask({ checks: [] }), makeConfigSet('claude-code', ['x'])),
    );
    expect((res.raw as { wrote: string[] }).wrote).toEqual([]);
    expect(res.steps).toBeGreaterThan(0);
  });

  it('declares kind claude-code', () => {
    expect(new MockAgentAdapter().kind).toBe('claude-code');
  });
});
