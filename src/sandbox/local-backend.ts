/**
 * Local (host filesystem) sandbox backend.
 *
 * Materializes an isolated recursive copy of a fixture repo under
 * `os.tmpdir()`, runs commands via execa with captured output + enforced
 * timeouts, and computes content diffs by hashing files before/after.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import type { FileDiffEntry, SandboxResult } from '../core/index.js';
import type {
  CreateSandboxOptions,
  ExecOptions,
  SandboxBackend,
  WorkdirSnapshot,
} from './types.js';

const DEFAULT_TMP_PREFIX = 'skillci-sandbox-';

/** Directories we never recurse into when copying or snapshotting. */
const IGNORED_DIRS = new Set(['.git', 'node_modules']);

/**
 * Recursively collect relative POSIX paths of all regular files under `root`,
 * skipping {@link IGNORED_DIRS}. Symlinks are recorded as files (by their link
 * path content) rather than followed, to avoid escaping the sandbox.
 */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(relPath);
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * Coerce execa's stdout/stderr (string by default, but typed loosely) into a
 * plain string. Handles the binary / `lines` shapes defensively.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (Array.isArray(value)) return value.map((v) => asText(v)).join('\n');
  return String(value);
}

/** sha256 hex of a file's bytes; returns `null` if it can't be read. */
async function hashFile(abs: string): Promise<string | null> {
  try {
    const buf = await readFile(abs);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

export class LocalSandboxBackend implements SandboxBackend {
  readonly id = 'local';

  async prepare(fixtureDir: string, opts: CreateSandboxOptions): Promise<string> {
    const resolved = path.resolve(fixtureDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Fixture directory does not exist or is not a directory: ${resolved}`);
    }
    const prefix = opts.tmpPrefix ?? DEFAULT_TMP_PREFIX;
    const workdir = await mkdtemp(path.join(os.tmpdir(), prefix));

    // Recursive copy of the fixture into the working copy. We copy contents
    // (not the fixture dir itself) so the workdir root mirrors the fixture root.
    // The .git of the fixture is intentionally not carried over.
    fs.cpSync(resolved, workdir, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        return base !== '.git';
      },
    });

    if (opts.gitInit) {
      await this.#gitInit(workdir);
    }
    return workdir;
  }

  async #gitInit(workdir: string): Promise<void> {
    const env = {
      GIT_AUTHOR_NAME: 'SkillCI',
      GIT_AUTHOR_EMAIL: 'skillci@example.com',
      GIT_COMMITTER_NAME: 'SkillCI',
      GIT_COMMITTER_EMAIL: 'skillci@example.com',
    };
    const run = (args: string[]) =>
      execa('git', args, {
        cwd: workdir,
        env,
        reject: false,
        timeout: 30_000,
      });
    // Best-effort: if git isn't present, silently continue (sandbox still works).
    const init = await run(['init', '-q']);
    if (init.exitCode !== 0) return;
    await run(['add', '-A']);
    await run(['commit', '-q', '-m', 'skillci: initial fixture snapshot', '--allow-empty']);
  }

  async exec(
    workdir: string,
    cmd: string,
    opts: ExecOptions,
    defaultTimeoutMs: number,
  ): Promise<Omit<SandboxResult, 'fileDiff'>> {
    const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
    const cwd = opts.cwd ? path.resolve(workdir, opts.cwd) : workdir;
    const useShell = opts.shell ?? true;
    const started = Date.now();

    try {
      const result = await execa(cmd, {
        cwd,
        shell: useShell,
        timeout: timeoutMs,
        // On timeout execa sends SIGTERM, then escalates to SIGKILL after this
        // delay. execa's default is 5000ms, which means a process that ignores
        // SIGTERM keeps the call alive ~5s past the timeout (and would trip a
        // 5s test budget). Escalate fast so timeouts reclaim promptly.
        forceKillAfterDelay: 1_000,
        reject: false,
        all: false,
        // execa inherits process.env by default; only override when asked.
        ...(opts.env ? { env: opts.env, extendEnv: true } : {}),
        ...(opts.input !== undefined ? { input: opts.input } : {}),
        // Keep large outputs from blowing up memory in pathological cases.
        maxBuffer: 32 * 1024 * 1024,
      });
      const durationMs = Date.now() - started;
      // execa's result with reject:false: timedOut / failed reflected on object.
      const r = result as {
        exitCode?: number;
        stdout?: unknown;
        stderr?: unknown;
        timedOut?: boolean;
      };
      const timedOut = r.timedOut === true;
      const exitCode =
        typeof r.exitCode === 'number' ? r.exitCode : timedOut ? 124 : 1;
      const rawStdout = asText(r.stdout);
      const rawStderr = asText(r.stderr);
      const stderr = timedOut
        ? `${rawStderr}${rawStderr ? '\n' : ''}[skillci] command timed out after ${timeoutMs}ms`
        : rawStderr;
      return {
        workdir,
        exitCode,
        stdout: rawStdout,
        stderr,
        durationMs,
      };
    } catch (err: unknown) {
      // Defensive: execa with reject:false should not throw, but guard anyway.
      const durationMs = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      return {
        workdir,
        exitCode: 1,
        stdout: '',
        stderr: `[skillci] failed to spawn command: ${message}`,
        durationMs,
      };
    }
  }

  async snapshot(workdir: string): Promise<WorkdirSnapshot> {
    const files = listFiles(workdir);
    const hashes = new Map<string, string>();
    await Promise.all(
      files.map(async (rel) => {
        const h = await hashFile(path.join(workdir, rel));
        if (h !== null) hashes.set(rel, h);
      }),
    );
    return { hashes };
  }

  async diff(workdir: string, initial: WorkdirSnapshot): Promise<FileDiffEntry[]> {
    const current = await this.snapshot(workdir);
    const entries: FileDiffEntry[] = [];

    for (const [rel, hash] of current.hashes) {
      const prior = initial.hashes.get(rel);
      if (prior === undefined) {
        entries.push({ path: rel, status: 'added' });
      } else if (prior !== hash) {
        entries.push({ path: rel, status: 'modified' });
      }
    }
    for (const rel of initial.hashes.keys()) {
      if (!current.hashes.has(rel)) {
        entries.push({ path: rel, status: 'deleted' });
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  async cleanup(workdir: string): Promise<void> {
    if (!workdir) return;
    await rm(workdir, { recursive: true, force: true });
  }
}
