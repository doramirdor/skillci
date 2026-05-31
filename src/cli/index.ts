#!/usr/bin/env node
/**
 * `skillci` — the SkillCI command-line interface.
 *
 * Subcommands:
 *   - `run`          run a baseline-vs-candidate evaluation (or the offline demo)
 *                    and print the terminal report. Exits non-zero only when the
 *                    verdict is `regressed`, so it works as a CI gate.
 *   - `validate`     discover & validate an agent's config artifacts in a dir.
 *   - `tasks`        list the available sample (or loaded) tasks.
 *
 * The CLI is thin: it parses flags, resolves a {@link ConfigSet} for each side
 * (discovering on disk, or fabricating via the demo), and delegates the heavy
 * lifting to the orchestrator + the feature modules. Fully offline by default
 * via the deterministic MockAgentAdapter.
 */

import { Command } from 'commander';
import pc from 'picocolors';

import {
  AgentKindSchema,
  type AgentKind,
  type ConfigSet,
} from '../core/index.js';
import { discoverConfigSet, diffConfigSets } from '../artifacts/index.js';
import { getAdapter } from '../agents/index.js';
import { loadTasks, getSampleTasks } from '../tasks/index.js';
import { renderTerminalReport } from '../report/index.js';
import { runDemo, runEvaluation } from '../orchestrator/index.js';

/* -------------------------------------------------------------------------- */
/*  Program assembly                                                          */
/* -------------------------------------------------------------------------- */

/** Build the commander program. Exported so tests can drive it in-process. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('skillci')
    .description(
      'CI/CD for coding-agent config: test, validate, and promote agent artifacts.',
    )
    .version('0.1.0');

  registerRun(program);
  registerValidate(program);
  registerTasks(program);

  return program;
}

/* -------------------------------------------------------------------------- */
/*  `run`                                                                     */
/* -------------------------------------------------------------------------- */

interface RunFlags {
  agent: string;
  baseline?: string;
  candidate?: string;
  tasks?: string;
  openPr?: boolean;
  demo?: boolean;
  color?: boolean;
}

function registerRun(program: Command): void {
  program
    .command('run')
    .description(
      'Run a baseline-vs-candidate evaluation (or the offline demo) and print the report.',
    )
    .option(
      '--agent <kind>',
      'target agent: claude-code | cursor | codex',
      'claude-code',
    )
    .option('--baseline <dir>', 'directory holding the baseline (trusted) config')
    .option('--candidate <dir>', 'directory holding the candidate (proposed) config')
    .option('--tasks <dir>', 'directory of task definitions (defaults to sample tasks)')
    .option('--open-pr', 'open a real PR when promotable (default: dry-run)', false)
    .option('--demo', 'run the fully-offline demo over the sample tasks', false)
    .option('--no-color', 'disable colorized output')
    .action(async (flags: RunFlags) => {
      const verdict = await runCommand(flags);
      // CI gate: non-zero ONLY when the candidate regressed.
      process.exitCode = verdict === 'regressed' ? 1 : 0;
    });
}

/**
 * Execute the `run` subcommand. Returns the verdict so the caller (and tests)
 * can map it to an exit code without re-parsing stdout.
 */
export async function runCommand(
  flags: RunFlags,
  out: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<'improved' | 'neutral' | 'regressed'> {
  const useColor = flags.color !== false;

  // Demo mode: explicit --demo, or when either config dir is missing.
  const demo = flags.demo === true || !flags.baseline || !flags.candidate;

  if (demo) {
    out(pc.dim('Running SkillCI offline demo (MockAgentAdapter, no network)...'));
    const result = await runDemo(process.cwd());
    out(
      renderTerminalReport(
        result.comparison,
        result.baselineOutcome,
        result.candidateOutcome,
        { color: useColor, candidateLabel: 'skillci-demo-candidate' },
      ),
    );
    out(prSummary(result.prResult.promoted, result.prResult.dryRun, useColor));
    return result.comparison.verdict;
  }

  const agent = parseAgent(flags.agent);
  const baselineConfig = await discoverConfigSet(flags.baseline!, agent);
  const candidateConfig = await discoverConfigSet(flags.candidate!, agent);

  const tasks = flags.tasks ? await loadTasks(flags.tasks) : await getSampleTasks();
  if (tasks.length === 0) {
    out(pc.yellow('No tasks found — nothing to evaluate.'));
    return 'neutral';
  }

  // Resolve a real adapter for the agent if available; otherwise fall back to
  // the deterministic offline mock so the pipeline always completes.
  const realAdapter = getAdapter(agent);
  const available = await realAdapter.isAvailable();
  const adapter = available ? realAdapter : getAdapter(agent, { mock: true });
  if (!available) {
    out(
      pc.yellow(
        `Agent '${agent}' is not available in this environment — using the offline MockAgentAdapter.`,
      ),
    );
  }

  const result = await runEvaluation({
    rootDir: process.cwd(),
    baselineConfig,
    candidateConfig,
    tasks,
    agentKind: agent,
    adapter,
    dryRunPr: flags.openPr !== true,
  });

  out(
    renderTerminalReport(
      result.comparison,
      result.baselineOutcome,
      result.candidateOutcome,
      { color: useColor },
    ),
  );
  out(prSummary(result.prResult.promoted, result.prResult.dryRun, useColor));

  return result.comparison.verdict;
}

function prSummary(promoted: boolean, dryRun: boolean, color: boolean): string {
  const tint = (s: string) => (color ? pc.dim(s) : s);
  if (!promoted) return tint('PR: not promotable (no PR opened).');
  if (dryRun) return tint('PR: promotable — dry-run plan computed (no PR opened). Pass --open-pr to open one.');
  return tint('PR: promotable — PR opened.');
}

/* -------------------------------------------------------------------------- */
/*  `validate <dir>`                                                          */
/* -------------------------------------------------------------------------- */

interface ValidateFlags {
  agent: string;
  baseline?: string;
  color?: boolean;
}

function registerValidate(program: Command): void {
  program
    .command('validate')
    .description('Discover and validate config artifacts for an agent in a directory.')
    .argument('<dir>', 'directory to scan for config artifacts')
    .option('--agent <kind>', 'target agent: claude-code | cursor | codex', 'claude-code')
    .option(
      '--baseline <dir>',
      'optional baseline dir to diff against (reports added/removed/modified)',
    )
    .option('--no-color', 'disable colorized output')
    .action(async (dir: string, flags: ValidateFlags) => {
      await validateCommand(dir, flags);
    });
}

/** Execute the `validate` subcommand. Exported for tests. */
export async function validateCommand(
  dir: string,
  flags: ValidateFlags,
  out: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<ConfigSet> {
  const color = flags.color !== false;
  const tint = (fn: (s: string) => string, s: string) => (color ? fn(s) : s);

  const agent = parseAgent(flags.agent);
  const configSet = await discoverConfigSet(dir, agent);

  out(tint(pc.bold, `Config for agent '${agent}' in ${dir}`));
  if (configSet.artifacts.length === 0) {
    out(tint(pc.yellow, '  (no artifacts discovered)'));
  } else {
    out(`  ${configSet.artifacts.length} artifact(s):`);
    const byKind = countByKind(configSet);
    for (const [kind, count] of byKind) {
      out(`    ${tint(pc.cyan, kind)}: ${count}`);
    }
    for (const a of [...configSet.artifacts].sort((x, y) => x.path.localeCompare(y.path))) {
      out(`    ${tint(pc.dim, a.kind.padEnd(14))} ${a.path}`);
    }
  }

  if (flags.baseline) {
    const baseline = await discoverConfigSet(flags.baseline, agent);
    const diff = diffConfigSets(baseline, configSet);
    out('');
    out(tint(pc.bold, `Diff vs baseline (${flags.baseline}):`));
    if (diff.unchanged) {
      out(tint(pc.dim, '  (no changes)'));
    } else {
      for (const e of diff.entries) {
        const mark =
          e.status === 'added' ? '+' : e.status === 'removed' ? '-' : '~';
        const colorFn =
          e.status === 'added'
            ? pc.green
            : e.status === 'removed'
              ? pc.red
              : pc.yellow;
        out(`  ${tint(colorFn, mark)} ${e.path} ${tint(pc.dim, `(${e.kind})`)}`);
      }
    }
  }

  return configSet;
}

function countByKind(configSet: ConfigSet): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const a of configSet.artifacts) {
    counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/* -------------------------------------------------------------------------- */
/*  `tasks`                                                                   */
/* -------------------------------------------------------------------------- */

interface TasksFlags {
  tasks?: string;
  color?: boolean;
}

function registerTasks(program: Command): void {
  program
    .command('tasks')
    .description('List available task definitions (sample tasks by default).')
    .option('--tasks <dir>', 'directory of task definitions (defaults to sample tasks)')
    .option('--no-color', 'disable colorized output')
    .action(async (flags: TasksFlags) => {
      await tasksCommand(flags);
    });
}

/** Execute the `tasks` subcommand. Exported for tests. */
export async function tasksCommand(
  flags: TasksFlags,
  out: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<number> {
  const color = flags.color !== false;
  const tint = (fn: (s: string) => string, s: string) => (color ? fn(s) : s);

  const tasks = flags.tasks ? await loadTasks(flags.tasks) : await getSampleTasks();
  const source = flags.tasks ?? '(bundled sample tasks)';

  out(tint(pc.bold, `${tasks.length} task(s) from ${source}:`));
  for (const t of tasks) {
    const checks = `${t.checks.length} check(s)`;
    const judge = t.judgeRubric ? ', judged' : '';
    out(
      `  ${tint(pc.cyan, t.id)}  ${tint(pc.dim, `[${t.agent}]`)}  ${t.title} ` +
        tint(pc.dim, `(${checks}${judge})`),
    );
  }
  return tasks.length;
}

/* -------------------------------------------------------------------------- */
/*  Shared helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Parse + validate an `--agent` flag into an {@link AgentKind}. */
export function parseAgent(value: string): AgentKind {
  const parsed = AgentKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid --agent '${value}' (expected one of: claude-code, cursor, codex)`,
    );
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/*  Entrypoint                                                                */
/* -------------------------------------------------------------------------- */

/**
 * True when this module is being run directly (as the CLI binary) rather than
 * imported (by tests). Compares the resolved entry script to this module's URL.
 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === new URL(`file://${entry}`).href || import.meta.url.endsWith(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${pc.red('skillci error:')} ${message}\n`);
      process.exitCode = 2;
    });
}
