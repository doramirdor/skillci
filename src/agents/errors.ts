/**
 * Typed errors for the agents module. Real adapters (Claude Code, Cursor,
 * Codex) throw {@link AgentUnavailableError} when their CLI or required API key
 * is missing, rather than crashing with an opaque spawn error — callers can
 * catch this specific type and degrade gracefully.
 */

import type { AgentKind } from '../core/index.js';

/**
 * Thrown when an adapter is asked to {@link AgentAdapter.run} but the agent
 * cannot actually be invoked in the current environment (missing binary,
 * missing API key, etc.). Always paired with an `isAvailable() === false`.
 */
export class AgentUnavailableError extends Error {
  /** The agent that was unavailable. */
  readonly kind: AgentKind;
  /** Short machine-readable reason code. */
  readonly reason: 'missing-binary' | 'missing-api-key' | 'unknown';

  constructor(
    kind: AgentKind,
    reason: 'missing-binary' | 'missing-api-key' | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'AgentUnavailableError';
    this.kind = kind;
    this.reason = reason;
  }
}

/**
 * Thrown when a real adapter ran the agent CLI but could not parse its output
 * into normalized telemetry.
 */
export class AgentOutputParseError extends Error {
  /** The agent whose output failed to parse. */
  readonly kind: AgentKind;
  /** The raw output that could not be parsed (for debugging). */
  readonly raw: unknown;

  constructor(kind: AgentKind, message: string, raw: unknown) {
    super(message);
    this.name = 'AgentOutputParseError';
    this.kind = kind;
    this.raw = raw;
  }
}
