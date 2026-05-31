/**
 * Objective checks — the deterministic, highest-trust dimension of scoring.
 *
 * Each {@link ObjectiveCheck} in a task is executed against the sandbox after
 * the agent run. Command/testSuite checks shell out (via execa) inside the
 * sandbox workdir; file checks read the filesystem directly. Everything is
 * fully offline — no network is touched.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

import type {
  ObjectiveCheck,
  ObjectiveCheckDetail,
  ObjectiveScore,
  SandboxResult,
  Task,
} from '../core/index.js';

/**
 * A function that runs a shell command in a directory and reports the exit
 * code. Injectable so tests can run fully offline without spawning processes.
 */
export interface CommandRunner {
  (cmd: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** Default runner: executes the command in a shell inside `cwd` via execa. */
export const defaultCommandRunner: CommandRunner = async (cmd, cwd) => {
  try {
    const result = await execa(cmd, {
      cwd,
      shell: true,
      reject: false,
      all: false,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (err) {
    // execa with reject:false should not throw, but guard regardless so a
    // single misbehaving check never crashes the whole scoring pass.
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 1, stdout: '', stderr: message };
  }
};

/** Options for {@link runObjectiveChecks}. */
export interface RunObjectiveChecksOptions {
  /** Override the command runner (used by tests to stay offline). */
  runner?: CommandRunner;
}

/**
 * Execute every {@link ObjectiveCheck} declared by `task` against `sandbox`,
 * returning the per-check detail plus pass/total counts.
 *
 * A task with zero checks yields `{ passed: 0, total: 0, details: [] }`, which
 * the composite formula treats as a neutral (full-credit) objective dimension.
 */
export async function runObjectiveChecks(
  sandbox: SandboxResult,
  task: Task,
  options: RunObjectiveChecksOptions = {},
): Promise<ObjectiveScore> {
  const runner = options.runner ?? defaultCommandRunner;
  const details: ObjectiveCheckDetail[] = [];

  for (const check of task.checks) {
    details.push(await evaluateCheck(check, sandbox, runner));
  }

  const passed = details.filter((d) => d.passed).length;
  return { passed, total: details.length, details };
}

async function evaluateCheck(
  check: ObjectiveCheck,
  sandbox: SandboxResult,
  runner: CommandRunner,
): Promise<ObjectiveCheckDetail> {
  switch (check.kind) {
    case 'command': {
      const { exitCode, stderr } = await runner(check.cmd, sandbox.workdir);
      const passed = check.expectExitZero ? exitCode === 0 : exitCode !== 0;
      const expectation = check.expectExitZero ? 'exit 0' : 'non-zero exit';
      return {
        check,
        passed,
        message: passed
          ? `command exited ${exitCode} (expected ${expectation})`
          : `command exited ${exitCode} (expected ${expectation})${stderr ? `: ${truncate(stderr)}` : ''}`,
      };
    }
    case 'testSuite': {
      const { exitCode, stderr } = await runner(check.cmd, sandbox.workdir);
      const passed = exitCode === 0;
      return {
        check,
        passed,
        message: passed
          ? `test suite passed (exit 0)`
          : `test suite failed (exit ${exitCode})${stderr ? `: ${truncate(stderr)}` : ''}`,
      };
    }
    case 'fileExists': {
      const abs = path.resolve(sandbox.workdir, check.path);
      const exists = await pathExists(abs);
      return {
        check,
        passed: exists,
        message: exists ? `file exists: ${check.path}` : `file missing: ${check.path}`,
      };
    }
    case 'fileContains': {
      const abs = path.resolve(sandbox.workdir, check.path);
      const content = await readFileSafe(abs);
      if (content === undefined) {
        return { check, passed: false, message: `file missing: ${check.path}` };
      }
      const found = content.includes(check.substring);
      return {
        check,
        passed: found,
        message: found
          ? `file ${check.path} contains expected substring`
          : `file ${check.path} does not contain expected substring`,
      };
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readFileSafe(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

function truncate(s: string, max = 200): string {
  const trimmed = s.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
