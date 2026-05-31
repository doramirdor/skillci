/**
 * Environment-probing helpers shared by the real adapters. All probes are
 * best-effort and never throw: a missing binary or a failed spawn simply
 * resolves to `false` so `isAvailable()` can report cleanly.
 */

import { execa } from 'execa';

/**
 * Return true if `binary` resolves on PATH. Uses `command -v` on POSIX and
 * `where` on Windows. Never throws — any failure resolves false.
 */
export async function hasBinary(binary: string): Promise<boolean> {
  const isWindows = process.platform === 'win32';
  const probe = isWindows ? 'where' : 'command';
  const args = isWindows ? [binary] : ['-v', binary];
  try {
    const result = await execa(probe, args, {
      reject: false,
      timeout: 5_000,
      // `command` is a shell builtin on some systems; run via shell for POSIX.
      shell: !isWindows,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Return true if the named env var is set to a non-empty value. */
export function hasEnv(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}
