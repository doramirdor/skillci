/**
 * Public entrypoint for the SkillCI `sandbox` module.
 *
 * Ephemeral, isolated fixture working copies with command execution, file-diff
 * snapshots, and cleanup — behind a pluggable backend interface.
 */
export { createSandbox, withSandbox } from './sandbox.js';
export { LocalSandboxBackend } from './local-backend.js';
export type {
  Sandbox,
  SandboxBackend,
  CreateSandboxOptions,
  ExecOptions,
  WorkdirSnapshot,
} from './types.js';
