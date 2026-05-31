/**
 * SkillCI — canonical shared type contracts.
 *
 * This file is THE single source of truth for the domain model. Every module in
 * the system (artifacts, sandbox, agents, tasks, scoring, compare, report, pr,
 * cli/orchestrator) imports from here and MUST NOT redefine these names.
 *
 * Where it is natural we define a zod schema first and infer the TypeScript type
 * from it (so runtime validation and the compile-time type can never drift).
 * Purely structural/runtime-result types (e.g. process output, telemetry) are
 * declared as plain interfaces — they are produced internally and not parsed
 * from untrusted input.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Agents & artifacts                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The coding agents SkillCI can target. All three are supported in the MVP.
 */
export const AgentKindSchema = z.enum(['claude-code', 'cursor', 'codex']);
/** A target coding agent. */
export type AgentKind = z.infer<typeof AgentKindSchema>;

/**
 * The kinds of configuration artifact SkillCI understands. These are normalized
 * across agents — e.g. a Cursor `.mdc` and a Claude `CLAUDE.md` both map onto
 * the abstract notions below.
 *
 * - `skill`         — a packaged, model-invoked capability (Claude skills).
 * - `hook`          — a lifecycle hook (e.g. Claude Code hooks).
 * - `rule`          — a scoped behavioral rule (e.g. Cursor `.cursor/rules/*.mdc`).
 * - `instruction`   — freeform standing instructions (CLAUDE.md, AGENTS.md, .cursorrules).
 * - `slash-command` — a user-invocable command (Claude slash commands).
 * - `settings`      — structured config (.claude/settings.json, codex config).
 */
export const ArtifactKindSchema = z.enum([
  'skill',
  'hook',
  'rule',
  'instruction',
  'slash-command',
  'settings',
]);
/** The kind of a configuration artifact. */
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/**
 * A normalized configuration artifact — one discrete piece of agent config
 * (a skill file, a hook, a rule, an instruction file, etc.).
 */
export const ArtifactSchema = z.object({
  /** Stable identifier, unique within a ConfigSet (typically derived from path). */
  id: z.string().min(1),
  /** Which agent this artifact configures. */
  agent: AgentKindSchema,
  /** The normalized kind of this artifact. */
  kind: ArtifactKindSchema,
  /** Path relative to the config root (e.g. `.claude/skills/foo/SKILL.md`). */
  path: z.string().min(1),
  /** Raw textual content of the artifact. */
  content: z.string(),
  /**
   * Free-form normalized metadata extracted by the parser (e.g. skill name,
   * description, frontmatter, hook event, rule globs). Untyped on purpose so
   * parsers can carry agent-specific detail without bloating the contract.
   */
  meta: z.record(z.string(), z.unknown()).default({}),
});
/** A normalized configuration artifact. */
export type Artifact = z.infer<typeof ArtifactSchema>;

/**
 * A full configuration for a single agent — either the BASELINE (current,
 * trusted) config or the CANDIDATE (proposed) config under test.
 */
export const ConfigSetSchema = z.object({
  /** The agent this config set targets. */
  agent: AgentKindSchema,
  /** All artifacts that make up this configuration. */
  artifacts: z.array(ArtifactSchema),
});
/** A full baseline or candidate configuration for one agent. */
export type ConfigSet = z.infer<typeof ConfigSetSchema>;

/** Which side of a comparison a config / run represents. */
export const ConfigLabelSchema = z.enum(['baseline', 'candidate']);
/** Label distinguishing baseline from candidate. */
export type ConfigLabel = z.infer<typeof ConfigLabelSchema>;

/* -------------------------------------------------------------------------- */
/*  Tasks & objective checks                                                  */
/* -------------------------------------------------------------------------- */

/**
 * An objective, deterministic check run against a sandbox after an agent run.
 * Discriminated union on `kind`.
 */
export const ObjectiveCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    /** Shell command to run inside the sandbox workdir. */
    cmd: z.string().min(1),
    /** If true, the check passes only when the command exits 0. */
    expectExitZero: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('fileExists'),
    /** Path (relative to sandbox workdir) that must exist. */
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal('fileContains'),
    /** Path (relative to sandbox workdir) to inspect. */
    path: z.string().min(1),
    /** Substring the file must contain. */
    substring: z.string().min(1),
  }),
  z.object({
    kind: z.literal('testSuite'),
    /** Command that runs a test suite; passes when it exits 0. */
    cmd: z.string().min(1),
  }),
]);
/** A single objective check. */
export type ObjectiveCheck = z.infer<typeof ObjectiveCheckSchema>;

/**
 * An optional LLM-as-judge rubric used to score qualitative aspects of an
 * agent's work that objective checks cannot capture.
 */
export const JudgeRubricSchema = z.object({
  /** Natural-language criteria the judge scores against. */
  criteria: z.string().min(1),
  /** Optional weight (0..1) applied to the judge dimension for this task. */
  weight: z.number().min(0).max(1).optional(),
});
/** An LLM-as-judge rubric. */
export type JudgeRubric = z.infer<typeof JudgeRubricSchema>;

/**
 * A sandboxed repo task. SkillCI runs each task twice (baseline + candidate):
 * it copies `fixtureDir` into an isolated workdir, invokes the target agent
 * headlessly with `prompt`, then scores the result with `checks` (objective),
 * `judgeRubric` (LLM judge), and cost telemetry.
 */
export const TaskSchema = z.object({
  /** Stable identifier, unique within the task suite. */
  id: z.string().min(1),
  /** Human-readable title. */
  title: z.string().min(1),
  /** Which agent this task exercises. */
  agent: AgentKindSchema,
  /** Path to the fixture repo that seeds each sandbox (copied per run). */
  fixtureDir: z.string().min(1),
  /** The prompt handed to the agent headlessly. */
  prompt: z.string().min(1),
  /** Objective checks evaluated after the agent run. */
  checks: z.array(ObjectiveCheckSchema).default([]),
  /** Optional LLM-as-judge rubric. */
  judgeRubric: JudgeRubricSchema.optional(),
  /** Per-task wall-clock budget in milliseconds. */
  timeoutMs: z.number().int().positive().default(120_000),
});
/** A sandboxed repo task. */
export type Task = z.infer<typeof TaskSchema>;

/* -------------------------------------------------------------------------- */
/*  Sandbox & agent run results (runtime telemetry, not parsed input)         */
/* -------------------------------------------------------------------------- */

/**
 * A single changed file as observed by diffing the sandbox before/after a run.
 */
export interface FileDiffEntry {
  /** Path relative to the sandbox workdir. */
  path: string;
  /** Nature of the change. */
  status: 'added' | 'modified' | 'deleted';
  /** Unified-diff text, when computed. */
  patch?: string;
}

/**
 * The result of executing something inside a sandbox (an agent run or a check).
 */
export interface SandboxResult {
  /** Absolute path to the isolated working directory used for the run. */
  workdir: string;
  /** Process exit code (0 = success). */
  exitCode: number;
  /** Captured standard output. */
  stdout: string;
  /** Captured standard error. */
  stderr: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Files changed in the sandbox, relative to the seeded fixture. */
  fileDiff: FileDiffEntry[];
}

/**
 * Telemetry and output from a single headless agent run. Adapters normalize
 * their native output into this shape.
 */
export interface AgentRunResult {
  /** The agent's full transcript / final text output. */
  transcript: string;
  /** Number of tool calls the agent made. */
  toolCalls: number;
  /** Input/prompt tokens consumed. */
  inputTokens: number;
  /** Output/completion tokens produced. */
  outputTokens: number;
  /** Estimated cost in USD. */
  costUsd: number;
  /** Number of agent steps / turns. */
  steps: number;
  /** Wall-clock duration of the run in milliseconds. */
  wallClockMs: number;
  /** The raw, unnormalized adapter output (for debugging / auditing). */
  raw: unknown;
}

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                   */
/* -------------------------------------------------------------------------- */

/** Outcome detail for a single objective check. */
export interface ObjectiveCheckDetail {
  /** The check that was run. */
  check: ObjectiveCheck;
  /** Whether it passed. */
  passed: boolean;
  /** Optional human-readable explanation (e.g. exit code, missing path). */
  message?: string;
}

/** The objective dimension of a task score. */
export interface ObjectiveScore {
  /** Number of checks that passed. */
  passed: number;
  /** Total number of checks evaluated. */
  total: number;
  /** Per-check detail. */
  details: ObjectiveCheckDetail[];
}

/** The LLM-as-judge dimension of a task score. */
export interface JudgeScore {
  /** Normalized score in [0, 1]. */
  score0to1: number;
  /** The judge's rationale. */
  rationale: string;
}

/** The cost/efficiency dimension of a task score. */
export interface CostScore {
  /** Total tokens (input + output). */
  tokens: number;
  /** Number of tool calls. */
  toolCalls: number;
  /** Number of agent steps / turns. */
  steps: number;
  /** Wall-clock duration in milliseconds. */
  wallClockMs: number;
  /** Estimated cost in USD. */
  costUsd: number;
}

/**
 * The full score for one task under one configuration. The `composite` is a
 * single aggregate number (higher is better) used for baseline-vs-candidate
 * comparison.
 */
export interface Score {
  /** The task this score is for. */
  taskId: string;
  /** Objective check results. */
  objective: ObjectiveScore;
  /** Optional LLM-as-judge result. */
  judge?: JudgeScore;
  /** Cost/efficiency telemetry. */
  cost: CostScore;
  /** Aggregate composite score (higher is better). */
  composite: number;
}

/**
 * All scores produced by running the full task suite under one configuration.
 */
export interface RunOutcome {
  /** Which side this outcome represents. */
  configLabel: ConfigLabel;
  /** One score per task. */
  scores: Score[];
}

/* -------------------------------------------------------------------------- */
/*  Comparison & verdict                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The final verdict of a baseline-vs-candidate comparison.
 * - `improved`  — candidate is better with zero hard regressions.
 * - `neutral`   — no meaningful change.
 * - `regressed` — candidate is worse on at least one hard dimension.
 */
export const VerdictSchema = z.enum(['improved', 'neutral', 'regressed']);
/** The comparison verdict. */
export type Verdict = z.infer<typeof VerdictSchema>;

/** Per-task delta between candidate and baseline (candidate minus baseline). */
export interface PerTaskDelta {
  /** The task this delta is for. */
  taskId: string;
  /** Baseline composite score. */
  baselineComposite: number;
  /** Candidate composite score. */
  candidateComposite: number;
  /** candidateComposite - baselineComposite. */
  compositeDelta: number;
  /** Delta in objective checks passed (candidate - baseline). */
  objectiveDelta: number;
  /** Delta in judge score, when both sides have a judge score. */
  judgeDelta?: number;
  /** Delta in cost USD (candidate - baseline; negative is cheaper/better). */
  costUsdDelta: number;
  /** True if this task is a hard regression (e.g. objective checks dropped). */
  isRegression: boolean;
}

/**
 * The full result of comparing a candidate config against the baseline.
 */
export interface Comparison {
  /** The overall verdict. */
  verdict: Verdict;
  /** Per-task deltas. */
  perTaskDeltas: PerTaskDelta[];
  /** Human-readable descriptions of hard regressions (empty when none). */
  regressions: string[];
  /** Human-readable descriptions of improvements. */
  improvements: string[];
  /** Short human-readable summary of the comparison. */
  summary: string;
}

/* -------------------------------------------------------------------------- */
/*  Top-level config                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Thresholds that govern how deltas are interpreted into a verdict.
 */
export const ThresholdsSchema = z.object({
  /**
   * Minimum total composite gain (summed across tasks) for a candidate to be
   * considered `improved` rather than `neutral`.
   */
  minCompositeGain: z.number().default(0.01),
  /**
   * A per-task composite drop beyond this magnitude counts as a hard regression.
   */
  regressionCompositeDrop: z.number().default(0.05),
  /**
   * If true, any drop in objective checks passed on any task is a hard
   * regression (blocks PR creation) regardless of composite gains elsewhere.
   */
  objectiveDropIsRegression: z.boolean().default(true),
});
/** Verdict thresholds. */
export type Thresholds = z.infer<typeof ThresholdsSchema>;

/**
 * Settings controlling the LLM-as-judge.
 */
export const JudgeConfigSchema = z.object({
  /** Anthropic model id used for judging. */
  model: z.string().default('claude-3-5-sonnet-latest'),
  /** Whether judging is enabled (off => judge dimension omitted). */
  enabled: z.boolean().default(true),
});
/** Judge configuration. */
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;

/**
 * Settings controlling pull-request creation. A PR is opened ONLY when the
 * verdict is `improved` with zero hard regressions.
 */
export const PrConfigSchema = z.object({
  /** Whether PR creation is enabled. */
  enabled: z.boolean().default(false),
  /** Base branch to open the PR against. */
  baseBranch: z.string().default('main'),
  /** Branch name prefix for candidate branches. */
  branchPrefix: z.string().default('skillci/'),
  /** Optional reviewers to request (GitHub usernames). */
  reviewers: z.array(z.string()).default([]),
  /** Draft PR if true. */
  draft: z.boolean().default(false),
});
/** Pull-request configuration. */
export type PrConfig = z.infer<typeof PrConfigSchema>;

/**
 * The top-level SkillCI configuration object.
 */
export const SkillCIConfigSchema = z.object({
  /** Agents in scope for this project. */
  agents: z.array(AgentKindSchema).min(1),
  /** Directory containing task definitions / fixtures. */
  tasksDir: z.string().default('skillci/tasks'),
  /** Directory holding the baseline (trusted) agent config. */
  baselineDir: z.string().default('.'),
  /** Verdict thresholds. */
  thresholds: ThresholdsSchema.default({}),
  /** LLM-as-judge settings. */
  judge: JudgeConfigSchema.default({}),
  /** Pull-request settings. */
  pr: PrConfigSchema.default({}),
  /** Cache directory for sandboxes/results. */
  cacheDir: z.string().default('.skillci-cache'),
});
/** Top-level SkillCI configuration. */
export type SkillCIConfig = z.infer<typeof SkillCIConfigSchema>;

/* -------------------------------------------------------------------------- */
/*  Adapter & parser interfaces                                               */
/* -------------------------------------------------------------------------- */

/** Arguments passed to an agent adapter for a single run. */
export interface AgentRunArgs {
  /** The prepared sandbox the agent should operate in. */
  sandbox: SandboxResult;
  /** The task being executed. */
  task: Task;
  /** The configuration (baseline or candidate) applied to the sandbox. */
  configSet: ConfigSet;
}

/**
 * An adapter that drives a specific target agent headlessly. Real adapters
 * (Claude Code, Cursor, Codex) must degrade gracefully when their CLI or API
 * key is absent; `isAvailable()` reports whether the agent can actually run.
 */
export interface AgentAdapter {
  /** Which agent this adapter drives. */
  readonly kind: AgentKind;
  /** Whether this agent can be invoked in the current environment. */
  isAvailable(): Promise<boolean>;
  /** Run the agent against a prepared sandbox and return normalized telemetry. */
  run(args: AgentRunArgs): Promise<AgentRunResult>;
}

/**
 * A parser that discovers and normalizes a specific agent's config artifacts
 * from a directory tree.
 */
export interface ArtifactParser {
  /** Which agent this parser handles. */
  readonly agent: AgentKind;
  /** Discover and normalize all artifacts for this agent under `rootDir`. */
  discover(rootDir: string): Promise<Artifact[]>;
}
