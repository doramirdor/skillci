/**
 * SkillCI scoring engine — produces a {@link Score} per task per configuration.
 *
 * Public surface:
 * - {@link runObjectiveChecks} — execute objective checks against a sandbox.
 * - {@link judgeWithLLM}        — optional LLM-as-judge (prompt-cached, skippable).
 * - {@link costMetrics}         — project agent telemetry into the cost dimension.
 * - {@link computeScore}        — combine all three into a {@link Score}.
 * - {@link composite}/{@link costAdjustment}/{@link objectiveRatio} — formula pieces.
 */
export {
  runObjectiveChecks,
  defaultCommandRunner,
  type CommandRunner,
  type RunObjectiveChecksOptions,
} from './objective.js';

export {
  judgeWithLLM,
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  parseJudgeResponse,
  DEFAULT_JUDGE_MODEL,
  type JudgeFn,
  type JudgeOptions,
} from './judge.js';

export { costMetrics } from './cost.js';

export {
  computeScore,
  composite,
  costAdjustment,
  objectiveRatio,
  W_OBJ,
  W_JUDGE,
  COST_WEIGHT,
  type CostReference,
  type CompositeInputs,
  type ComputeScoreOptions,
} from './composite.js';
