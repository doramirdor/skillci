/**
 * CursorAdapter — best-effort headless driver for Cursor via the `cursor-agent`
 * CLI. Cursor's headless surface is less stable than Claude's, so this adapter
 * is intentionally conservative: it runs `cursor-agent` in the sandbox, tries to
 * parse JSON telemetry if present, and otherwise falls back to raw text with
 * zeroed token/cost fields.
 *
 * Availability requires only the `cursor-agent` binary on PATH (no separate API
 * key check — Cursor manages its own auth). When unavailable, `run()` throws a
 * typed {@link AgentUnavailableError}.
 */

import { execa } from 'execa';
import type {
  AgentAdapter,
  AgentRunArgs,
  AgentRunResult,
} from '../core/index.js';
import { hasBinary } from './availability.js';
import { AgentUnavailableError, AgentOutputParseError } from './errors.js';

const BINARY = 'cursor-agent';

/** Loosely-typed fields cursor-agent *may* emit when asked for JSON. */
interface CursorJsonEnvelope {
  result?: string;
  text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  cost_usd?: number;
  steps?: number;
  tool_calls?: number;
  [k: string]: unknown;
}

export class CursorAdapter implements AgentAdapter {
  readonly kind = 'cursor' as const;

  async isAvailable(): Promise<boolean> {
    return hasBinary(BINARY);
  }

  async run(args: AgentRunArgs): Promise<AgentRunResult> {
    if (!(await hasBinary(BINARY))) {
      throw new AgentUnavailableError(
        this.kind,
        'missing-binary',
        `Cursor adapter unavailable: '${BINARY}' CLI not found on PATH.`,
      );
    }

    const { task, sandbox } = args;
    const started = Date.now();

    // Best-effort: pass the prompt headlessly and request JSON output. Unknown
    // flags are tolerated by `reject: false`; we adapt to whatever comes back.
    const result = await execa(
      BINARY,
      ['-p', task.prompt, '--output-format', 'json'],
      {
        cwd: sandbox.workdir,
        reject: false,
        timeout: task.timeoutMs,
        env: { ...process.env },
      },
    );

    const wallClockMs = Date.now() - started;

    const parsed = tryParseJson(result.stdout);
    if (parsed) {
      const usage = parsed.usage ?? {};
      return {
        transcript:
          parsed.result ?? parsed.text ?? result.stdout,
        toolCalls: parsed.tool_calls ?? parsed.steps ?? 0,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        costUsd: parsed.cost_usd ?? 0,
        steps: parsed.steps ?? 0,
        wallClockMs,
        raw: parsed,
      };
    }

    // No parseable telemetry. A timed-out or non-zero run is NOT a success —
    // surface a typed error rather than fabricating zeroed-telemetry success.
    if (result.timedOut) {
      throw new AgentOutputParseError(
        this.kind,
        `'${BINARY}' timed out after ${task.timeoutMs}ms with no parseable telemetry`,
        { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timedOut: true },
      );
    }
    if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
      throw new AgentOutputParseError(
        this.kind,
        `'${BINARY}' exited ${result.exitCode} with no parseable telemetry`,
        { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      );
    }

    // Clean exit, plain-text output — a legitimate best-effort run with zeroed
    // telemetry (cursor's text format does not expose token/cost counts).
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

function tryParseJson(text: string): CursorJsonEnvelope | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as CursorJsonEnvelope;
  } catch {
    return undefined;
  }
}
