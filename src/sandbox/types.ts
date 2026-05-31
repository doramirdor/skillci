/**
 * Sandbox module — public types.
 *
 * Runtime telemetry types (`SandboxResult`, `FileDiffEntry`) come from the
 * shared contracts. This file declares the sandbox-specific surface (options,
 * the `Sandbox` handle, and the pluggable backend interface) so a container
 * backend can be added later without touching call sites.
 */
import type { FileDiffEntry, SandboxResult } from '../core/index.js';

/** Options governing how a sandbox is created. */
export interface CreateSandboxOptions {
  /**
   * Run `git init` (+ an initial commit) inside the working copy after the
   * fixture is staged. Useful for tasks/agents that expect a git repo or that
   * compute diffs via git. Defaults to `false`.
   */
  gitInit?: boolean;
  /**
   * Prefix for the temp working-directory name created under `os.tmpdir()`.
   * Defaults to `"skillci-sandbox-"`.
   */
  tmpPrefix?: string;
  /**
   * Default per-command timeout (ms) applied by `exec` when a call does not
   * specify its own. Defaults to 120_000 (2 minutes).
   */
  defaultTimeoutMs?: number;
  /**
   * The backend to use. Defaults to a fresh {@link LocalSandboxBackend}.
   * Injected primarily so tests / future container backends can swap it.
   */
  backend?: SandboxBackend;
}

/** Options for a single {@link Sandbox.exec} call. */
export interface ExecOptions {
  /** Per-command wall-clock timeout in milliseconds. Overrides the default. */
  timeoutMs?: number;
  /**
   * Working directory for the command, relative to the sandbox workdir.
   * Defaults to the workdir root.
   */
  cwd?: string;
  /** Extra environment variables merged over the inherited environment. */
  env?: Record<string, string>;
  /**
   * If true, run the command through a shell (so pipes/globs/`&&` work).
   * Defaults to `true` because most objective checks are shell strings.
   */
  shell?: boolean;
  /** Optional stdin to pipe into the command. */
  input?: string;
}

/**
 * A live, isolated sandbox: an ephemeral working copy of a fixture repo plus
 * the operations the rest of SkillCI performs against it.
 */
export interface Sandbox {
  /** Absolute path to the isolated working directory. */
  readonly workdir: string;

  /**
   * Run a command inside the sandbox. Captures stdout/stderr, the exit code,
   * and the wall-clock duration; never throws on a non-zero exit or timeout —
   * those are reported in the returned {@link SandboxResult}. The result's
   * `fileDiff` reflects changes versus the initial fixture snapshot at the
   * time of the call.
   */
  exec(cmd: string, opts?: ExecOptions): Promise<SandboxResult>;

  /**
   * Compute the set of files that changed (added / modified / deleted) versus
   * the initial fixture snapshot taken at creation time.
   */
  snapshotDiff(): Promise<FileDiffEntry[]>;

  /** Tear the sandbox down (`rm -rf` the working copy). Idempotent. */
  dispose(): Promise<void>;
}

/**
 * A content snapshot of the working copy: relative path -> sha256 of the file
 * bytes (plus the set of paths) used to compute {@link FileDiffEntry} diffs.
 */
export interface WorkdirSnapshot {
  /** Map of relative POSIX path -> sha256 hex of the file content. */
  hashes: Map<string, string>;
}

/**
 * Pluggable execution backend. The local backend runs on the host filesystem;
 * a future container backend can implement the same surface so sandboxes can be
 * isolated more strongly without changing the {@link Sandbox} API.
 */
export interface SandboxBackend {
  /** Stable backend identifier (e.g. `"local"`). */
  readonly id: string;

  /**
   * Materialize an isolated working copy of `fixtureDir` and return its
   * absolute path. Implementations must perform a recursive copy.
   */
  prepare(fixtureDir: string, opts: CreateSandboxOptions): Promise<string>;

  /**
   * Run a command in `workdir`. Must never reject for ordinary command failures
   * (non-zero exit, timeout); those are encoded in the result.
   */
  exec(
    workdir: string,
    cmd: string,
    opts: ExecOptions,
    defaultTimeoutMs: number,
  ): Promise<Omit<SandboxResult, 'fileDiff'>>;

  /** Capture a content snapshot of the working copy. */
  snapshot(workdir: string): Promise<WorkdirSnapshot>;

  /** Diff the current working-copy state against an earlier snapshot. */
  diff(workdir: string, initial: WorkdirSnapshot): Promise<FileDiffEntry[]>;

  /** Recursively remove the working copy. Idempotent. */
  cleanup(workdir: string): Promise<void>;
}
