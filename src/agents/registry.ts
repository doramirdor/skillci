/**
 * Adapter registry — resolves an {@link AgentAdapter} for a given
 * {@link AgentKind}.
 *
 * By default this returns the *real* adapter for each kind (Claude Code,
 * Cursor, Codex). For offline tests and the demo, pass `{ mock: true }` to get
 * the deterministic {@link MockAgentAdapter} regardless of kind — the mock
 * declares `kind === 'claude-code'`, but `getAdapter` wraps it so the returned
 * adapter reports the requested kind, keeping callers honest about which agent
 * a task targets.
 */

import type {
  AgentAdapter,
  AgentKind,
  AgentRunArgs,
  AgentRunResult,
} from '../core/index.js';
import { ClaudeCodeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { MockAgentAdapter, type MockAgentAdapterOptions } from './mock-adapter.js';

/** Options controlling adapter resolution. */
export interface GetAdapterOptions {
  /**
   * When true, return the deterministic offline {@link MockAgentAdapter} for
   * the requested kind (used by tests and the offline demo).
   */
  mock?: boolean;
  /** Options forwarded to the mock adapter when `mock` is true. */
  mockOptions?: MockAgentAdapterOptions;
}

/**
 * Wraps a {@link MockAgentAdapter} so it reports an arbitrary {@link AgentKind}
 * while keeping the deterministic mock behavior. Lets the mock stand in for
 * Cursor/Codex tasks in offline mode.
 */
class KindOverrideMockAdapter implements AgentAdapter {
  readonly kind: AgentKind;
  private readonly inner: MockAgentAdapter;

  constructor(kind: AgentKind, inner: MockAgentAdapter) {
    this.kind = kind;
    this.inner = inner;
  }

  isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  run(args: AgentRunArgs): Promise<AgentRunResult> {
    return this.inner.run(args);
  }
}

/**
 * Resolve an adapter for `kind`. Returns the real adapter by default, or the
 * deterministic mock when `options.mock` is set.
 */
export function getAdapter(
  kind: AgentKind,
  options: GetAdapterOptions = {},
): AgentAdapter {
  if (options.mock) {
    const mock = new MockAgentAdapter(options.mockOptions);
    // The mock itself declares 'claude-code'; for that kind, hand it back
    // directly. For other kinds, wrap so `.kind` matches the request.
    return kind === 'claude-code'
      ? mock
      : new KindOverrideMockAdapter(kind, mock);
  }

  switch (kind) {
    case 'claude-code':
      return new ClaudeCodeAdapter();
    case 'cursor':
      return new CursorAdapter();
    case 'codex':
      return new CodexAdapter();
    default: {
      // Exhaustiveness guard — should be unreachable given AgentKind.
      const _never: never = kind;
      throw new Error(`unknown agent kind: ${String(_never)}`);
    }
  }
}

/** List the agent kinds that have a real adapter implementation. */
export const SUPPORTED_AGENT_KINDS: readonly AgentKind[] = [
  'claude-code',
  'cursor',
  'codex',
];
