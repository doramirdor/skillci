/**
 * CodexAdapter — best-effort headless driver for OpenAI Codex via `codex exec`.
 *
 * Invocation: `codex exec "<prompt>"` in the sandbox workdir. Codex's machine
 * output format varies by version, so this adapter tries JSON first and falls
 * back to raw text with zeroed telemetry.
 *
 * Availability requires BOTH the `codex` binary on PATH and an `OPENAI_API_KEY`
 * in the environment — mirroring {@link ClaudeCodeAdapter} so the adapter
 * degrades gracefully (throws a typed {@link AgentUnavailableError}) rather than
 * spawning a process that would block or fail without auth. A run that times
 * out or exits non-zero with no parseable telemetry surfaces a typed error too,
 * instead of a fabricated zeroed-telemetry "success".
 */

import { execa } from 'execa';
import type {
  AgentAdapter,
  AgentRunArgs,
  AgentRunResult,
} from '../core/index.js';
import { hasBinary, hasEnv } from './availability.js';
import { AgentUnavailableError, AgentOutputParseError } from './errors.js';

const BINARY = 'codex';
const API_KEY_ENV = 'OPENAI_API_KEY';

/** Loosely-typed fields `codex exec` *may* emit as JSON. */
interface CodexJsonEnvelope {
  result?: string;
  output?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  cost_usd?: number;
  steps?: number;
  turns?: number;
  tool_calls?: number;
  [k: string]: unknown;
}

export class CodexAdapter implements AgentAdapter {
  readonly kind = 'codex' as const;

  async isAvailable(): Promise<boolean> {
    if (!hasEnv(API_KEY_ENV)) return false;
    return hasBinary(BINARY);
  }

  async run(args: AgentRunArgs): Promise<AgentRunResult> {
    if (!hasEnv(API_KEY_ENV)) {
      throw new AgentUnavailableError(
        this.kind,
        'missing-api-key',
        `Codex adapter unavailable: ${API_KEY_ENV} is not set.`,
      );
    }
    if (!(await hasBinary(BINARY))) {
      throw new AgentUnavailableError(
        this.kind,
        'missing-binary',
        `Codex adapter unavailable: '${BINARY}' CLI not found on PATH.`,
      );
    }

    const { task, sandbox } = args;
    const started = Date.now();

    const result = await execa(BINARY, ['exec', task.prompt], {
      cwd: sandbox.workdir,
      reject: false,
      timeout: task.timeoutMs,
      env: { ...process.env },
      // Non-interactive: never let `codex exec` block reading from a TTY.
      input: '',
    });

    const wallClockMs = Date.now() - started;

    const parsed = tryParseJson(result.stdout);
    if (parsed) {
      const usage = parsed.usage ?? {};
      const steps = parsed.steps ?? parsed.turns ?? 0;
      return {
        transcript: parsed.result ?? parsed.output ?? result.stdout,
        toolCalls: parsed.tool_calls ?? steps,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        costUsd: parsed.cost_usd ?? 0,
        steps,
        wallClockMs,
        raw: parsed,
      };
    }

    // No parseable telemetry. Do NOT fabricate a zeroed "success" for a run
    // that timed out or exited non-zero — surface a typed error so callers can
    // distinguish a real (empty-but-clean) run from a broken one.
    if (result.timedOut) {
      throw new AgentOutputParseError(
        this.kind,
        `'${BINARY} exec' timed out after ${task.timeoutMs}ms with no parseable telemetry`,
        { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timedOut: true },
      );
    }
    if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
      throw new AgentOutputParseError(
        this.kind,
        `'${BINARY} exec' exited ${result.exitCode} with no parseable telemetry`,
        { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      );
    }

    // Clean exit, plain-text output: a legitimate best-effort run with zeroed
    // telemetry (codex's text format does not expose token/cost counts).
    return {
      transcript: result.stdout || result.stderr,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      steps: 0,
      wallClockMs,
      raw: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
    };
  }
}

function tryParseJson(text: string): CodexJsonEnvelope | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as CodexJsonEnvelope;
  } catch {
    return undefined;
  }
}
