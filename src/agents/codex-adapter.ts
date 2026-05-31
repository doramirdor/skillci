/**
 * CodexAdapter — best-effort headless driver for OpenAI Codex via `codex exec`.
 *
 * Invocation: `codex exec "<prompt>"` in the sandbox workdir. Codex's machine
 * output format varies by version, so this adapter tries JSON first and falls
 * back to raw text with zeroed telemetry.
 *
 * Availability requires the `codex` binary on PATH. (An OPENAI_API_KEY is also
 * required for real runs; we surface it as a soft signal but treat the binary
 * as the hard gate, matching the spec's "best-effort" framing.) When the binary
 * is absent, `run()` throws a typed {@link AgentUnavailableError}.
 */

import { execa } from 'execa';
import type {
  AgentAdapter,
  AgentRunArgs,
  AgentRunResult,
} from '../core/index.js';
import { hasBinary } from './availability.js';
import { AgentUnavailableError } from './errors.js';

const BINARY = 'codex';

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
    return hasBinary(BINARY);
  }

  async run(args: AgentRunArgs): Promise<AgentRunResult> {
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
