/**
 * Ephemeral sandbox manager.
 *
 * `createSandbox(fixtureDir)` copies a fixture repo into an isolated working
 * copy and returns a {@link Sandbox} handle. The handle exposes `exec` (run a
 * command with a captured {@link SandboxResult}), `snapshotDiff` (changed files
 * vs the initial fixture), and `dispose` (`rm -rf`). The execution backend is
 * pluggable so a container backend can be added without changing call sites.
 */
import type { FileDiffEntry, SandboxResult } from '../core/index.js';
import { LocalSandboxBackend } from './local-backend.js';
import type {
  CreateSandboxOptions,
  ExecOptions,
  Sandbox,
  SandboxBackend,
  WorkdirSnapshot,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;

class SandboxHandle implements Sandbox {
  readonly workdir: string;
  readonly #backend: SandboxBackend;
  readonly #defaultTimeoutMs: number;
  readonly #initialSnapshot: WorkdirSnapshot;
  #disposed = false;

  constructor(
    workdir: string,
    backend: SandboxBackend,
    defaultTimeoutMs: number,
    initialSnapshot: WorkdirSnapshot,
  ) {
    this.workdir = workdir;
    this.#backend = backend;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    this.#initialSnapshot = initialSnapshot;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<SandboxResult> {
    this.#assertLive();
    const base = await this.#backend.exec(
      this.workdir,
      cmd,
      opts,
      this.#defaultTimeoutMs,
    );
    const fileDiff = await this.#backend.diff(this.workdir, this.#initialSnapshot);
    return { ...base, fileDiff };
  }

  async snapshotDiff(): Promise<FileDiffEntry[]> {
    this.#assertLive();
    return this.#backend.diff(this.workdir, this.#initialSnapshot);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#backend.cleanup(this.workdir);
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new Error(`Sandbox already disposed: ${this.workdir}`);
    }
  }
}

/**
 * Create an isolated, ephemeral sandbox seeded from `fixtureDir`.
 *
 * The fixture is recursively copied into a fresh directory under
 * `os.tmpdir()`. Callers should `dispose()` the returned handle when done
 * (ideally in a `finally`). Optionally `gitInit`s the working copy.
 */
export async function createSandbox(
  fixtureDir: string,
  options: CreateSandboxOptions = {},
): Promise<Sandbox> {
  const backend = options.backend ?? new LocalSandboxBackend();
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workdir = await backend.prepare(fixtureDir, options);
  const initialSnapshot = await backend.snapshot(workdir);
  return new SandboxHandle(workdir, backend, defaultTimeoutMs, initialSnapshot);
}

/**
 * Create a sandbox, run `fn` against it, and always dispose it afterward —
 * even if `fn` throws. Returns whatever `fn` returns.
 */
export async function withSandbox<T>(
  fixtureDir: string,
  fn: (sandbox: Sandbox) => Promise<T>,
  options: CreateSandboxOptions = {},
): Promise<T> {
  const sandbox = await createSandbox(fixtureDir, options);
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.dispose();
  }
}
