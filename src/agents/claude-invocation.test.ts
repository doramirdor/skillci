import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfigSet, makeRunArgs, makeTask } from './test-helpers.js';

/**
 * Pins the headless `claude` invocation contract by mocking `execa`. The agent
 * runs inside a disposable sandbox, so the adapter MUST pass
 * `--dangerously-skip-permissions` — otherwise default-deny headless mode
 * blocks file edits and every editing task silently scores as a failure. This
 * guards that flag (and the rest of the arg list) against regression without
 * spending a real CLI call.
 */
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

const { ClaudeCodeAdapter } = await import('./claude-adapter.js');

afterEach(() => execaMock.mockReset());

describe('ClaudeCodeAdapter headless invocation', () => {
  it('passes -p, --output-format json, and --dangerously-skip-permissions', async () => {
    execaMock.mockImplementation(async (_bin: string, args: string[]) => {
      // Availability probe: `command -v claude` resolves via args ['-v','claude'].
      if (args.includes('-v')) return { exitCode: 0, stdout: '', stderr: '' };
      // The real headless invocation.
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          result: 'done',
          num_turns: 2,
          total_cost_usd: 0.01,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        stderr: '',
      };
    });

    const task = makeTask({ prompt: 'Edit README.md' });
    const args = makeRunArgs('/tmp/wd', task, makeConfigSet('claude-code', ['c']));
    const result = await new ClaudeCodeAdapter().run(args);

    // Find the invocation call (not the `command -v` availability probe).
    const runCall = execaMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('-p'),
    );
    expect(runCall).toBeDefined();
    const [bin, cliArgs, opts] = runCall as [string, string[], { cwd: string }];

    expect(bin).toBe('claude');
    expect(cliArgs).toContain('-p');
    expect(cliArgs).toContain(task.prompt);
    expect(cliArgs).toContain('--output-format');
    expect(cliArgs).toContain('json');
    expect(cliArgs).toContain('--dangerously-skip-permissions');
    expect(opts.cwd).toBe('/tmp/wd');

    // Telemetry still parses through the envelope normalizer.
    expect(result.steps).toBe(2);
    expect(result.outputTokens).toBe(5);
    expect(result.costUsd).toBeCloseTo(0.01, 6);
  });
});
