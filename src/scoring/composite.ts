/**
 * Composite scoring — fold the three dimensions into a single comparable number.
 *
 * # Composite formula
 *
 * The composite lives in `[0, 1]` (a small cost bonus/penalty can nudge it
 * slightly outside, then it is clamped). Higher is better. Objective checks are
 * weighted highest, the LLM judge second, and cost/efficiency acts as a small
 * normalized bonus/penalty rather than a primary driver.
 *
 *   objective01 = passed / total            (1 when there are no checks)
 *   judge01     = judge.score0to1           (omitted dimension => reweighted)
 *
 *   base = (W_OBJ * objective01 + W_JUDGE * judge01) / (W_OBJ + W_JUDGE_eff)
 *
 *   where W_JUDGE_eff is 0 when there is no judge score, so objective alone
 *   determines `base` (we never punish a task for lacking a rubric).
 *
 *   costAdj ∈ [-COST_WEIGHT, +COST_WEIGHT]  — a normalized efficiency nudge.
 *
 *   composite = clamp01(base + costAdj)
 *
 * The cost adjustment is computed relative to a reference cost when one is
 * supplied (baseline-vs-candidate); cheaper/faster than reference => small
 * bonus, more expensive => small penalty. With no reference the adjustment is
 * 0, so a standalone score is driven entirely by quality.
 */
import type {
  AgentRunResult,
  CostScore,
  JudgeScore,
  ObjectiveScore,
  Score,
  Task,
} from '../core/index.js';

import { costMetrics } from './cost.js';
import { runObjectiveChecks, type RunObjectiveChecksOptions } from './objective.js';
import { judgeWithLLM, type JudgeOptions } from './judge.js';

/** Weight of the objective dimension (highest). */
export const W_OBJ = 0.6;
/** Weight of the LLM-judge dimension. */
export const W_JUDGE = 0.4;
/** Maximum magnitude of the cost bonus/penalty applied to the composite. */
export const COST_WEIGHT = 0.1;

/** A reference cost profile used to normalize the cost adjustment. */
export interface CostReference {
  /** Reference total tokens (e.g. the baseline run's tokens). */
  tokens?: number;
  /** Reference USD cost. */
  costUsd?: number;
  /** Reference tool-call count. */
  toolCalls?: number;
  /** Reference step count. */
  steps?: number;
  /** Reference wall-clock duration in ms. */
  wallClockMs?: number;
}

/**
 * Objective ratio in [0, 1]. A task with no checks scores a full 1 — absence of
 * objective checks must never drag the composite down.
 */
export function objectiveRatio(objective: ObjectiveScore): number {
  if (objective.total <= 0) return 1;
  return objective.passed / objective.total;
}

/**
 * The cost adjustment in `[-COST_WEIGHT, +COST_WEIGHT]`.
 *
 * Without a reference, returns 0. With a reference, compares the run's cost
 * against it across available signals (cost USD preferred, then tokens, then
 * tool calls + steps) and maps the relative delta through a bounded function:
 * cheaper than reference => positive (bonus), more expensive => negative.
 */
export function costAdjustment(cost: CostScore, reference?: CostReference): number {
  if (!reference) return 0;

  const ratios: number[] = [];
  pushRatio(ratios, reference.costUsd, cost.costUsd);
  pushRatio(ratios, reference.tokens, cost.tokens);
  pushRatio(ratios, reference.toolCalls, cost.toolCalls);
  pushRatio(ratios, reference.steps, cost.steps);
  pushRatio(ratios, reference.wallClockMs, cost.wallClockMs);

  if (ratios.length === 0) return 0;

  // Average relative cost: 1.0 == same as reference, <1 cheaper, >1 pricier.
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  // savings>0 when cheaper. Bound to [-1, 1] then scale by COST_WEIGHT.
  const savings = clamp(1 - avg, -1, 1);
  return savings * COST_WEIGHT;
}

function pushRatio(out: number[], ref: number | undefined, actual: number): void {
  if (ref === undefined) return;
  if (ref <= 0) {
    // Reference used nothing; only penalize if the run used something.
    out.push(actual > 0 ? 2 : 1);
    return;
  }
  out.push(actual / ref);
}

/** Inputs to {@link composite}. */
export interface CompositeInputs {
  objective: ObjectiveScore;
  judge?: JudgeScore;
  cost: CostScore;
  reference?: CostReference;
}

/** Combine the three dimensions into the single composite number in [0, 1]. */
export function composite(inputs: CompositeInputs): number {
  const obj01 = objectiveRatio(inputs.objective);
  const judgeWeight = inputs.judge ? W_JUDGE : 0;
  const judge01 = inputs.judge ? clamp(inputs.judge.score0to1, 0, 1) : 0;

  const denom = W_OBJ + judgeWeight;
  const base = denom > 0 ? (W_OBJ * obj01 + judgeWeight * judge01) / denom : obj01;

  const adj = costAdjustment(inputs.cost, inputs.reference);
  return clamp(base + adj, 0, 1);
}

/** Options for {@link computeScore}. */
export interface ComputeScoreOptions {
  /** Options forwarded to objective-check execution (e.g. a fake runner). */
  objective?: RunObjectiveChecksOptions;
  /** Options forwarded to the LLM judge (e.g. an injected fake judge). */
  judge?: JudgeOptions;
  /** Reference cost profile used to normalize the cost adjustment. */
  reference?: CostReference;
}

/**
 * Compute the full {@link Score} for one task under one configuration: run the
 * objective checks, judge the run (best-effort), project cost telemetry, and
 * fold everything into the composite.
 */
export async function computeScore(
  task: Task,
  runResult: AgentRunResult,
  sandbox: import('../core/index.js').SandboxResult,
  options: ComputeScoreOptions = {},
): Promise<Score> {
  const objective = await runObjectiveChecks(sandbox, task, options.objective);
  const judge = await judgeWithLLM(task, runResult, sandbox, options.judge);
  const cost = costMetrics(runResult);
  const compositeValue = composite({ objective, judge, cost, reference: options.reference });

  return {
    taskId: task.id,
    objective,
    judge,
    cost,
    composite: compositeValue,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
