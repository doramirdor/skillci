// Live smoke test: drive the REAL ClaudeCodeAdapter (subscription auth, no
// ANTHROPIC_API_KEY) against one objective sample task in a real sandbox.
import { getSampleTasksDetailed } from '../dist/tasks/index.js';
import { ClaudeCodeAdapter } from '../dist/agents/index.js';
import { createSandbox } from '../dist/sandbox/index.js';
import { runObjectiveChecks } from '../dist/scoring/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const detailed = await getSampleTasksDetailed();
const found = detailed.find((d) => d.task.id === 'fix-readme-typo');
if (!found) throw new Error('fix-readme-typo task not found');
const task = found.task;

const adapter = new ClaudeCodeAdapter();
console.log('adapter.isAvailable():', await adapter.isAvailable());

const sandbox = await createSandbox(task.fixtureDir);
try {
  const before = await readFile(join(sandbox.workdir, 'README.md'), 'utf8');
  console.log('\n--- README before ---\n' + before);

  console.log('>>> invoking real `claude -p` ...');
  const result = await adapter.run({ sandbox, task, configSet: { agent: 'claude-code', artifacts: [] } });

  console.log('\n--- telemetry ---');
  console.log({
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    steps: result.steps,
    toolCalls: result.toolCalls,
    wallClockMs: result.wallClockMs,
  });

  const after = await readFile(join(sandbox.workdir, 'README.md'), 'utf8');
  console.log('\n--- README after ---\n' + after);

  const objective = await runObjectiveChecks(sandbox, task);
  console.log('\n--- objective checks ---');
  console.log(`passed ${objective.passed}/${objective.total}`);
  for (const d of objective.details) console.log(`  [${d.passed ? 'PASS' : 'FAIL'}] ${d.label ?? d.kind}`);
} finally {
  await sandbox.dispose();
}
