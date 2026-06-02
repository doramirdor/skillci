/**
 * ClaudeCodeAdapter — drives Claude Code headlessly via the `claude` CLI.
 *
 * Invocation: `claude -p "<prompt>" --output-format json` in the sandbox
 * workdir. The JSON envelope is parsed into normalized {@link AgentRunResult}
 * telemetry (tokens, cost, turns).
 *
 * Availability requires only the `claude` binary on PATH — the CLI manages its
 * own authentication (an `ANTHROPIC_API_KEY` *or* a Claude Code
 * subscription/OAuth session), so there is no separate key check here. This
 * mirrors {@link CursorAdapter}. When the binary is absent, `run()` throws a
 * typed {@link AgentUnavailableError}; an un-authed or failed CLI invocation
 * surfaces as a typed {@link AgentOutputParseError} from the envelope parser.
 *
 * Note: the LLM-as-judge in `scoring/judge.ts` *does* require an
 * `ANTHROPIC_API_KEY` because it calls the Anthropic SDK directly (no CLI, no
 * OAuth path). That key requirement belongs to the judge, not to this adapter.
 */

import { execa } from 'execa';
import type {
  AgentAdapter,
  AgentRunArgs,
  AgentRunResult,
} from '../core/index.js';
import { hasBinary } from './availability.js';
import { AgentOutputParseError, AgentUnavailableError } from './errors.js';

/** Shape of the relevant fields in `claude --output-format json` output. */
interface ClaudeJsonEnvelope {
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  [k: string]: unknown;
}

const BINARY = 'claude';

/**
 * Pure normalizer for the `claude --output-format json` envelope. Exported so
 * the success path (telemetry parsing) is unit-testable without spawning a CLI
 * or hitting the network. Throws {@link AgentOutputParseError} when stdout is
 * not valid JSON.
 *
 * Token accounting sums input + cache-read + cache-creation into `inputTokens`,
 * maps `total_cost_usd` -> `costUsd` and `num_turns` -> `steps`. Missing fields
 * default to 0; a parse failure surfaces a typed error rather than a silent
 * zeroed-success.
 */
export function parseClaudeEnvelope(
  stdout: string,
  stderr: string,
  exitCode: number | undefined,
  wallClockMs: number,
): AgentRunResult {
  let parsed: ClaudeJsonEnvelope;
  try {
    parsed = JSON.parse(stdout) as ClaudeJsonEnvelope;
  } catch (err) {
    throw new AgentOutputParseError(
      'claude-code',
      `failed to parse 'claude --output-format json' output: ${(err as Error).message}`,
      { stdout, stderr, exitCode },
    );
  }

  const usage = parsed.usage ?? {};
  const inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  const outputTokens = usage.output_tokens ?? 0;
  const steps = parsed.num_turns ?? 0;

  return {
    transcript: typeof parsed.result === 'string' ? parsed.result : stdout,
    // The JSON envelope does not break out tool-call counts; approximate with
    // turns (each turn may carry tool use). Callers treat this as best-effort.
    toolCalls: steps,
    inputTokens,
    outputTokens,
    costUsd: parsed.total_cost_usd ?? 0,
    steps,
    wallClockMs,
    raw: parsed,
  };
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = 'claude-code' as const;

  async isAvailable(): Promise<boolean> {
    return hasBinary(BINARY);
  }

  async run(args: AgentRunArgs): Promise<AgentRunResult> {
    if (!(await hasBinary(BINARY))) {
      throw new AgentUnavailableError(
        this.kind,
        'missing-binary',
        `Claude Code adapter unavailable: '${BINARY}' CLI not found on PATH.`,
      );
    }

    const { task, sandbox } = args;
    const started = Date.now();

    const result = await execa(
      BINARY,
      [
        '-p',
        task.prompt,
        '--output-format',
        'json',
        // SkillCI always runs the agent inside an ephemeral, isolated sandbox
        // (a disposable tmpdir copy of the fixture). Headless `claude -p` is
        // default-deny on tool permissions, so without this flag the agent
        // cannot edit files or run commands — every file-editing task would
        // score as a failure regardless of config quality, defeating the
        // evaluation. Bypassing permissions is exactly what the flag is
        // recommended for in a throwaway sandbox.
        '--dangerously-skip-permissions',
      ],
      {
        cwd: sandbox.workdir,
        reject: false,
        timeout: task.timeoutMs,
        env: { ...process.env },
      },
    );

    const wallClockMs = Date.now() - started;

    return parseClaudeEnvelope(
      result.stdout,
      result.stderr,
      result.exitCode,
      wallClockMs,
    );
  }
}
