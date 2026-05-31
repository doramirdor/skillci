import { describe, it, expect } from 'vitest';

import {
  buildProgram,
  runCommand,
  validateCommand,
  tasksCommand,
  parseAgent,
} from './index.js';

/** Collect lines emitted by a command's `out` sink. */
function collector(): { out: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (line: string) => lines.push(line), lines };
}

describe('parseAgent', () => {
  it('accepts the three supported kinds', () => {
    expect(parseAgent('claude-code')).toBe('claude-code');
    expect(parseAgent('cursor')).toBe('cursor');
    expect(parseAgent('codex')).toBe('codex');
  });

  it('rejects unknown agents', () => {
    expect(() => parseAgent('copilot')).toThrow(/invalid --agent/);
  });
});

describe('buildProgram', () => {
  it('registers run, validate, and tasks subcommands', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('run');
    expect(names).toContain('validate');
    expect(names).toContain('tasks');
  });
});

describe('run --demo (offline smoke test)', () => {
  it('prints a terminal report and returns the verdict', async () => {
    const { out, lines } = collector();
    const verdict = await runCommand({ agent: 'claude-code', demo: true, color: false }, out);

    expect(['improved', 'neutral', 'regressed']).toContain(verdict);
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(0);
    // Terminal report mentions the verdict somewhere.
    expect(text.toLowerCase()).toContain(verdict);
    // PR summary line is present.
    expect(text).toMatch(/PR:/);
  });

  it('treats missing baseline/candidate dirs as demo mode', async () => {
    const { out } = collector();
    const verdict = await runCommand({ agent: 'claude-code', color: false }, out);
    expect(['improved', 'neutral', 'regressed']).toContain(verdict);
  });
});

describe('tasks command', () => {
  it('lists the bundled sample tasks', async () => {
    const { out, lines } = collector();
    const count = await tasksCommand({ color: false }, out);
    expect(count).toBeGreaterThan(0);
    expect(lines.join('\n')).toMatch(/task\(s\) from/);
  });
});

describe('validate command', () => {
  it('reports an empty config set for a dir with no artifacts', async () => {
    const { out, lines } = collector();
    const config = await validateCommand(
      process.cwd() + '/this-dir-does-not-exist',
      { agent: 'claude-code', color: false },
      out,
    );
    expect(config.agent).toBe('claude-code');
    expect(config.artifacts).toEqual([]);
    expect(lines.join('\n')).toMatch(/no artifacts discovered/);
  });
});
