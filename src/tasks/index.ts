/**
 * Public entrypoint for the SkillCI `tasks` module: loading and validating task
 * suites and their seed fixtures.
 *
 * Domain types (`Task`, `ObjectiveCheck`, `JudgeRubric`, ...) live in the shared
 * core contracts — import those from `../core/index.js`, not from here.
 */
export {
  loadTasks,
  loadTasksDetailed,
  loadTaskFile,
  getSampleTasks,
  getSampleTasksDetailed,
  fixturesRoot,
  TaskLoadError,
  TASK_FILE_NAME,
  type LoadedTask,
} from './loader.js';
