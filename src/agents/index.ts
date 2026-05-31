/**
 * Public surface of the SkillCI `agents` module.
 *
 * Provides {@link AgentAdapter} implementations for every target agent plus a
 * deterministic offline {@link MockAgentAdapter}, and a {@link getAdapter}
 * registry to resolve them by {@link AgentKind}.
 */

export { MockAgentAdapter, planWrites, computeTelemetry } from './mock-adapter.js';
export type { MockAgentAdapterOptions } from './mock-adapter.js';

export { ClaudeCodeAdapter, parseClaudeEnvelope } from './claude-adapter.js';
export { CursorAdapter } from './cursor-adapter.js';
export { CodexAdapter } from './codex-adapter.js';

export { getAdapter, SUPPORTED_AGENT_KINDS } from './registry.js';
export type { GetAdapterOptions } from './registry.js';

export { AgentUnavailableError, AgentOutputParseError } from './errors.js';

export { hashToSeed, seedStringFor, SeededRandom } from './hash.js';
export { hasBinary, hasEnv } from './availability.js';
