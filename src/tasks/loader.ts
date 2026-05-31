/**
 * Task + fixture loading.
 *
 * A task definition lives in a `task.json` file. The directory that contains it
 * doubles as the seed fixture repo for that task (a tiny, dependency-free repo).
 * `Task.fixtureDir` in the JSON is interpreted **relative to the directory of
 * the task file** (so `"."` means "this fixture dir"); the loader resolves it to
 * an absolute path before validation succeeds, so downstream modules (sandbox)
 * can copy it without knowing where the suite lives.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskSchema, type Task } from '../core/index.js';

/** Default name of a task definition file inside a fixture directory. */
export const TASK_FILE_NAME = 'task.json';

/** A task paired with the absolute path of the file it was loaded from. */
export interface LoadedTask {
  /** The validated task (with `fixtureDir` resolved to an absolute path). */
  task: Task;
  /** Absolute path to the `task.json` the task was parsed from. */
  sourceFile: string;
}

/** Error thrown when a task file is present but invalid. */
export class TaskLoadError extends Error {
  constructor(
    message: string,
    /** Absolute path of the offending task file. */
    readonly sourceFile: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TaskLoadError';
  }
}

/** Absolute path to the repo-root `fixtures/` directory (works under tsx & dist). */
export function fixturesRoot(): string {
  // This file is src/tasks/loader.ts (or dist/tasks/loader.js). The repo root is
  // two directories up from here.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'fixtures');
}

/**
 * Parse and validate a single task from a `task.json` file. Resolves the task's
 * `fixtureDir` to an absolute path relative to the file's own directory.
 */
export async function loadTaskFile(sourceFile: string): Promise<LoadedTask> {
  const abs = path.resolve(sourceFile);
  let rawText: string;
  try {
    rawText = await readFile(abs, 'utf8');
  } catch (cause) {
    throw new TaskLoadError(`Cannot read task file: ${abs}`, abs, { cause });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch (cause) {
    throw new TaskLoadError(`Task file is not valid JSON: ${abs}`, abs, { cause });
  }

  const parsed = TaskSchema.safeParse(json);
  if (!parsed.success) {
    throw new TaskLoadError(
      `Task file failed schema validation: ${abs}\n${parsed.error.message}`,
      abs,
      { cause: parsed.error },
    );
  }

  const taskDir = path.dirname(abs);
  const resolvedFixtureDir = path.resolve(taskDir, parsed.data.fixtureDir);
  const task: Task = { ...parsed.data, fixtureDir: resolvedFixtureDir };

  return { task, sourceFile: abs };
}

/**
 * Discover and load every task under `tasksDir`. A task is any directory that
 * directly contains a `task.json` file (the directory itself is the fixture).
 * The scan is one level deep by default, matching the `fixtures/<name>/task.json`
 * layout. Results are sorted by task id for deterministic ordering.
 *
 * Throws `TaskLoadError` if any discovered task file is invalid, and a plain
 * `Error` if `tasksDir` does not exist or no tasks are found.
 */
export async function loadTasks(tasksDir: string): Promise<Task[]> {
  const loaded = await loadTasksDetailed(tasksDir);
  return loaded.map((l) => l.task);
}

/** Like {@link loadTasks} but returns each task paired with its source file. */
export async function loadTasksDetailed(tasksDir: string): Promise<LoadedTask[]> {
  const root = path.resolve(tasksDir);

  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (cause) {
    throw new Error(`tasksDir does not exist: ${root}`, { cause });
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`tasksDir is not a directory: ${root}`);
  }

  const sourceFiles = await findTaskFiles(root);
  if (sourceFiles.length === 0) {
    throw new Error(`No ${TASK_FILE_NAME} files found under tasksDir: ${root}`);
  }

  const loaded = await Promise.all(sourceFiles.map((f) => loadTaskFile(f)));
  loaded.sort((a, b) => a.task.id.localeCompare(b.task.id));

  assertUniqueIds(loaded);
  return loaded;
}

/**
 * Find `task.json` files under `root`: a `task.json` directly inside `root`, and
 * one inside each immediate subdirectory. (Two levels is enough for the
 * `fixtures/<name>/task.json` and `<root>/task.json` conventions and keeps the
 * scan cheap and predictable.)
 */
async function findTaskFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name === TASK_FILE_NAME) {
      found.push(path.join(root, entry.name));
    }
  }

  const subdirs = entries.filter((e) => e.isDirectory());
  await Promise.all(
    subdirs.map(async (dir) => {
      const candidate = path.join(root, dir.name, TASK_FILE_NAME);
      try {
        const s = await stat(candidate);
        if (s.isFile()) found.push(candidate);
      } catch {
        // No task.json in this subdir; skip it.
      }
    }),
  );

  return found;
}

function assertUniqueIds(loaded: LoadedTask[]): void {
  const seen = new Map<string, string>();
  for (const { task, sourceFile } of loaded) {
    const prior = seen.get(task.id);
    if (prior !== undefined) {
      throw new TaskLoadError(
        `Duplicate task id "${task.id}" found in ${sourceFile} (also in ${prior})`,
        sourceFile,
      );
    }
    seen.set(task.id, sourceFile);
  }
}

/**
 * Load the committed sample fixture tasks shipped under the repo-root
 * `fixtures/` directory. These are the canonical offline demo tasks.
 */
export async function getSampleTasks(): Promise<Task[]> {
  return loadTasks(fixturesRoot());
}

/** Like {@link getSampleTasks} but with source-file detail. */
export async function getSampleTasksDetailed(): Promise<LoadedTask[]> {
  return loadTasksDetailed(fixturesRoot());
}
