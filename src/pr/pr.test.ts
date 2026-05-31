/**
 * Offline tests for the `pr` module.
 *
 * Everything here runs in DRY-RUN mode: no git, no gh, no network, no
 * filesystem mutation. We assert the promotion gate (refuses on `regressed`,
 * proceeds on `improved`) and that the emitted plan is correct.
 */

import { describe, it, expect } from 'vitest';
import type { Comparison, ConfigSet } from '../core/index.js';
import {
  openPromotionPR,
  buildPromotionPlan,
  deriveBranchName,
  safeRelativePath,
  slugify,
  isGhAvailable,
} from './index.js';
import { PrConfigSchema } from '../core/index.js';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function makeConfigSet(): ConfigSet {
  return {
    agent: 'claude-code',
    artifacts: [
      {
        id: 'skill:greeter',
        agent: 'claude-code',
        kind: 'skill',
        path: '.claude/skills/greeter/SKILL.md',
        content: '# Greeter\n\nSay hello politely.\n',
        meta: {},
      },
      {
        id: 'instruction:claude-md',
        agent: 'claude-code',
        kind: 'instruction',
        path: 'CLAUDE.md',
        content: 'Always run the tests before finishing.\n',
        meta: {},
      },
    ],
  };
}

function improvedComparison(): Comparison {
  return {
    verdict: 'improved',
    perTaskDeltas: [
      {
        taskId: 't1',
        baselineComposite: 0.5,
        candidateComposite: 0.8,
        compositeDelta: 0.3,
        objectiveDelta: 1,
        costUsdDelta: -0.01,
        isRegression: false,
      },
    ],
    regressions: [],
    improvements: ['task "t1": composite improved by 0.3 (0.5 -> 0.8)'],
    summary:
      'IMPROVED: 1 task(s) — 1 improved, 0 neutral, 0 regressed; net composite +0.3.',
  };
}

function regressedComparison(): Comparison {
  return {
    verdict: 'regressed',
    perTaskDeltas: [
      {
        taskId: 't1',
        baselineComposite: 0.8,
        candidateComposite: 0.4,
        compositeDelta: -0.4,
        objectiveDelta: -1,
        costUsdDelta: 0.02,
        isRegression: true,
      },
    ],
    regressions: ['task "t1": objective pass-rate dropped (2/2 -> 1/2)'],
    improvements: [],
    summary:
      'REGRESSED: 1 task(s) — 0 improved, 0 neutral, 1 regressed; net composite -0.4. 1 hard regression(s).',
  };
}

/** An `improved` verdict but with a lingering regression (defensive case). */
function improvedButRegressedComparison(): Comparison {
  return {
    ...improvedComparison(),
    regressions: ['task "t1": composite regressed by 0.2 (> threshold 0.05)'],
  };
}

function neutralComparison(): Comparison {
  return {
    verdict: 'neutral',
    perTaskDeltas: [],
    regressions: [],
    improvements: [],
    summary: 'NEUTRAL: 0 task(s) — 0 improved, 0 neutral, 0 regressed; net composite 0.',
  };
}

const REPORT = '# SkillCI Report\n\nCandidate improved the suite.\n';

/* -------------------------------------------------------------------------- */
/*  Gate: refuses to promote                                                  */
/* -------------------------------------------------------------------------- */

describe('openPromotionPR — promotion gate', () => {
  it('refuses to promote on a regressed verdict (no side effects, no plan)', async () => {
    const lines: string[] = [];
    const result = await openPromotionPR({
      comparison: regressedComparison(),
      candidateConfigSet: makeConfigSet(),
      report: REPORT,
      options: { dryRun: true, printer: (l) => lines.push(l) },
    });

    expect(result.promoted).toBe(false);
    expect(result.skippedReason).toMatch(/regressed/);
    expect(result.plannedCommands).toHaveLength(0);
    expect(result.files).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/SKIPPED/);
  });

  it('refuses to promote on a neutral verdict', async () => {
    const result = await openPromotionPR({
      comparison: neutralComparison(),
      candidateConfigSet: makeConfigSet(),
      report: REPORT,
      options: { dryRun: true },
    });
    expect(result.promoted).toBe(false);
    expect(result.skippedReason).toMatch(/neutral/);
    expect(result.plannedCommands).toHaveLength(0);
  });

  it('refuses to promote when verdict is improved but regressions are present', async () => {
    const result = await openPromotionPR({
      comparison: improvedButRegressedComparison(),
      candidateConfigSet: makeConfigSet(),
      report: REPORT,
      options: { dryRun: true },
    });
    expect(result.promoted).toBe(false);
    expect(result.skippedReason).toMatch(/hard regression/);
    expect(result.plannedCommands).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Gate: proceeds (dry-run plan) on improved                                 */
/* -------------------------------------------------------------------------- */

describe('openPromotionPR — dry-run promotion on improved', () => {
  it('emits the correct branch / commit / gh plan and never executes', async () => {
    const lines: string[] = [];
    const result = await openPromotionPR({
      comparison: improvedComparison(),
      candidateConfigSet: makeConfigSet(),
      report: REPORT,
      options: {
        dryRun: true,
        repoDir: '/tmp/skillci-fake-repo',
        prConfig: { baseBranch: 'main', branchPrefix: 'skillci/' },
        printer: (l) => lines.push(l),
      },
    });

    expect(result.promoted).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.skippedReason).toBeUndefined();
    expect(result.prUrl).toBeUndefined();
    expect(result.baseBranch).toBe('main');
    expect(result.branch).toMatch(/^skillci\//);

    // Files derived from the artifacts (repo-relative paths).
    expect(result.files.map((f) => f.path)).toEqual([
      '.claude/skills/greeter/SKILL.md',
      'CLAUDE.md',
    ]);
    expect(result.files.every((f) => f.bytes > 0)).toBe(true);

    // The ordered command plan: branch -> add -> commit -> push -> gh pr create.
    const commands = result.plannedCommands;
    expect(commands.map((c) => c.command)).toEqual([
      'git',
      'git',
      'git',
      'git',
      'gh',
    ]);

    const [checkout, add, commit, push, ghCreate] = commands;
    expect(checkout.args).toEqual(['checkout', '-b', result.branch!]);
    expect(add.args).toEqual([
      'add',
      '.claude/skills/greeter/SKILL.md',
      'CLAUDE.md',
    ]);
    expect(commit.args[0]).toBe('commit');
    expect(commit.args).toContain('-m');
    expect(push.args).toEqual(['push', '-u', 'origin', result.branch!]);

    expect(ghCreate.command).toBe('gh');
    expect(ghCreate.args).toContain('pr');
    expect(ghCreate.args).toContain('create');
    expect(ghCreate.args).toContain('--base');
    expect(ghCreate.args).toContain('main');
    expect(ghCreate.args).toContain('--title');
    // The big markdown body is passed via stdin (`--body-file -`), not inline.
    expect(ghCreate.args).toContain('--body-file');
    expect(ghCreate.args).toContain('-');
    expect(ghCreate.args).not.toContain('--draft');

    // It printed the plan.
    expect(lines.join('\n')).toMatch(/DRY-RUN/);
    expect(lines.join('\n')).toMatch(/would run/);
  });

  it('respects draft + reviewers in the gh plan', async () => {
    const result = await openPromotionPR({
      comparison: improvedComparison(),
      candidateConfigSet: makeConfigSet(),
      report: REPORT,
      options: {
        dryRun: true,
        prConfig: { draft: true, reviewers: ['alice', 'bob'] },
      },
    });
    const gh = result.plannedCommands.find((c) => c.command === 'gh')!;
    expect(gh.args).toContain('--draft');
    expect(gh.args).toContain('--reviewer');
    expect(gh.args.filter((a) => a === 'alice')).toHaveLength(1);
    expect(gh.args.filter((a) => a === 'bob')).toHaveLength(1);
  });

  it('honors an explicit branch and title', async () => {
    const result = await openPromotionPR({
      comparison: improvedComparison(),
      candidateConfigSet: makeConfigSet(),
      report: REPORT,
      options: { dryRun: true, branch: 'skillci/custom', title: 'My PR' },
    });
    expect(result.branch).toBe('skillci/custom');
    expect(result.title).toBe('My PR');
  });

  it('is DRY-RUN by default when dryRun is omitted (no execution attempted)', async () => {
    const result = await openPromotionPR({
      comparison: improvedComparison(),
      candidateConfigSet: makeConfigSet(),
      report: REPORT,
      // no options at all
    });
    expect(result.promoted).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.plannedCommands.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Pure helpers                                                              */
/* -------------------------------------------------------------------------- */

describe('helpers', () => {
  it('slugify produces safe slugs and a fallback', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('  --weird__name--  ')).toBe('weird-name');
    expect(slugify('!!!')).toBe('candidate');
  });

  it('deriveBranchName uses the prefix and config', () => {
    const cs = makeConfigSet();
    const name = deriveBranchName(cs, 'skillci/');
    expect(name.startsWith('skillci/')).toBe(true);
    expect(name).toContain('claude-code');

    const seeded = deriveBranchName(cs, 'skillci/', 'My Cool Change');
    expect(seeded).toBe('skillci/my-cool-change');
  });

  it('safeRelativePath accepts repo-relative paths', () => {
    expect(safeRelativePath('/repo', '.claude/skills/x/SKILL.md')).toBe(
      '.claude/skills/x/SKILL.md',
    );
    expect(safeRelativePath('/repo', 'CLAUDE.md')).toBe('CLAUDE.md');
  });

  it('safeRelativePath rejects absolute paths and traversal', () => {
    expect(() => safeRelativePath('/repo', '/etc/passwd')).toThrow();
    expect(() => safeRelativePath('/repo', '../escape.md')).toThrow();
    expect(() => safeRelativePath('/repo', 'a/../../escape.md')).toThrow();
  });

  it('buildPromotionPlan rejects an artifact that escapes the repo', () => {
    const cs: ConfigSet = {
      agent: 'codex',
      artifacts: [
        {
          id: 'evil',
          agent: 'codex',
          kind: 'instruction',
          path: '../../../etc/evil',
          content: 'x',
          meta: {},
        },
      ],
    };
    expect(() =>
      buildPromotionPlan({
        candidateConfigSet: cs,
        comparison: improvedComparison(),
        prConfig: PrConfigSchema.parse({}),
        repoDir: '/repo',
        branch: 'skillci/x',
        title: 't',
        commitMessage: 'm',
      }),
    ).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/*  Availability guard (offline-safe)                                         */
/* -------------------------------------------------------------------------- */

describe('isGhAvailable', () => {
  it('resolves a boolean without throwing', async () => {
    const available = await isGhAvailable();
    expect(typeof available).toBe('boolean');
  });
});
