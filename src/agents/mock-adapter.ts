/**
 * MockAgentAdapter — a fully offline, deterministic agent simulation.
 *
 * This is the adapter that powers SkillCI's tests and the offline demo. It does
 * NOT call any model or network. Instead it:
 *
 *  1. Derives a stable seed from `(task.id + configSet content)` so the
 *     baseline config and the candidate config produce *different* — but each
 *     individually reproducible — behavior.
 *  2. Writes plausible files into the sandbox workdir so that the task's
 *     objective checks (`fileExists`, `fileContains`) pass or fail
 *     deterministically. Which checks it satisfies is gated by the seed, so a
 *     "better" config can satisfy strictly more checks than a "worse" one.
 *  3. Returns {@link AgentRunResult} telemetry (tokens, tool calls, steps,
 *     cost, wall-clock) computed deterministically from the same seed.
 *
 * The whole point is reproducibility: run it twice with the same inputs and you
 * get byte-identical files and identical telemetry, every time, with no flakiness.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type {
  AgentAdapter,
  AgentRunArgs,
  AgentRunResult,
  ObjectiveCheck,
} from '../core/index.js';
import { SeededRandom, hashToSeed, seedStringFor } from './hash.js';

/** Options controlling the mock's deterministic behavior. */
export interface MockAgentAdapterOptions {
  /**
   * A "quality bias" in [0, 1] folded into the seed. Higher bias makes the mock
   * satisfy more objective checks and spend fewer resources, on average. Useful
   * for fabricating an obviously-better candidate in demos/tests. Default 0.5.
   */
  qualityBias?: number;
  /**
   * USD price per 1K input tokens. Default 0.003 (Claude-3.5-Sonnet-ish).
   */
  inputPricePer1k?: number;
  /** USD price per 1K output tokens. Default 0.015. */
  outputPricePer1k?: number;
}

/**
 * Files a single mock run wrote into the sandbox, exposed for assertions/tests.
 * (The canonical record of changes still flows through the sandbox file-diff.)
 */
interface PlannedWrite {
  /** Path relative to the sandbox workdir. */
  relPath: string;
  /** File contents written. */
  content: string;
}

const DEFAULT_INPUT_PRICE_PER_1K = 0.003;
const DEFAULT_OUTPUT_PRICE_PER_1K = 0.015;

export class MockAgentAdapter implements AgentAdapter {
  readonly kind = 'claude-code' as const;

  private readonly options: Required<MockAgentAdapterOptions>;

  constructor(options: MockAgentAdapterOptions = {}) {
    this.options = {
      qualityBias: clamp01(options.qualityBias ?? 0.5),
      inputPricePer1k: options.inputPricePer1k ?? DEFAULT_INPUT_PRICE_PER_1K,
      outputPricePer1k: options.outputPricePer1k ?? DEFAULT_OUTPUT_PRICE_PER_1K,
    };
  }

  /** The mock is always available — it needs no binary, key, or network. */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(args: AgentRunArgs): Promise<AgentRunResult> {
    const { task, configSet, sandbox } = args;
    // IMPORTANT: the RNG stream is keyed on (task, config) ONLY — it does not
    // fold in `qualityBias`. The bias enters solely through the `quality`
    // threshold below. Keeping the stream bias-independent guarantees a clean
    // monotonicity property: for the same (task, config), raising the bias can
    // only satisfy MORE checks and spend FEWER resources, never the reverse —
    // because every per-check/per-telemetry draw is identical across biases,
    // and only the comparison thresholds shift. This is what lets a demo
    // fabricate an unambiguously-better candidate.
    const seedString = seedStringFor(task, configSet);
    const seed = hashToSeed(seedString);
    const rng = new SeededRandom(seed);

    // A normalized "quality" score for this (task, config) pair in [0, 1].
    // Blends the seed-derived randomness with the configured quality bias so a
    // higher-bias config tends to do better — deterministically.
    const rawQuality = rng.next();
    const quality = clamp01(rawQuality * 0.5 + this.options.qualityBias * 0.5);

    const planned = planWrites(task.checks, quality, rng);
    await applyWrites(sandbox.workdir, planned);

    const telemetry = computeTelemetry(rng, quality, task.prompt, this.options);

    const transcript = buildTranscript(task.id, configSet.agent, planned, quality);

    return {
      transcript,
      toolCalls: telemetry.toolCalls,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      costUsd: telemetry.costUsd,
      steps: telemetry.steps,
      wallClockMs: telemetry.wallClockMs,
      raw: {
        mock: true,
        seed,
        seedString,
        quality,
        wrote: planned.map((w) => w.relPath),
      },
    };
  }
}

/** Clamp a number into [0, 1]. */
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Decide which files to write so that objective checks pass deterministically.
 *
 * - `fileExists`   => write a small placeholder file at the path.
 * - `fileContains` => write a file whose content includes the required substring.
 * - `command` / `testSuite` checks are not satisfiable by writing files alone,
 *   so the mock leaves those to the sandbox/scoring layer (it may still write a
 *   marker file referenced by convention, but does not fake command success).
 *
 * Higher `quality` means a higher probability that any given satisfiable check
 * is satisfied — so a better config passes strictly more checks on average.
 * The decision per check is drawn from the seeded RNG, hence reproducible.
 */
export function planWrites(
  checks: readonly ObjectiveCheck[],
  quality: number,
  rng: SeededRandom,
): PlannedWrite[] {
  // Merge multiple checks that target the same path into a single write so we
  // never clobber a `fileContains` payload with an empty `fileExists` stub.
  const byPath = new Map<string, string>();

  for (const check of checks) {
    // Probability this check gets satisfied scales with quality but never hits
    // the extremes, so both pass and fail remain reachable across configs.
    const satisfyProb = 0.15 + quality * 0.8;
    const satisfy = rng.next() < satisfyProb;
    if (!satisfy) continue;

    if (check.kind === 'fileExists') {
      const rel = sanitizeRel(check.path);
      if (rel && !byPath.has(rel)) {
        byPath.set(rel, `// generated by SkillCI MockAgentAdapter\n`);
      }
    } else if (check.kind === 'fileContains') {
      const rel = sanitizeRel(check.path);
      if (rel) {
        const existing = byPath.get(rel) ?? '';
        if (!existing.includes(check.substring)) {
          byPath.set(
            rel,
            `${existing}// generated by SkillCI MockAgentAdapter\n${check.substring}\n`,
          );
        }
      }
    }
    // `command` and `testSuite` are intentionally not faked here.
  }

  return [...byPath.entries()].map(([relPath, content]) => ({ relPath, content }));
}

/** Apply planned writes into the sandbox workdir, creating parent dirs. */
async function applyWrites(workdir: string, planned: PlannedWrite[]): Promise<void> {
  for (const { relPath, content } of planned) {
    const abs = safeJoin(workdir, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

/**
 * Reject path-traversal and absolute paths. Returns a cleaned relative path or
 * `undefined` if the input escapes the workdir.
 */
function sanitizeRel(p: string): string | undefined {
  if (isAbsolute(p)) return undefined;
  const norm = normalize(p);
  if (norm === '..' || norm.startsWith(`..${sep}`) || norm.startsWith('../')) {
    return undefined;
  }
  return norm;
}

/** Join, then assert the result stays within the workdir. */
function safeJoin(workdir: string, rel: string): string {
  const base = resolve(workdir);
  const abs = resolve(join(base, rel));
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`refusing to write outside sandbox workdir: ${rel}`);
  }
  return abs;
}

interface Telemetry {
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  steps: number;
  wallClockMs: number;
  costUsd: number;
}

/**
 * Deterministically derive cost/efficiency telemetry. Higher quality => fewer
 * steps/tool-calls/tokens (a better config gets the job done more efficiently),
 * but everything is still seeded so it is reproducible.
 */
export function computeTelemetry(
  rng: SeededRandom,
  quality: number,
  prompt: string,
  opts: Required<MockAgentAdapterOptions>,
): Telemetry {
  const efficiency = quality; // 0 = wasteful, 1 = efficient.

  // Steps: 2..12, fewer when efficient.
  const steps = clampInt(Math.round(12 - efficiency * 8 + rng.next() * 3), 2, 12);
  // Tool calls scale with steps.
  const toolCalls = clampInt(
    Math.round(steps * (1 + rng.next() * 1.5)),
    1,
    40,
  );

  // Input tokens: a base proportional to prompt length plus per-step overhead.
  const promptTokens = Math.max(20, Math.ceil(prompt.length / 4));
  const inputTokens = clampInt(
    promptTokens + steps * 300 + Math.round(rng.next() * 400),
    50,
    100_000,
  );
  // Output tokens: more steps => more output, fewer when efficient.
  const outputTokens = clampInt(
    Math.round(steps * 120 + rng.next() * 300),
    20,
    50_000,
  );

  const costUsd = round4(
    (inputTokens / 1000) * opts.inputPricePer1k +
      (outputTokens / 1000) * opts.outputPricePer1k,
  );

  // Wall-clock: ~400ms per step plus jitter, fewer steps => faster.
  const wallClockMs = clampInt(
    Math.round(steps * 400 + rng.next() * 800),
    200,
    600_000,
  );

  return { toolCalls, inputTokens, outputTokens, steps, wallClockMs, costUsd };
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Build a deterministic plausible transcript string. */
function buildTranscript(
  taskId: string,
  agent: string,
  planned: PlannedWrite[],
  quality: number,
): string {
  const lines = [
    `[mock-agent:${agent}] task=${taskId}`,
    `Plan: address the task by editing the repository.`,
  ];
  for (const w of planned) {
    lines.push(`- wrote ${w.relPath}`);
  }
  lines.push(
    planned.length > 0
      ? `Done. Applied ${planned.length} change(s). (quality≈${quality.toFixed(2)})`
      : `Done. No file changes were necessary. (quality≈${quality.toFixed(2)})`,
  );
  return lines.join('\n');
}
