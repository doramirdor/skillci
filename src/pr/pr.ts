/**
 * PR promotion module — opens a GitHub pull request for a CANDIDATE config set,
 * gated STRICTLY on the comparison verdict.
 *
 * HARD RULE (see contracts + README): a PR is opened ONLY when the candidate is
 * promotable — i.e. `shouldPromote(comparison)` is true, which requires the
 * verdict to be `improved` with ZERO hard regressions. On any other verdict the
 * promotion is SKIPPED with an explicit reason; nothing is mutated.
 *
 * When promoting, the module:
 *   1. creates a candidate branch (`branchPrefix` + slug),
 *   2. writes the candidate artifacts to disk (relative to the repo root),
 *   3. stages + commits them,
 *   4. opens a PR via the `gh` CLI with the markdown `report` as the body.
 *
 * DRY-RUN BY DEFAULT (`options.dryRun !== false`): instead of executing any git
 * or gh command (or touching the filesystem), it records the planned commands
 * and returns them. This keeps the whole flow fully offline + side-effect-free
 * in tests and demos. Real execution only happens when `dryRun` is explicitly
 * set to `false` AND `gh` is available.
 */

import { execa } from 'execa';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PrConfigSchema,
  type Comparison,
  type ConfigSet,
  type PrConfig,
} from '../core/index.js';
import { shouldPromote } from '../compare/index.js';

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A single planned (or executed) shell step. In dry-run mode these are the
 * commands the module WOULD run; in live mode they are the commands it ran.
 */
export interface PlannedCommand {
  /** The executable (e.g. `git`, `gh`). */
  command: string;
  /** Its arguments, unquoted. */
  args: string[];
  /** Human-readable, shell-ish rendering (for printing / assertions). */
  display: string;
}

/**
 * A file the promotion would write (or wrote) into the repo, derived from a
 * candidate artifact.
 */
export interface PlannedFileWrite {
  /** Path relative to the repo root. */
  path: string;
  /** Number of bytes that would be / were written. */
  bytes: number;
}

/** Options controlling a promotion attempt. */
export interface OpenPromotionPROptions {
  /**
   * Absolute path to the git repository root the PR is opened from. Defaults to
   * `process.cwd()`.
   */
  repoDir?: string;
  /**
   * PR settings (base branch, branch prefix, reviewers, draft). Partial input
   * is parsed + defaulted via the shared `PrConfigSchema`.
   */
  prConfig?: Partial<PrConfig>;
  /**
   * Dry-run toggle. DRY-RUN BY DEFAULT: a PR is only really opened when this is
   * explicitly `false`. Any other value (including `undefined`) => dry run.
   */
  dryRun?: boolean;
  /** Optional explicit branch name. When omitted, one is derived. */
  branch?: string;
  /** Optional PR title. When omitted, one is derived from the comparison. */
  title?: string;
  /** Optional commit message. When omitted, one is derived from the title. */
  commitMessage?: string;
  /**
   * Sink for dry-run command printing. Defaults to a no-op (the planned
   * commands are always returned on the result regardless of this).
   */
  printer?: (line: string) => void;
}

/** Arguments to {@link openPromotionPR}. */
export interface OpenPromotionPRArgs {
  /** The baseline-vs-candidate comparison that gates promotion. */
  comparison: Comparison;
  /** The candidate config set whose artifacts get written + committed. */
  candidateConfigSet: ConfigSet;
  /** The rendered markdown report, used verbatim as the PR body. */
  report: string;
  /** Optional promotion options. */
  options?: OpenPromotionPROptions;
}

/** The outcome of a promotion attempt. */
export interface PromotionResult {
  /** Whether a PR was (or, in dry-run, would have been) opened. */
  promoted: boolean;
  /** True when the attempt ran in dry-run mode (no side effects). */
  dryRun: boolean;
  /**
   * Why the promotion was skipped, when `promoted` is false because the
   * comparison did not warrant a PR. Undefined when promoted.
   */
  skippedReason?: string;
  /** The branch name that was (or would be) created. */
  branch?: string;
  /** The base branch the PR targets. */
  baseBranch?: string;
  /** The PR title. */
  title?: string;
  /** The files that were (or would be) written, relative to the repo root. */
  files: PlannedFileWrite[];
  /** The ordered git/gh steps that were (or would be) run. */
  plannedCommands: PlannedCommand[];
  /**
   * The PR URL, when a real PR was opened (live mode only) and `gh` returned
   * one on stdout. Undefined in dry-run mode.
   */
  prUrl?: string;
}

/* -------------------------------------------------------------------------- */
/*  Availability guard                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Whether the GitHub `gh` CLI is available in the current environment. Probes
 * `gh --version`; resolves false on any error (missing binary, non-zero exit).
 * Never throws — safe to call offline.
 */
export async function isGhAvailable(): Promise<boolean> {
  try {
    const result = await execa('gh', ['--version'], { reject: false });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Render a command + args into a readable, roughly shell-safe single line. */
function renderCommand(command: string, args: string[]): string {
  const quoted = args.map((a) =>
    /[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a,
  );
  return [command, ...quoted].join(' ');
}

/** Build a {@link PlannedCommand} from an executable + args. */
function planCommand(command: string, args: string[]): PlannedCommand {
  return { command, args, display: renderCommand(command, args) };
}

/**
 * Derive a filesystem/git-safe slug from arbitrary text. Lowercased, non
 * alphanumerics collapsed to single hyphens, trimmed, length-capped.
 */
export function slugify(input: string, maxLen = 40): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return slug || 'candidate';
}

/**
 * Derive a deterministic candidate branch name from the config set + an
 * optional seed, prefixed with the configured `branchPrefix`.
 */
export function deriveBranchName(
  configSet: ConfigSet,
  prefix: string,
  seed?: string,
): string {
  const base = seed
    ? slugify(seed)
    : `${configSet.agent}-${slugify(
        configSet.artifacts.map((a) => a.id).join('-') || 'config',
      )}`;
  return `${prefix}${base}`;
}

/** Default PR title derived from the comparison summary. */
function deriveTitle(comparison: Comparison, configSet: ConfigSet): string {
  const n = configSet.artifacts.length;
  const noun = `${n} ${configSet.agent} artifact${n === 1 ? '' : 's'}`;
  return `SkillCI: promote candidate (${noun})`;
}

/**
 * Validate that an artifact path is repo-relative and does not escape the repo
 * root (no absolute paths, no `..` traversal). Returns the normalized relative
 * path. Throws on a path that would write outside the repo.
 */
export function safeRelativePath(repoDir: string, artifactPath: string): string {
  if (path.isAbsolute(artifactPath)) {
    throw new Error(`artifact path must be repo-relative, got absolute: ${artifactPath}`);
  }
  const normalized = path.normalize(artifactPath);
  if (normalized.startsWith('..') || normalized.split(path.sep).includes('..')) {
    throw new Error(`artifact path escapes the repo root: ${artifactPath}`);
  }
  const abs = path.resolve(repoDir, normalized);
  const root = path.resolve(repoDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`artifact path resolves outside the repo root: ${artifactPath}`);
  }
  return normalized;
}

/* -------------------------------------------------------------------------- */
/*  Plan construction                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build the full ordered command plan + file-write plan for a promotion. Pure:
 * computes what WOULD happen without touching the filesystem or running
 * anything. Used directly in dry-run and as the script for live execution.
 */
export function buildPromotionPlan(args: {
  candidateConfigSet: ConfigSet;
  comparison: Comparison;
  prConfig: PrConfig;
  repoDir: string;
  branch: string;
  title: string;
  commitMessage: string;
}): { commands: PlannedCommand[]; files: PlannedFileWrite[] } {
  const { candidateConfigSet, prConfig, repoDir, branch, title, commitMessage } =
    args;

  const files: PlannedFileWrite[] = candidateConfigSet.artifacts.map((a) => {
    const rel = safeRelativePath(repoDir, a.path);
    return { path: rel, bytes: Buffer.byteLength(a.content, 'utf8') };
  });

  const commands: PlannedCommand[] = [];

  // 1. Create + switch to the candidate branch off the base branch.
  commands.push(planCommand('git', ['checkout', '-b', branch]));

  // 2. Stage the written artifacts (filesystem writes happen separately).
  commands.push(planCommand('git', ['add', ...files.map((f) => f.path)]));

  // 3. Commit.
  commands.push(planCommand('git', ['commit', '-m', commitMessage]));

  // 4. Push the branch.
  commands.push(planCommand('git', ['push', '-u', 'origin', branch]));

  // 5. Open the PR via gh. The report markdown is passed via --body-file in
  //    live mode; for the plan we record it as a --body-file placeholder so the
  //    long markdown body does not bloat the rendered command line.
  const ghArgs = [
    'pr',
    'create',
    '--base',
    prConfig.baseBranch,
    '--head',
    branch,
    '--title',
    title,
    '--body-file',
    '-',
  ];
  if (prConfig.draft) ghArgs.push('--draft');
  for (const reviewer of prConfig.reviewers) {
    ghArgs.push('--reviewer', reviewer);
  }
  commands.push(planCommand('gh', ghArgs));

  return { commands, files };
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Open a promotion PR for the candidate config set — gated strictly on the
 * comparison verdict.
 *
 * - If `shouldPromote(comparison)` is false, returns a SKIPPED result with the
 *   reason and performs no side effects.
 * - Otherwise builds the branch/commit/PR plan. In DRY-RUN (the default) it
 *   prints + returns the plan without touching git, gh, or the filesystem. In
 *   live mode (`options.dryRun === false`) it writes the artifacts, runs the
 *   git steps, and opens the PR via `gh` (guarded by {@link isGhAvailable}).
 */
export async function openPromotionPR(
  args: OpenPromotionPRArgs,
): Promise<PromotionResult> {
  const { comparison, candidateConfigSet, report, options = {} } = args;

  // DRY-RUN BY DEFAULT: only `dryRun === false` opts into live execution.
  const dryRun = options.dryRun !== false;
  const repoDir = options.repoDir ?? process.cwd();
  const prConfig = PrConfigSchema.parse(options.prConfig ?? {});
  const print = options.printer ?? (() => {});

  // ---- Gate: refuse to promote unless the comparison warrants it. ----------
  if (!shouldPromote(comparison)) {
    const reason = describeSkip(comparison);
    print(`SkillCI PR: SKIPPED — ${reason}`);
    return {
      promoted: false,
      dryRun,
      skippedReason: reason,
      files: [],
      plannedCommands: [],
    };
  }

  const branch =
    options.branch ?? deriveBranchName(candidateConfigSet, prConfig.branchPrefix);
  const title = options.title ?? deriveTitle(comparison, candidateConfigSet);
  const commitMessage =
    options.commitMessage ?? `${title}\n\n${comparison.summary}`;

  const { commands, files } = buildPromotionPlan({
    candidateConfigSet,
    comparison,
    prConfig,
    repoDir,
    branch,
    title,
    commitMessage,
  });

  // ---- Dry run: print the plan, mutate nothing. ----------------------------
  if (dryRun) {
    print(`SkillCI PR: DRY-RUN — would open PR "${title}" (${branch} -> ${prConfig.baseBranch})`);
    print(`SkillCI PR: would write ${files.length} file(s):`);
    for (const f of files) print(`  write ${f.path} (${f.bytes} bytes)`);
    print('SkillCI PR: would run:');
    for (const c of commands) print(`  ${c.display}`);
    return {
      promoted: true,
      dryRun: true,
      branch,
      baseBranch: prConfig.baseBranch,
      title,
      files,
      plannedCommands: commands,
    };
  }

  // ---- Live mode: require gh, then execute. --------------------------------
  if (!(await isGhAvailable())) {
    const reason = 'gh CLI is not available; cannot open a real PR';
    print(`SkillCI PR: SKIPPED — ${reason}`);
    return {
      promoted: false,
      dryRun: false,
      skippedReason: reason,
      branch,
      baseBranch: prConfig.baseBranch,
      title,
      files,
      plannedCommands: commands,
    };
  }

  // Write the candidate artifacts to disk.
  for (const artifact of candidateConfigSet.artifacts) {
    const rel = safeRelativePath(repoDir, artifact.path);
    const abs = path.resolve(repoDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, artifact.content, 'utf8');
  }

  // Run git steps (branch, add, commit, push), then gh pr create.
  let prUrl: string | undefined;
  for (const cmd of commands) {
    if (cmd.command === 'gh') {
      const result = await execa(cmd.command, cmd.args, {
        cwd: repoDir,
        input: report,
      });
      const out = (result.stdout ?? '').trim();
      const match = out.match(/https?:\/\/\S+/);
      if (match) prUrl = match[0];
    } else {
      await execa(cmd.command, cmd.args, { cwd: repoDir });
    }
  }

  print(`SkillCI PR: opened PR "${title}"${prUrl ? ` -> ${prUrl}` : ''}`);

  return {
    promoted: true,
    dryRun: false,
    branch,
    baseBranch: prConfig.baseBranch,
    title,
    files,
    plannedCommands: commands,
    prUrl,
  };
}

/** Human-readable reason a promotion was skipped, given a non-promotable comparison. */
function describeSkip(comparison: Comparison): string {
  if (comparison.verdict !== 'improved') {
    const tail =
      comparison.regressions.length > 0
        ? ` (${comparison.regressions.length} hard regression(s))`
        : '';
    return `verdict is "${comparison.verdict}", not "improved"${tail}`;
  }
  // Verdict is improved but regressions are present — defensive path.
  return `verdict is "improved" but ${comparison.regressions.length} hard regression(s) present`;
}
