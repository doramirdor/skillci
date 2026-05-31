import { describe, it, expect } from 'vitest';
import {
  ArtifactSchema,
  ConfigSetSchema,
  TaskSchema,
  ObjectiveCheckSchema,
  SkillCIConfigSchema,
  VerdictSchema,
} from './contracts.js';

describe('ArtifactSchema', () => {
  it('parses a valid artifact and defaults meta to {}', () => {
    const parsed = ArtifactSchema.parse({
      id: 'skill:foo',
      agent: 'claude-code',
      kind: 'skill',
      path: '.claude/skills/foo/SKILL.md',
      content: '# Foo skill',
    });
    expect(parsed.meta).toEqual({});
    expect(parsed.kind).toBe('skill');
  });

  it('rejects an unknown agent', () => {
    expect(() =>
      ArtifactSchema.parse({
        id: 'x',
        agent: 'not-an-agent',
        kind: 'skill',
        path: 'p',
        content: '',
      }),
    ).toThrow();
  });

  it('rejects an empty id', () => {
    expect(() =>
      ArtifactSchema.parse({
        id: '',
        agent: 'cursor',
        kind: 'rule',
        path: 'p',
        content: '',
      }),
    ).toThrow();
  });
});

describe('ConfigSetSchema', () => {
  it('parses a config set with artifacts', () => {
    const cs = ConfigSetSchema.parse({
      agent: 'codex',
      artifacts: [
        { id: 'a', agent: 'codex', kind: 'instruction', path: 'AGENTS.md', content: 'hi' },
      ],
    });
    expect(cs.artifacts).toHaveLength(1);
  });
});

describe('ObjectiveCheckSchema', () => {
  it('discriminates on kind and defaults expectExitZero', () => {
    const c = ObjectiveCheckSchema.parse({ kind: 'command', cmd: 'npm test' });
    expect(c.kind === 'command' && c.expectExitZero).toBe(true);
  });

  it('parses a fileContains check', () => {
    const c = ObjectiveCheckSchema.parse({
      kind: 'fileContains',
      path: 'README.md',
      substring: 'SkillCI',
    });
    expect(c.kind).toBe('fileContains');
  });

  it('rejects an unknown check kind', () => {
    expect(() => ObjectiveCheckSchema.parse({ kind: 'nope' })).toThrow();
  });
});

describe('TaskSchema', () => {
  it('parses a valid task and applies defaults', () => {
    const t = TaskSchema.parse({
      id: 't1',
      title: 'Add a function',
      agent: 'claude-code',
      fixtureDir: 'fixtures/repo-a',
      prompt: 'Add an add() function',
    });
    expect(t.checks).toEqual([]);
    expect(t.timeoutMs).toBe(120_000);
    expect(t.judgeRubric).toBeUndefined();
  });

  it('rejects a non-positive timeout', () => {
    expect(() =>
      TaskSchema.parse({
        id: 't',
        title: 't',
        agent: 'cursor',
        fixtureDir: 'f',
        prompt: 'p',
        timeoutMs: 0,
      }),
    ).toThrow();
  });
});

describe('SkillCIConfigSchema', () => {
  it('parses a minimal config and fills defaults', () => {
    const cfg = SkillCIConfigSchema.parse({ agents: ['claude-code'] });
    expect(cfg.tasksDir).toBe('skillci/tasks');
    expect(cfg.judge.model).toBe('claude-3-5-sonnet-latest');
    expect(cfg.pr.enabled).toBe(false);
    expect(cfg.thresholds.objectiveDropIsRegression).toBe(true);
    expect(cfg.cacheDir).toBe('.skillci-cache');
  });

  it('rejects an empty agents list', () => {
    expect(() => SkillCIConfigSchema.parse({ agents: [] })).toThrow();
  });
});

describe('VerdictSchema', () => {
  it('accepts the three verdicts', () => {
    expect(VerdictSchema.parse('improved')).toBe('improved');
    expect(VerdictSchema.parse('neutral')).toBe('neutral');
    expect(VerdictSchema.parse('regressed')).toBe('regressed');
  });

  it('rejects anything else', () => {
    expect(() => VerdictSchema.parse('great')).toThrow();
  });
});
