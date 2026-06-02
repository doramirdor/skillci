/**
 * Offline tests for the sandbox module. These run real shell commands
 * (`echo`, `node -e`, file writes) against a throwaway temp fixture — no
 * network, no API keys.
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandbox, withSandbox, LocalSandboxBackend } from './index.js';
import type { Sandbox } from './index.js';

let fixtureDir: string;
const liveSandboxes: Sandbox[] = [];

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skillci-fixture-'));
  await writeFile(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  await writeFile(path.join(dir, 'value.txt'), 'original\n', 'utf8');
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'index.js'), 'console.log("hi");\n', 'utf8');
  // A .git dir that must NOT be carried into the working copy.
  await mkdir(path.join(dir, '.git'), { recursive: true });
  await writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  return dir;
}

async function track(sb: Sandbox): Promise<Sandbox> {
  liveSandboxes.push(sb);
  return sb;
}

beforeEach(async () => {
  fixtureDir = await makeFixture();
});

afterEach(async () => {
  for (const sb of liveSandboxes.splice(0)) {
    await sb.dispose().catch(() => {});
  }
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('createSandbox', () => {
  it('copies the fixture into an isolated tmpdir working copy', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    expect(sb.workdir).not.toEqual(fixtureDir);
    expect(sb.workdir.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(path.join(sb.workdir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(sb.workdir, 'src', 'index.js'))).toBe(true);
    const value = await readFile(path.join(sb.workdir, 'value.txt'), 'utf8');
    expect(value).toBe('original\n');
  });

  it('does not carry the fixture .git directory into the working copy', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    expect(fs.existsSync(path.join(sb.workdir, '.git'))).toBe(false);
  });

  it('isolates writes from the original fixture', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    await writeFile(path.join(sb.workdir, 'value.txt'), 'changed\n', 'utf8');
    const original = await readFile(path.join(fixtureDir, 'value.txt'), 'utf8');
    expect(original).toBe('original\n');
  });

  it('throws on a missing fixture directory', async () => {
    await expect(
      createSandbox(path.join(os.tmpdir(), 'skillci-does-not-exist-xyz')),
    ).rejects.toThrow(/does not exist/i);
  });
});

describe('exec', () => {
  it('runs echo and captures stdout + exit 0 + duration', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    const res = await sb.exec('echo hello-sandbox');
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('hello-sandbox');
    expect(res.stderr).toBe('');
    expect(res.workdir).toBe(sb.workdir);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.fileDiff)).toBe(true);
  });

  it('runs node -e in the sandbox', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    const res = await sb.exec(`node -e "process.stdout.write('node-ok')"`);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('node-ok');
  });

  it('reports a non-zero exit code without throwing', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    const res = await sb.exec('node -e "process.exit(3)"');
    expect(res.exitCode).toBe(3);
  });

  it('executes relative to the sandbox workdir', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    const res = await sb.exec('cat value.txt');
    expect(res.stdout).toContain('original');
  });

  it('honors the cwd option', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    const res = await sb.exec('cat index.js', { cwd: 'src' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('console.log');
  });

  it('passes env vars and stdin', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    const res = await sb.exec('node -e "process.stdout.write(process.env.SK_TEST)"', {
      env: { SK_TEST: 'env-value' },
    });
    expect(res.stdout).toContain('env-value');

    const stdinRes = await sb.exec('cat', { input: 'piped-input' });
    expect(stdinRes.stdout).toContain('piped-input');
  });

  it('enforces a per-command timeout and reports it', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    const res = await sb.exec('node -e "setTimeout(()=>{}, 30000)"', {
      timeoutMs: 150,
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/timed out/i);
    // Worst case is timeoutMs + forceKillAfterDelay (~1.2s); the 30s inner timer
    // ensures we genuinely exercise the kill path, not a natural early exit.
  }, 20_000);
});

describe('snapshotDiff', () => {
  it('returns empty when nothing changed', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    const diff = await sb.snapshotDiff();
    expect(diff).toEqual([]);
  });

  it('detects added files', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    await writeFile(path.join(sb.workdir, 'new-file.txt'), 'new\n', 'utf8');
    const diff = await sb.snapshotDiff();
    expect(diff).toContainEqual({ path: 'new-file.txt', status: 'added' });
  });

  it('detects modified files', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    await writeFile(path.join(sb.workdir, 'value.txt'), 'changed\n', 'utf8');
    const diff = await sb.snapshotDiff();
    expect(diff).toContainEqual({ path: 'value.txt', status: 'modified' });
  });

  it('detects deleted files', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    await rm(path.join(sb.workdir, 'README.md'));
    const diff = await sb.snapshotDiff();
    expect(diff).toContainEqual({ path: 'README.md', status: 'deleted' });
  });

  it('reflects changes via exec-produced files too', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    const res = await sb.exec('node -e "require(\'fs\').writeFileSync(\'made.txt\',\'x\')"');
    expect(res.exitCode).toBe(0);
    expect(res.fileDiff).toContainEqual({ path: 'made.txt', status: 'added' });
  });

  it('detects nested file changes', async () => {
    const sb = await track(await createSandbox(fixtureDir));
    await writeFile(path.join(sb.workdir, 'src', 'index.js'), 'console.log("changed");\n', 'utf8');
    const diff = await sb.snapshotDiff();
    expect(diff).toContainEqual({ path: 'src/index.js', status: 'modified' });
  });
});

describe('dispose', () => {
  it('removes the working copy and is idempotent', async () => {
    const sb = await createSandbox(fixtureDir);
    const workdir = sb.workdir;
    expect(fs.existsSync(workdir)).toBe(true);
    await sb.dispose();
    expect(fs.existsSync(workdir)).toBe(false);
    await expect(sb.dispose()).resolves.toBeUndefined();
  });

  it('rejects exec after dispose', async () => {
    const sb = await createSandbox(fixtureDir);
    await sb.dispose();
    await expect(sb.exec('echo hi')).rejects.toThrow(/disposed/i);
  });
});

describe('withSandbox', () => {
  it('disposes after the callback resolves', async () => {
    let captured = '';
    const out = await withSandbox(fixtureDir, async (sb) => {
      captured = sb.workdir;
      const res = await sb.exec('echo scoped');
      return res.stdout.trim();
    });
    expect(out).toBe('scoped');
    expect(fs.existsSync(captured)).toBe(false);
  });

  it('disposes even when the callback throws', async () => {
    let captured = '';
    await expect(
      withSandbox(fixtureDir, async (sb) => {
        captured = sb.workdir;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(captured)).toBe(false);
  });
});

describe('gitInit', () => {
  it('initializes a git repo when requested (best-effort)', async () => {
    const sb = await track(await createSandbox(fixtureDir, { gitInit: true }));
    const res = await sb.exec('git rev-parse --is-inside-work-tree');
    // If git is unavailable the sandbox still works; only assert when present.
    if (res.exitCode === 0) {
      expect(res.stdout.trim()).toBe('true');
      expect(fs.existsSync(path.join(sb.workdir, '.git'))).toBe(true);
    }
  });
});

describe('LocalSandboxBackend', () => {
  it('is the default backend and is injectable', async () => {
    const backend = new LocalSandboxBackend();
    expect(backend.id).toBe('local');
    const sb = await track(await createSandbox(fixtureDir, { backend }));
    const res = await sb.exec('echo via-injected-backend');
    expect(res.stdout.trim()).toBe('via-injected-backend');
  });

  it('respects a custom tmpPrefix', async () => {
    const sb = await track(
      await createSandbox(fixtureDir, { tmpPrefix: 'skillci-custom-' }),
    );
    expect(path.basename(sb.workdir).startsWith('skillci-custom-')).toBe(true);
  });
});
