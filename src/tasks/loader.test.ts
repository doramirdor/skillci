import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { TaskSchema } from '../core/index.js';
import {
  loadTasks,
  loadTasksDetailed,
  loadTaskFile,
  getSampleTasks,
  getSampleTasksDetailed,
  fixturesRoot,
  TaskLoadError,
  TASK_FILE_NAME,
} from './index.js';

const SAMPLE_IDS = ['add-input-validation', 'fix-readme-typo', 'implement-util-fn'] as const;

describe('sample fixtures', () => {
  it('loads exactly the committed sample tasks, sorted by id', async () => {
    const tasks = await getSampleTasks();
    expect(tasks.map((t) => t.id)).toEqual([...SAMPLE_IDS]);
  });

  it('every sample task validates against TaskSchema', async () => {
    const tasks = await getSampleTasks();
    for (const t of tasks) {
      // Re-validating the loaded object (with absolute fixtureDir) must pass.
      expect(() => TaskSchema.parse(t)).not.toThrow();
    }
  });

  it('resolves fixtureDir to an existing absolute directory', async () => {
    const tasks = await getSampleTasks();
    for (const t of tasks) {
      expect(path.isAbsolute(t.fixtureDir)).toBe(true);
      expect(existsSync(t.fixtureDir)).toBe(true);
    }
  });

  it('points fixturesRoot at the repo-root fixtures directory', () => {
    const root = fixturesRoot();
    expect(path.basename(root)).toBe('fixtures');
    expect(existsSync(root)).toBe(true);
  });

  it('exposes source files for each sample task', async () => {
    const detailed = await getSampleTasksDetailed();
    expect(detailed).toHaveLength(SAMPLE_IDS.length);
    for (const d of detailed) {
      expect(path.basename(d.sourceFile)).toBe(TASK_FILE_NAME);
      expect(existsSync(d.sourceFile)).toBe(true);
    }
  });

  it('add-input-validation carries the expected checks and rubric', async () => {
    const detailed = await getSampleTasksDetailed();
    const t = detailed.find((d) => d.task.id === 'add-input-validation')?.task;
    expect(t).toBeDefined();
    const kinds = t!.checks.map((c) => c.kind).sort();
    expect(kinds).toContain('testSuite');
    expect(kinds).toContain('fileExists');
    expect(t!.judgeRubric?.weight).toBeCloseTo(0.3);
  });

  it('fix-readme-typo uses fileContains checks and no judge rubric', async () => {
    const detailed = await getSampleTasksDetailed();
    const t = detailed.find((d) => d.task.id === 'fix-readme-typo')?.task;
    expect(t).toBeDefined();
    expect(t!.checks.some((c) => c.kind === 'fileContains')).toBe(true);
    expect(t!.judgeRubric).toBeUndefined();
  });

  it('implement-util-fn uses a command check', async () => {
    const detailed = await getSampleTasksDetailed();
    const t = detailed.find((d) => d.task.id === 'implement-util-fn')?.task;
    expect(t).toBeDefined();
    const cmd = t!.checks.find((c) => c.kind === 'command');
    expect(cmd).toBeDefined();
    expect(cmd && cmd.kind === 'command' && cmd.cmd).toBe('node check.js');
  });
});

describe('loadTasks with a temp suite', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'skillci-tasks-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeTask(subdir: string, body: unknown): Promise<string> {
    const taskDir = path.join(dir, subdir);
    await mkdir(taskDir, { recursive: true });
    const file = path.join(taskDir, TASK_FILE_NAME);
    await writeFile(file, JSON.stringify(body), 'utf8');
    return file;
  }

  const baseTask = (over: Record<string, unknown> = {}) => ({
    id: 'temp-task',
    title: 'Temp task',
    agent: 'claude-code',
    fixtureDir: '.',
    prompt: 'do the thing',
    ...over,
  });

  it('discovers a task in an immediate subdirectory and applies defaults', async () => {
    await writeTask('alpha', baseTask({ id: 'alpha' }));
    const tasks = await loadTasks(dir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('alpha');
    expect(tasks[0]!.timeoutMs).toBe(120_000);
    expect(tasks[0]!.checks).toEqual([]);
  });

  it('discovers a task.json placed directly in the root', async () => {
    const file = path.join(dir, TASK_FILE_NAME);
    await writeFile(file, JSON.stringify(baseTask({ id: 'root-task' })), 'utf8');
    const tasks = await loadTasks(dir);
    expect(tasks.map((t) => t.id)).toEqual(['root-task']);
  });

  it('resolves fixtureDir relative to the task file directory', async () => {
    const file = await writeTask('beta', baseTask({ id: 'beta', fixtureDir: '.' }));
    const { task } = await loadTaskFile(file);
    expect(task.fixtureDir).toBe(path.dirname(file));
  });

  it('returns tasks sorted by id', async () => {
    await writeTask('z', baseTask({ id: 'zeta' }));
    await writeTask('a', baseTask({ id: 'alpha' }));
    await writeTask('m', baseTask({ id: 'mu' }));
    const tasks = await loadTasks(dir);
    expect(tasks.map((t) => t.id)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('throws TaskLoadError on invalid JSON', async () => {
    const taskDir = path.join(dir, 'bad');
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, TASK_FILE_NAME), '{ not json', 'utf8');
    await expect(loadTasks(dir)).rejects.toBeInstanceOf(TaskLoadError);
  });

  it('throws TaskLoadError on schema-invalid task (missing prompt)', async () => {
    const file = await writeTask('nope', { id: 'x', title: 't', agent: 'cursor', fixtureDir: '.' });
    await expect(loadTaskFile(file)).rejects.toBeInstanceOf(TaskLoadError);
  });

  it('throws TaskLoadError on duplicate ids', async () => {
    await writeTask('one', baseTask({ id: 'dup' }));
    await writeTask('two', baseTask({ id: 'dup' }));
    await expect(loadTasks(dir)).rejects.toBeInstanceOf(TaskLoadError);
  });

  it('throws a plain Error when no task files are found', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'skillci-empty-'));
    try {
      await expect(loadTasks(empty)).rejects.toThrow(/No task\.json/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('throws when tasksDir does not exist', async () => {
    await expect(loadTasks(path.join(dir, 'does-not-exist'))).rejects.toThrow(
      /does not exist/,
    );
  });

  it('loadTasksDetailed returns absolute source files', async () => {
    await writeTask('alpha', baseTask({ id: 'alpha' }));
    const detailed = await loadTasksDetailed(dir);
    expect(detailed).toHaveLength(1);
    expect(path.isAbsolute(detailed[0]!.sourceFile)).toBe(true);
  });
});
