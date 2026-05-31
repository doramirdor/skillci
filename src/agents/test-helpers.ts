/**
 * Shared test fixtures/helpers for the agents module tests. Not part of the
 * public module surface (not re-exported from index.ts).
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentRunArgs,
  ConfigSet,
  ObjectiveCheck,
  SandboxResult,
  Task,
} from '../core/index.js';

/** Create an isolated temp workdir and return its absolute path. */
export async function makeWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'skillci-agents-test-'));
}

/** Build a minimal valid Task. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Add a greeting file',
    agent: 'claude-code',
    fixtureDir: '/tmp/fixture',
    prompt: 'Create src/greet.ts exporting greet().',
    checks: [],
    timeoutMs: 120_000,
    ...overrides,
  };
}

/** Build a ConfigSet from raw artifact content blobs. */
export function makeConfigSet(
  agent: ConfigSet['agent'],
  contents: string[],
): ConfigSet {
  return {
    agent,
    artifacts: contents.map((content, i) => ({
      id: `artifact-${i}`,
      agent,
      kind: 'instruction',
      path: `CONFIG_${i}.md`,
      content,
      meta: {},
    })),
  };
}

/** Build a SandboxResult pointing at `workdir`. */
export function makeSandbox(workdir: string): SandboxResult {
  return {
    workdir,
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    fileDiff: [],
  };
}

/** Assemble AgentRunArgs. */
export function makeRunArgs(
  workdir: string,
  task: Task,
  configSet: ConfigSet,
): AgentRunArgs {
  return { sandbox: makeSandbox(workdir), task, configSet };
}

/** Common objective checks used across tests. */
export function fileExists(path: string): ObjectiveCheck {
  return { kind: 'fileExists', path };
}

export function fileContains(path: string, substring: string): ObjectiveCheck {
  return { kind: 'fileContains', path, substring };
}

export function commandCheck(cmd: string): ObjectiveCheck {
  return { kind: 'command', cmd, expectExitZero: true };
}
