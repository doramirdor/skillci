/**
 * Reporting: render a baseline-vs-candidate `Comparison` (plus the underlying
 * baseline/candidate `RunOutcome`s) into three stable, offline, side-effect-free
 * surfaces:
 *
 *   - `renderJsonReport`     — a stable, machine-readable JSON object.
 *   - `renderMarkdownReport` — a clean human report (verdict banner, per-task
 *                              delta table, explicit regressions/improvements,
 *                              scoring breakdown, run metadata).
 *   - `renderTerminalReport` — a colorized terminal summary (via picocolors).
 *
 * Everything here is pure string-building over already-computed domain objects.
 * There is NO network access, NO filesystem access, and NO API keys involved —
 * the functions are deterministic given their inputs (aside from an optional
 * caller-supplied `generatedAt` timestamp, which defaults to "now" but can be
 * pinned for reproducible output / tests).
 */

import pc from 'picocolors';
import type {
  Comparison,
  PerTaskDelta,
  RunOutcome,
  Score,
  Verdict,
} from '../core/index.js';

/* -------------------------------------------------------------------------- */
/*  Public options & report shapes                                            */
/* -------------------------------------------------------------------------- */

/** Options shared by all renderers. */
export interface ReportOptions {
  /**
   * Timestamp embedded in run metadata. Defaults to `new Date().toISOString()`.
   * Pin it for deterministic output (tests, golden files).
   */
  generatedAt?: string;
  /**
   * Optional human label for the candidate (e.g. a branch name or candidate id)
   * surfaced in the report metadata.
   */
  candidateLabel?: string;
}

/** Options specific to the terminal renderer. */
export interface TerminalReportOptions extends ReportOptions {
  /**
   * Force color on/off. When omitted, picocolors' own auto-detection is used.
   * Pass `false` for deterministic, color-free output in tests / pipes.
   */
  color?: boolean;
}

/** A single row in the JSON report's per-task table. */
export interface JsonTaskRow {
  taskId: string;
  baselineComposite: number;
  candidateComposite: number;
  compositeDelta: number;
  objectiveDelta: number;
  judgeDelta: number | null;
  costUsdDelta: number;
  isRegression: boolean;
  /** Per-row classification derived from the delta. */
  classification: TaskClassification;
}

/** Aggregate cost/efficiency totals for one side of the comparison. */
export interface CostTotals {
  tokens: number;
  toolCalls: number;
  steps: number;
  wallClockMs: number;
  costUsd: number;
}

/** The objective scoring breakdown for one side of the comparison. */
export interface ObjectiveTotals {
  passed: number;
  total: number;
  /** Pass-rate in [0,1]; a zero-check suite is treated as 1. */
  rate: number;
}

/** The full, stable JSON report object. */
export interface JsonReport {
  /** Schema version, so consumers can evolve safely. */
  schemaVersion: 1;
  generatedAt: string;
  verdict: Verdict;
  promotable: boolean;
  summary: string;
  candidateLabel?: string;
  tasks: JsonTaskRow[];
  regressions: string[];
  improvements: string[];
  totals: {
    taskCount: number;
    improved: number;
    neutral: number;
    regressed: number;
    netCompositeDelta: number;
    netCostUsdDelta: number;
    objective: { baseline: ObjectiveTotals; candidate: ObjectiveTotals };
    cost: { baseline: CostTotals; candidate: CostTotals };
  };
}

/** Per-task classification used in rendered rows. */
export type TaskClassification = 'improved' | 'neutral' | 'regressed';

/* -------------------------------------------------------------------------- */
/*  Shared helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Round to a stable number of decimals to avoid float noise in output. */
function round(n: number, decimals = 6): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Classify a per-task delta the same way the comparator does. */
function classifyDelta(d: PerTaskDelta): TaskClassification {
  if (d.isRegression) return 'regressed';
  if (d.compositeDelta > 0) return 'improved';
  return 'neutral';
}

/** A candidate is promotable ONLY when improved with zero regressions. */
function isPromotable(comparison: Comparison): boolean {
  return comparison.verdict === 'improved' && comparison.regressions.length === 0;
}

/** Format a delta with an explicit sign (e.g. `+0.12`, `-0.5`, `0`). */
function signed(n: number, decimals = 4): string {
  const r = round(n, decimals);
  if (r > 0) return `+${r}`;
  return `${r}`;
}

/** Index scores by taskId. */
function indexScores(outcome: RunOutcome): Map<string, Score> {
  const map = new Map<string, Score>();
  for (const score of outcome.scores) map.set(score.taskId, score);
  return map;
}

/** Sum the cost/efficiency telemetry across a run's scores. */
function sumCost(outcome: RunOutcome): CostTotals {
  const totals: CostTotals = {
    tokens: 0,
    toolCalls: 0,
    steps: 0,
    wallClockMs: 0,
    costUsd: 0,
  };
  for (const s of outcome.scores) {
    totals.tokens += s.cost.tokens;
    totals.toolCalls += s.cost.toolCalls;
    totals.steps += s.cost.steps;
    totals.wallClockMs += s.cost.wallClockMs;
    totals.costUsd += s.cost.costUsd;
  }
  totals.costUsd = round(totals.costUsd);
  return totals;
}

/** Sum the objective pass-rate across a run's scores. */
function sumObjective(outcome: RunOutcome): ObjectiveTotals {
  let passed = 0;
  let total = 0;
  for (const s of outcome.scores) {
    passed += s.objective.passed;
    total += s.objective.total;
  }
  return { passed, total, rate: total <= 0 ? 1 : round(passed / total) };
}

/** Count per-task classifications across the comparison. */
function countClassifications(comparison: Comparison): {
  improved: number;
  neutral: number;
  regressed: number;
} {
  let improved = 0;
  let neutral = 0;
  let regressed = 0;
  for (const d of comparison.perTaskDeltas) {
    const c = classifyDelta(d);
    if (c === 'improved') improved += 1;
    else if (c === 'regressed') regressed += 1;
    else neutral += 1;
  }
  return { improved, neutral, regressed };
}

/* -------------------------------------------------------------------------- */
/*  JSON report                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build a stable, machine-readable JSON report. The object is deterministic
 * (given a pinned `generatedAt`) with keys in a fixed shape so it can be
 * diffed / golden-tested. Returns a plain object — callers `JSON.stringify` it.
 */
export function renderJsonReport(
  comparison: Comparison,
  baseline: RunOutcome,
  candidate: RunOutcome,
  options: ReportOptions = {},
): JsonReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const tasks: JsonTaskRow[] = comparison.perTaskDeltas.map((d) => ({
    taskId: d.taskId,
    baselineComposite: round(d.baselineComposite),
    candidateComposite: round(d.candidateComposite),
    compositeDelta: round(d.compositeDelta),
    objectiveDelta: d.objectiveDelta,
    judgeDelta: d.judgeDelta === undefined ? null : round(d.judgeDelta),
    costUsdDelta: round(d.costUsdDelta),
    isRegression: d.isRegression,
    classification: classifyDelta(d),
  }));

  const counts = countClassifications(comparison);
  const baselineCost = sumCost(baseline);
  const candidateCost = sumCost(candidate);
  const netCompositeDelta = round(
    comparison.perTaskDeltas.reduce((sum, d) => sum + d.compositeDelta, 0),
  );
  const netCostUsdDelta = round(candidateCost.costUsd - baselineCost.costUsd);

  const report: JsonReport = {
    schemaVersion: 1,
    generatedAt,
    verdict: comparison.verdict,
    promotable: isPromotable(comparison),
    summary: comparison.summary,
    tasks,
    regressions: [...comparison.regressions],
    improvements: [...comparison.improvements],
    totals: {
      taskCount: comparison.perTaskDeltas.length,
      improved: counts.improved,
      neutral: counts.neutral,
      regressed: counts.regressed,
      netCompositeDelta,
      netCostUsdDelta,
      objective: {
        baseline: sumObjective(baseline),
        candidate: sumObjective(candidate),
      },
      cost: { baseline: baselineCost, candidate: candidateCost },
    },
  };
  if (options.candidateLabel !== undefined) {
    report.candidateLabel = options.candidateLabel;
  }
  return report;
}

/* -------------------------------------------------------------------------- */
/*  Markdown report                                                           */
/* -------------------------------------------------------------------------- */

const VERDICT_BADGE: Record<Verdict, string> = {
  improved: '✅ IMPROVED',
  neutral: '➖ NEUTRAL',
  regressed: '❌ REGRESSED',
};

/** Markdown table cell for a judge delta that may be absent. */
function mdJudge(delta: number | undefined): string {
  return delta === undefined ? '—' : signed(delta);
}

/**
 * Render a clean Markdown report: a verdict banner, a per-task delta table,
 * explicit regression and improvement lists, a scoring breakdown, and run
 * metadata. Suitable for a PR body, an artifact, or a console pager.
 */
export function renderMarkdownReport(
  comparison: Comparison,
  baseline: RunOutcome,
  candidate: RunOutcome,
  options: ReportOptions = {},
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const json = renderJsonReport(comparison, baseline, candidate, {
    generatedAt,
    candidateLabel: options.candidateLabel,
  });

  const lines: string[] = [];

  // ---- Verdict banner -----------------------------------------------------
  lines.push('# SkillCI Report');
  lines.push('');
  lines.push(`## Verdict: ${VERDICT_BADGE[comparison.verdict]}`);
  lines.push('');
  lines.push(`> ${comparison.summary}`);
  lines.push('');
  lines.push(
    `**Promotable:** ${json.promotable ? 'yes — eligible to open a PR' : 'no'}`,
  );
  lines.push('');

  // ---- Per-task delta table ----------------------------------------------
  lines.push('## Per-task deltas');
  lines.push('');
  if (comparison.perTaskDeltas.length === 0) {
    lines.push('_No tasks were compared._');
  } else {
    lines.push(
      '| Task | Baseline | Candidate | Δ Composite | Δ Objective | Δ Judge | Δ Cost (USD) | Result |',
    );
    lines.push(
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: |',
    );
    for (const d of comparison.perTaskDeltas) {
      const cls = classifyDelta(d);
      const marker =
        cls === 'improved' ? '⬆︎' : cls === 'regressed' ? '⬇︎ REGRESSED' : '·';
      lines.push(
        `| ${d.taskId} | ${round(d.baselineComposite, 4)} | ${round(
          d.candidateComposite,
          4,
        )} | ${signed(d.compositeDelta)} | ${signed(d.objectiveDelta, 0)} | ${mdJudge(
          d.judgeDelta,
        )} | ${signed(d.costUsdDelta)} | ${marker} |`,
      );
    }
  }
  lines.push('');

  // ---- Regressions --------------------------------------------------------
  lines.push('## Regressions');
  lines.push('');
  if (comparison.regressions.length === 0) {
    lines.push('_None._ 🎉');
  } else {
    for (const r of comparison.regressions) lines.push(`- ❌ ${r}`);
  }
  lines.push('');

  // ---- Improvements -------------------------------------------------------
  lines.push('## Improvements');
  lines.push('');
  if (comparison.improvements.length === 0) {
    lines.push('_None._');
  } else {
    for (const i of comparison.improvements) lines.push(`- ✅ ${i}`);
  }
  lines.push('');

  // ---- Scoring breakdown --------------------------------------------------
  const o = json.totals.objective;
  const c = json.totals.cost;
  lines.push('## Scoring breakdown');
  lines.push('');
  lines.push('| Dimension | Baseline | Candidate | Δ |');
  lines.push('| --- | ---: | ---: | ---: |');
  lines.push(
    `| Objective checks passed | ${o.baseline.passed}/${o.baseline.total} | ${o.candidate.passed}/${o.candidate.total} | ${signed(
      o.candidate.passed - o.baseline.passed,
      0,
    )} |`,
  );
  lines.push(
    `| Objective pass-rate | ${o.baseline.rate} | ${o.candidate.rate} | ${signed(
      o.candidate.rate - o.baseline.rate,
    )} |`,
  );
  lines.push(
    `| Net composite | — | — | ${signed(json.totals.netCompositeDelta)} |`,
  );
  lines.push(
    `| Tokens | ${c.baseline.tokens} | ${c.candidate.tokens} | ${signed(
      c.candidate.tokens - c.baseline.tokens,
      0,
    )} |`,
  );
  lines.push(
    `| Tool calls | ${c.baseline.toolCalls} | ${c.candidate.toolCalls} | ${signed(
      c.candidate.toolCalls - c.baseline.toolCalls,
      0,
    )} |`,
  );
  lines.push(
    `| Steps | ${c.baseline.steps} | ${c.candidate.steps} | ${signed(
      c.candidate.steps - c.baseline.steps,
      0,
    )} |`,
  );
  lines.push(
    `| Wall-clock (ms) | ${c.baseline.wallClockMs} | ${c.candidate.wallClockMs} | ${signed(
      c.candidate.wallClockMs - c.baseline.wallClockMs,
      0,
    )} |`,
  );
  lines.push(
    `| Cost (USD) | ${c.baseline.costUsd} | ${c.candidate.costUsd} | ${signed(
      json.totals.netCostUsdDelta,
    )} |`,
  );
  lines.push('');

  // ---- Run metadata -------------------------------------------------------
  lines.push('## Run metadata');
  lines.push('');
  lines.push(`- Generated at: ${generatedAt}`);
  if (options.candidateLabel !== undefined) {
    lines.push(`- Candidate: ${options.candidateLabel}`);
  }
  lines.push(
    `- Tasks: ${json.totals.taskCount} (${json.totals.improved} improved, ${json.totals.neutral} neutral, ${json.totals.regressed} regressed)`,
  );
  lines.push(`- Report schema version: ${json.schemaVersion}`);
  lines.push('');

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Terminal report                                                           */
/* -------------------------------------------------------------------------- */

/** The picocolors surface we rely on. */
type Colorizer = {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  gray: (s: string) => string;
};

/**
 * Resolve a colorizer. picocolors exposes `createColors(enabled?)` which lets
 * callers force color on/off deterministically. When `color` is undefined we
 * fall back to the default instance (which auto-detects TTY support).
 */
function resolveColors(color: boolean | undefined): Colorizer {
  const anyPc = pc as unknown as {
    createColors?: (enabled?: boolean) => Colorizer;
  } & Colorizer;
  if (color !== undefined && typeof anyPc.createColors === 'function') {
    return anyPc.createColors(color);
  }
  return anyPc;
}

/** Pick the banner color for a verdict. */
function verdictColor(c: Colorizer, verdict: Verdict): (s: string) => string {
  if (verdict === 'improved') return c.green;
  if (verdict === 'regressed') return c.red;
  return c.yellow;
}

/**
 * Render a compact, colorized terminal summary. Includes the verdict banner,
 * a per-task line for each task (with a regression marker), explicit
 * regression/improvement lines, and the aggregate totals. Color can be forced
 * off (`color: false`) for stable, capture-friendly output.
 */
export function renderTerminalReport(
  comparison: Comparison,
  baseline: RunOutcome,
  candidate: RunOutcome,
  options: TerminalReportOptions = {},
): string {
  const c = resolveColors(options.color);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const json = renderJsonReport(comparison, baseline, candidate, {
    generatedAt,
    candidateLabel: options.candidateLabel,
  });

  const lines: string[] = [];

  // ---- Verdict banner -----------------------------------------------------
  const paint = verdictColor(c, comparison.verdict);
  const label = comparison.verdict.toUpperCase();
  lines.push(c.bold(paint(`SkillCI — VERDICT: ${label}`)));
  lines.push(c.dim(comparison.summary));
  lines.push('');

  // ---- Per-task lines -----------------------------------------------------
  lines.push(c.bold('Tasks'));
  if (comparison.perTaskDeltas.length === 0) {
    lines.push(c.dim('  (no tasks compared)'));
  } else {
    for (const d of comparison.perTaskDeltas) {
      const cls = classifyDelta(d);
      const deltaStr = signed(d.compositeDelta);
      let line =
        `  ${d.taskId}: composite ${round(d.baselineComposite, 4)} -> ` +
        `${round(d.candidateComposite, 4)} (${deltaStr}), ` +
        `objΔ ${signed(d.objectiveDelta, 0)}, costΔ ${signed(d.costUsdDelta)}`;
      if (cls === 'regressed') {
        line = c.red(`${line}  [REGRESSED]`);
      } else if (cls === 'improved') {
        line = c.green(line);
      } else {
        line = c.dim(line);
      }
      lines.push(line);
    }
  }
  lines.push('');

  // ---- Regressions --------------------------------------------------------
  if (comparison.regressions.length > 0) {
    lines.push(c.bold(c.red('Regressions')));
    for (const r of comparison.regressions) {
      lines.push(c.red(`  - ${r}`));
    }
    lines.push('');
  } else {
    lines.push(c.green('No regressions.'));
    lines.push('');
  }

  // ---- Improvements -------------------------------------------------------
  if (comparison.improvements.length > 0) {
    lines.push(c.bold(c.green('Improvements')));
    for (const i of comparison.improvements) {
      lines.push(c.green(`  + ${i}`));
    }
    lines.push('');
  }

  // ---- Totals -------------------------------------------------------------
  const t = json.totals;
  lines.push(c.bold('Totals'));
  lines.push(
    c.dim(
      `  ${t.taskCount} task(s): ${t.improved} improved, ${t.neutral} neutral, ${t.regressed} regressed`,
    ),
  );
  lines.push(c.dim(`  net composite ${signed(t.netCompositeDelta)}`));
  lines.push(
    c.dim(
      `  objective ${t.objective.baseline.passed}/${t.objective.baseline.total} -> ` +
        `${t.objective.candidate.passed}/${t.objective.candidate.total}`,
    ),
  );
  lines.push(
    c.dim(
      `  cost $${t.cost.baseline.costUsd} -> $${t.cost.candidate.costUsd} (${signed(
        t.netCostUsdDelta,
      )})`,
    ),
  );
  lines.push(
    c.cyan(
      `  ${json.promotable ? 'PROMOTABLE — eligible to open a PR' : 'NOT promotable'}`,
    ),
  );

  return lines.join('\n');
}
