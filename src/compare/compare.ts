/**
 * Baseline-vs-candidate comparator + regression detector.
 *
 * Aggregates per-task `Score`s from a baseline and a candidate `RunOutcome`,
 * computes per-task deltas (composite, objective pass-rate, judge, cost),
 * classifies each task as improved / neutral / regressed using configurable
 * `Thresholds`, and emits the overall `Verdict`.
 *
 * HARD RULE (see contracts + README): a candidate can only be `improved` when
 * it has a net-positive aggregate composite gain AND zero hard regressions. A
 * hard regression is either:
 *   - any drop in objective pass-rate on any task (when
 *     `thresholds.objectiveDropIsRegression` is true), or
 *   - a per-task composite drop whose magnitude exceeds
 *     `thresholds.regressionCompositeDrop`.
 * If ANY hard regression exists, the overall verdict is `regressed` and every
 * regression is listed explicitly — regardless of gains elsewhere.
 */

import {
  ThresholdsSchema,
  type Comparison,
  type PerTaskDelta,
  type RunOutcome,
  type Score,
  type Thresholds,
  type Verdict,
} from '../core/index.js';

/**
 * A per-task delta enriched with the internal reasoning needed to build the
 * overall verdict. The public `PerTaskDelta` is a subset of this; we keep the
 * extra fields private to this module.
 */
interface ClassifiedDelta extends PerTaskDelta {
  /** Pass-rate (passed/total) under baseline, in [0,1]. */
  baselineObjectiveRate: number;
  /** Pass-rate (passed/total) under candidate, in [0,1]. */
  candidateObjectiveRate: number;
  /** True when the objective pass-rate dropped (candidate < baseline). */
  objectiveRateDropped: boolean;
  /** True when the composite dropped beyond the regression threshold. */
  compositeHardDrop: boolean;
  /** Human-readable reasons this task is a hard regression (may be empty). */
  regressionReasons: string[];
  /** Per-task classification used for the summary. */
  classification: 'improved' | 'neutral' | 'regressed';
}

/** Objective pass-rate (passed/total), treating a zero-check task as 1.0. */
function objectiveRate(score: Score): number {
  const { passed, total } = score.objective;
  if (total <= 0) return 1;
  return passed / total;
}

/** Round to a stable number of decimals to avoid float-noise in deltas. */
function round(n: number, decimals = 6): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Index a run's scores by taskId for stable pairing. */
function indexScores(outcome: RunOutcome): Map<string, Score> {
  const map = new Map<string, Score>();
  for (const score of outcome.scores) map.set(score.taskId, score);
  return map;
}

/**
 * Build the per-task delta + classification for a single paired task.
 * Either side may be missing (task only present in one run).
 */
function classifyTask(
  taskId: string,
  baseline: Score | undefined,
  candidate: Score | undefined,
  thresholds: Thresholds,
): ClassifiedDelta {
  const baselineComposite = round(baseline?.composite ?? 0);
  const candidateComposite = round(candidate?.composite ?? 0);
  const compositeDelta = round(candidateComposite - baselineComposite);

  const baselinePassed = baseline?.objective.passed ?? 0;
  const candidatePassed = candidate?.objective.passed ?? 0;
  const objectiveDelta = candidatePassed - baselinePassed;

  const baselineObjectiveRate = baseline ? objectiveRate(baseline) : 1;
  const candidateObjectiveRate = candidate ? objectiveRate(candidate) : 1;
  const objectiveRateDropped =
    round(candidateObjectiveRate) < round(baselineObjectiveRate);

  let judgeDelta: number | undefined;
  if (baseline?.judge && candidate?.judge) {
    judgeDelta = round(candidate.judge.score0to1 - baseline.judge.score0to1);
  }

  const baselineCost = baseline?.cost.costUsd ?? 0;
  const candidateCost = candidate?.cost.costUsd ?? 0;
  const costUsdDelta = round(candidateCost - baselineCost);

  // A composite hard drop is a *drop* (negative delta) whose magnitude exceeds
  // the configured threshold. Equality with the threshold is tolerated.
  const compositeHardDrop =
    compositeDelta < 0 && Math.abs(compositeDelta) > thresholds.regressionCompositeDrop;

  const regressionReasons: string[] = [];
  if (thresholds.objectiveDropIsRegression && objectiveRateDropped) {
    regressionReasons.push(
      `task "${taskId}": objective pass-rate dropped ` +
        `(${baselinePassed}/${baseline?.objective.total ?? 0} -> ` +
        `${candidatePassed}/${candidate?.objective.total ?? 0})`,
    );
  }
  if (compositeHardDrop) {
    regressionReasons.push(
      `task "${taskId}": composite regressed by ${Math.abs(compositeDelta)} ` +
        `(> threshold ${thresholds.regressionCompositeDrop})`,
    );
  }

  const isRegression = regressionReasons.length > 0;

  let classification: ClassifiedDelta['classification'];
  if (isRegression) {
    classification = 'regressed';
  } else if (compositeDelta > 0) {
    classification = 'improved';
  } else {
    classification = 'neutral';
  }

  return {
    taskId,
    baselineComposite,
    candidateComposite,
    compositeDelta,
    objectiveDelta,
    judgeDelta,
    costUsdDelta,
    isRegression,
    baselineObjectiveRate,
    candidateObjectiveRate,
    objectiveRateDropped,
    compositeHardDrop,
    regressionReasons,
    classification,
  };
}

/** Strip the internal fields, leaving only the public `PerTaskDelta`. */
function toPublicDelta(d: ClassifiedDelta): PerTaskDelta {
  return {
    taskId: d.taskId,
    baselineComposite: d.baselineComposite,
    candidateComposite: d.candidateComposite,
    compositeDelta: d.compositeDelta,
    objectiveDelta: d.objectiveDelta,
    judgeDelta: d.judgeDelta,
    costUsdDelta: d.costUsdDelta,
    isRegression: d.isRegression,
  };
}

/**
 * Compare a baseline `RunOutcome` against a candidate `RunOutcome` and produce
 * a `Comparison` with an overall `Verdict`.
 *
 * @param baseline   Scores produced under the trusted baseline config.
 * @param candidate  Scores produced under the proposed candidate config.
 * @param thresholds Optional verdict thresholds; partial input is parsed and
 *                   defaulted via the shared `ThresholdsSchema`.
 */
export function compareOutcomes(
  baseline: RunOutcome,
  candidate: RunOutcome,
  thresholds: Partial<Thresholds> = {},
): Comparison {
  const resolved: Thresholds = ThresholdsSchema.parse(thresholds ?? {});

  const baselineByTask = indexScores(baseline);
  const candidateByTask = indexScores(candidate);

  // Stable, deterministic task ordering: baseline order first, then any
  // candidate-only tasks in their own order.
  const taskIds: string[] = [];
  const seen = new Set<string>();
  for (const s of baseline.scores) {
    if (!seen.has(s.taskId)) {
      taskIds.push(s.taskId);
      seen.add(s.taskId);
    }
  }
  for (const s of candidate.scores) {
    if (!seen.has(s.taskId)) {
      taskIds.push(s.taskId);
      seen.add(s.taskId);
    }
  }

  const classified: ClassifiedDelta[] = taskIds.map((taskId) =>
    classifyTask(
      taskId,
      baselineByTask.get(taskId),
      candidateByTask.get(taskId),
      resolved,
    ),
  );

  const perTaskDeltas: PerTaskDelta[] = classified.map(toPublicDelta);

  const regressions: string[] = [];
  for (const d of classified) regressions.push(...d.regressionReasons);

  const improvements: string[] = [];
  for (const d of classified) {
    if (d.classification === 'improved') {
      improvements.push(
        `task "${d.taskId}": composite improved by ${d.compositeDelta} ` +
          `(${d.baselineComposite} -> ${d.candidateComposite})`,
      );
    }
  }

  const netCompositeGain = round(
    classified.reduce((sum, d) => sum + d.compositeDelta, 0),
  );

  const hasHardRegression = regressions.length > 0;

  // Verdict logic — the HARD RULE dominates everything else.
  let verdict: Verdict;
  if (hasHardRegression) {
    verdict = 'regressed';
  } else if (netCompositeGain >= resolved.minCompositeGain) {
    verdict = 'improved';
  } else if (netCompositeGain <= -resolved.minCompositeGain) {
    // Net negative beyond the (symmetric) meaningful-change band, but no single
    // task crossed a hard threshold — still a regression overall.
    verdict = 'regressed';
    regressions.push(
      `aggregate composite regressed by ${Math.abs(netCompositeGain)} ` +
        `(net gain ${netCompositeGain} <= -minCompositeGain ` +
        `${resolved.minCompositeGain})`,
    );
  } else {
    verdict = 'neutral';
  }

  const summary = buildSummary(verdict, netCompositeGain, classified, regressions);

  return {
    verdict,
    perTaskDeltas,
    regressions,
    improvements,
    summary,
  };
}

/** Build the short human-readable summary line. */
function buildSummary(
  verdict: Verdict,
  netCompositeGain: number,
  classified: ClassifiedDelta[],
  regressions: string[],
): string {
  const improvedCount = classified.filter((d) => d.classification === 'improved').length;
  const neutralCount = classified.filter((d) => d.classification === 'neutral').length;
  const regressedCount = classified.filter((d) => d.classification === 'regressed').length;
  const total = classified.length;

  const head =
    verdict === 'improved'
      ? 'IMPROVED'
      : verdict === 'regressed'
        ? 'REGRESSED'
        : 'NEUTRAL';

  const sign = netCompositeGain > 0 ? '+' : '';
  const base =
    `${head}: ${total} task(s) — ${improvedCount} improved, ` +
    `${neutralCount} neutral, ${regressedCount} regressed; ` +
    `net composite ${sign}${netCompositeGain}.`;

  if (verdict === 'regressed' && regressions.length > 0) {
    return `${base} ${regressions.length} hard regression(s).`;
  }
  return base;
}

/**
 * Whether a comparison warrants opening a PR. A candidate is promotable ONLY
 * when the verdict is `improved` AND there are zero hard regressions. The two
 * are coupled by construction in `compareOutcomes`, but we check both
 * defensively so a hand-built `Comparison` can never slip a regression through.
 */
export function shouldPromote(comparison: Comparison): boolean {
  return comparison.verdict === 'improved' && comparison.regressions.length === 0;
}
