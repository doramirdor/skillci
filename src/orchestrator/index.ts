/**
 * SkillCI orchestrator — the end-to-end evaluation engine.
 *
 * `runEvaluation` ties every module together. For each task it:
 *   1. creates an isolated sandbox seeded from the task's fixture repo,
 *   2. applies the BASELINE config set, runs the agent headlessly, scores the
 *      run (objective checks + judge + cost) into a {@link Score},
 *   3. resets the sandbox and repeats with the CANDIDATE config set,
 * then aggregates baseline & candidate {@link RunOutcome}s into a
 * {@link Comparison} via the comparator, renders reports, and — when the
 * comparison warrants it — invokes the PR module (dry-run by default).
 *
 * Everything here runs fully offline when driven by the {@link MockAgentAdapter}
 * (the default), so tests and the bundled demo need no network or API keys.
 */

import type {
  AgentAdapter,
  AgentKind,
  ConfigSet,
  Comparison,
  JudgeConfig,
  RunOutcome,
  SandboxResult,
  Score,
  Task,
  Thresholds,
} from '../core/index.js';

import { applyConfigSet } from '../artifacts/index.js';
import { createSandbox, type Sandbox } from '../sandbox/index.js';
import { getAdapter, MockAgentAdapter } from '../agents/index.js';
import { getSampleTasks } from '../tasks/index.js';
import {
  computeScore,
  defaultCommandRunner,
  type CommandRunner,
  type CostReference,
  type JudgeOptions,
} from '../scoring/index.js';
import { compareOutcomes, shouldPromote } from '../compare/index.js';
import {
  renderJsonReport,
  renderMarkdownReport,
  type JsonReport,
} from '../report/index.js';
import { openPromotionPR, type PromotionResult } from '../pr/index.js';

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/** Arguments to {@link runEvaluation}. */
export interface RunEvaluationArgs {
  /** Repo root the candidate would be promoted into (used by the PR module). */
  rootDir: string;
  /** The trusted, current configuration. */
  baselineConfig: ConfigSet;
  /** The proposed configuration under test. */
  candidateConfig: ConfigSet;
  /** The task suite to run twice (baseline + candidate). */
  tasks: Task[];
  /** Which target agent these tasks exercise. */
  agentKind: AgentKind;
  /**
   * Adapter used to drive the agent. Defaults to a deterministic, offline
   * {@link MockAgentAdapter} so the whole pipeline runs without a network or
   * API key. Inject a real adapter (or the result of `getAdapter`) to drive a
   * real agent.
   */
  adapter?: AgentAdapter;
  /**
   * A second adapter to use for the candidate side. Defaults to `adapter`.
   * Primarily a demo/test hook: passing a higher-quality mock here lets a demo
   * fabricate an unambiguously-better candidate.
   */
  candidateAdapter?: AgentAdapter;
  /** Verdict thresholds. Partial input is defaulted by the comparator. */
  thresholds?: Partial<Thresholds>;
  /** LLM-as-judge settings. Judge is skipped offline / without a key. */
  judge?: Partial<JudgeConfig>;
  /** Options forwarded to the judge (e.g. an injected fake judge for tests). */
  judgeOptions?: JudgeOptions;
  /**
   * Command runner used by objective `command`/`testSuite` checks. Defaults to
   * executing inside the sandbox workdir. Injectable for fully offline tests.
   */
  commandRunner?: CommandRunner;
  /**
   * When false, a real PR is opened (live `gh`). DEFAULT TRUE (dry-run): the
   * git/gh plan is computed and returned but never executed.
   */
  dryRunPr?: boolean;
  /** Repo dir handed to the PR module. Defaults to `rootDir`. */
  prRepoDir?: string;
  /** Pinned timestamp for deterministic report metadata. */
  generatedAt?: string;
  /** Human label for the candidate surfaced in reports. */
  candidateLabel?: string;
  /** Optional sink for progress lines (defaults to no-op). */
  onProgress?: (line: string) => void;
}

/** The full result of an end-to-end evaluation. */
export interface EvaluationResult {
  /** Baseline-vs-candidate comparison + verdict. */
  comparison: Comparison;
  /** Baseline run outcome (one score per task). */
  baselineOutcome: RunOutcome;
  /** Candidate run outcome (one score per task). */
  candidateOutcome: RunOutcome;
  /** Rendered Markdown report (also used as the PR body). */
  reportMarkdown: string;
  /** Structured JSON report. */
  reportJson: JsonReport;
  /**
   * The PR module's result. When `shouldPromote` is false this still returns a
   * skipped {@link PromotionResult}. Dry-run by default.
   */
  prResult: PromotionResult;
}

/**
 * Run the full baseline-vs-candidate evaluation pipeline.
 */
export async function runEvaluation(
  args: RunEvaluationArgs,
): Promise<EvaluationResult> {
  const adapter = args.adapter ?? new MockAgentAdapter();
  const candidateAdapter = args.candidateAdapter ?? adapter;
  const runner = args.commandRunner;
  const progress = args.onProgress ?? (() => {});

  const baselineScores: Score[] = [];
  const candidateScores: Score[] = [];

  for (const task of args.tasks) {
    progress(`task ${task.id}: baseline`);
    const baselineScore = await runOneSide({
      task,
      configSet: args.baselineConfig,
      adapter,
      runner,
      judge: args.judge,
      judgeOptions: args.judgeOptions,
    });
    baselineScores.push(baselineScore);

    progress(`task ${task.id}: candidate`);
    const candidateScore = await runOneSide({
      task,
      configSet: args.candidateConfig,
      adapter: candidateAdapter,
      runner,
      judge: args.judge,
      judgeOptions: args.judgeOptions,
      // Score the candidate's cost RELATIVE to the baseline run, so a cheaper
      // candidate earns a positive composite bonus (and a pricier one a penalty).
      // The baseline itself is scored without a reference (neutral cost term).
      reference: {
        tokens: baselineScore.cost.tokens,
        costUsd: baselineScore.cost.costUsd,
        toolCalls: baselineScore.cost.toolCalls,
        steps: baselineScore.cost.steps,
        wallClockMs: baselineScore.cost.wallClockMs,
      },
    });
    candidateScores.push(candidateScore);
  }

  const baselineOutcome: RunOutcome = {
    configLabel: 'baseline',
    scores: baselineScores,
  };
  const candidateOutcome: RunOutcome = {
    configLabel: 'candidate',
    scores: candidateScores,
  };

  const comparison = compareOutcomes(
    baselineOutcome,
    candidateOutcome,
    args.thresholds ?? {},
  );

  const reportOptions = {
    generatedAt: args.generatedAt,
    candidateLabel: args.candidateLabel,
  };
  const reportMarkdown = renderMarkdownReport(
    comparison,
    baselineOutcome,
    candidateOutcome,
    reportOptions,
  );
  const reportJson = renderJsonReport(
    comparison,
    baselineOutcome,
    candidateOutcome,
    reportOptions,
  );

  // The PR module gates internally on `shouldPromote`, but we short-circuit the
  // log here for clarity. Dry-run by default — no side effects unless dryRunPr
  // is explicitly false.
  const dryRun = args.dryRunPr !== false;
  if (shouldPromote(comparison)) {
    progress(`verdict ${comparison.verdict}: promoting (dryRun=${dryRun})`);
  } else {
    progress(`verdict ${comparison.verdict}: not promoting`);
  }

  const prResult = await openPromotionPR({
    comparison,
    candidateConfigSet: args.candidateConfig,
    report: reportMarkdown,
    options: {
      dryRun,
      repoDir: args.prRepoDir ?? args.rootDir,
      printer: (line) => progress(`pr: ${line}`),
    },
  });

  return {
    comparison,
    baselineOutcome,
    candidateOutcome,
    reportMarkdown,
    reportJson,
    prResult,
  };
}

/* -------------------------------------------------------------------------- */
/*  Per-side execution                                                        */
/* -------------------------------------------------------------------------- */

interface RunOneSideArgs {
  task: Task;
  configSet: ConfigSet;
  adapter: AgentAdapter;
  runner?: CommandRunner;
  judge?: Partial<JudgeConfig>;
  judgeOptions?: JudgeOptions;
  /** Reference cost profile (typically the baseline run) for the cost term. */
  reference?: CostReference;
}

/**
 * Run a single (task, config) pair: fresh sandbox, apply config, invoke the
 * agent, score the result. The sandbox is always disposed.
 */
async function runOneSide(args: RunOneSideArgs): Promise<Score> {
  const { task, configSet, adapter } = args;

  const sandbox = await createSandbox(task.fixtureDir);
  try {
    // Apply the config set (skills/hooks/rules/instructions) into the sandbox.
    await applyConfigSet(sandbox.workdir, configSet);

    // Build a SandboxResult snapshot to hand the adapter. The adapter (mock or
    // real) only needs the workdir; checks observe the post-run filesystem.
    const preRun = await snapshotResult(sandbox);

    const runResult = await adapter.run({ sandbox: preRun, task, configSet });

    // Re-snapshot after the run so objective `fileExists`/`fileContains` and
    // the file diff reflect what the agent actually wrote.
    const postRun = await snapshotResult(sandbox);

    // Wire the sandbox's own exec as the command runner so `command`/`testSuite`
    // checks execute inside the isolated workdir — unless a runner is injected.
    const runner: CommandRunner =
      args.runner ??
      ((cmd, cwd) => sandboxRunner(sandbox, cmd, cwd));

    const judgeEnabled = args.judge?.enabled ?? true;
    const judgeOptions: JudgeOptions = {
      ...(args.judgeOptions ?? {}),
      ...(args.judge?.model ? { model: args.judge.model } : {}),
    };

    return await computeScore(task, runResult, postRun, {
      objective: { runner },
      // When the judge is disabled, pass a judgeFn that returns undefined so the
      // dimension is dropped without touching the network.
      judge: judgeEnabled ? judgeOptions : { judgeFn: async () => undefined },
      reference: args.reference,
    });
  } finally {
    await sandbox.dispose();
  }
}

/**
 * Adapt a live {@link Sandbox} into the {@link CommandRunner} shape the scoring
 * layer expects. The scoring layer passes the sandbox workdir as `cwd`, which
 * matches the sandbox's own root, so we run at the workdir root.
 */
async function sandboxRunner(
  sandbox: Sandbox,
  cmd: string,
  _cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await sandbox.exec(cmd);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Produce a {@link SandboxResult} view of the current sandbox state (workdir +
 * file diff vs the initial fixture). Used both to seed the adapter and to score
 * the post-run filesystem.
 */
async function snapshotResult(sandbox: Sandbox): Promise<SandboxResult> {
  const fileDiff = await sandbox.snapshotDiff();
  return {
    workdir: sandbox.workdir,
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    fileDiff,
  };
}

/* -------------------------------------------------------------------------- */
/*  Offline demo                                                              */
/* -------------------------------------------------------------------------- */

/** Result of {@link runDemo} — the evaluation plus the synthetic configs used. */
export interface DemoResult extends EvaluationResult {
  /** The baseline config set the demo fabricated. */
  baselineConfig: ConfigSet;
  /** The (slightly-different, better) candidate config set the demo fabricated. */
  candidateConfig: ConfigSet;
  /** The sample tasks the demo ran. */
  tasks: Task[];
}

/**
 * Run the entire SkillCI pipeline fully offline over the bundled sample tasks.
 *
 * The demo drives BOTH sides with the deterministic {@link MockAgentAdapter}
 * but gives the candidate adapter a higher `qualityBias`. To make the candidate
 * an *unambiguous* improvement (more objective checks passed AND cheaper, with
 * zero per-task regressions), both sides share byte-identical artifact content:
 * the mock keys its pseudo-random stream on `(task, config-content)`, so an
 * identical config guarantees the same stream, under which a higher bias can
 * only ever satisfy MORE checks and spend FEWER resources — never the reverse.
 * That monotonicity is exactly what lets a demo fabricate a clean "improved"
 * verdict deterministically, with no network and no API key.
 *
 * The instruction file's `meta` differs between the two sides to model a
 * candidate revision; `diffConfigSets`/scoring key on content, so this does not
 * perturb the deterministic outcome.
 */
export async function runDemo(
  rootDir: string,
  options: { generatedAt?: string; onProgress?: (line: string) => void } = {},
): Promise<DemoResult> {
  const agentKind: AgentKind = 'claude-code';
  const tasks = await getSampleTasks();

  const sharedContent =
    '# Project guidance\n\n' +
    'Write clear, working code. Verify your work before finishing.\n\n' +
    '## Quality bar\n' +
    '- Always run the provided checks and make them pass.\n' +
    '- Prefer built-in language features over new dependencies.\n' +
    '- Keep changes minimal and focused on the task.\n';

  const baselineConfig: ConfigSet = {
    agent: agentKind,
    artifacts: [
      {
        id: 'CLAUDE.md',
        agent: agentKind,
        kind: 'instruction',
        path: 'CLAUDE.md',
        content: sharedContent,
        meta: { revision: 'baseline' },
      },
    ],
  };

  const candidateConfig: ConfigSet = {
    agent: agentKind,
    artifacts: [
      {
        id: 'CLAUDE.md',
        agent: agentKind,
        kind: 'instruction',
        path: 'CLAUDE.md',
        content: sharedContent,
        meta: { revision: 'candidate' },
      },
    ],
  };

  // Baseline mock is mediocre; candidate mock is biased toward higher quality.
  // Because both configs share identical content (same RNG stream), the higher
  // bias deterministically passes more checks and spends fewer resources.
  const baselineAdapter = new MockAgentAdapter({ qualityBias: 0.35 });
  const candidateAdapter = new MockAgentAdapter({ qualityBias: 0.9 });

  const result = await runEvaluation({
    rootDir,
    baselineConfig,
    candidateConfig,
    tasks,
    agentKind,
    adapter: baselineAdapter,
    candidateAdapter,
    // Judge disabled in the offline demo: no key, no network.
    judge: { enabled: false },
    // Offline objective runner: command/testSuite checks would need real
    // toolchains; keep the demo hermetic by neutralizing them deterministically.
    commandRunner: offlineCommandRunner,
    dryRunPr: true,
    candidateLabel: 'skillci-demo-candidate',
    generatedAt: options.generatedAt,
    onProgress: options.onProgress,
  });

  return {
    ...result,
    baselineConfig,
    candidateConfig,
    tasks,
  };
}

/**
 * A deterministic, offline command runner for the demo. It cannot actually run
 * `node check.js` (no fixture toolchain guaranteed), so it reports a stable
 * exit code: success. This keeps the demo hermetic while still exercising the
 * `command`/`testSuite` check paths. The interesting baseline-vs-candidate
 * signal in the demo comes from the `fileExists`/`fileContains` checks, which
 * the mock adapter satisfies based on config-derived quality.
 */
const offlineCommandRunner: CommandRunner = async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
});

export { defaultCommandRunner, getAdapter };
