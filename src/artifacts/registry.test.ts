import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ArtifactParserRegistry,
  discoverConfigSet,
  applyConfigSet,
  diffConfigSets,
  defaultParsers,
} from './index.js';
import { ConfigSetSchema, type ConfigSet } from '../core/index.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillci-registry-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content, 'utf8');
}

describe('ArtifactParserRegistry', () => {
  it('registers all three default agents', () => {
    const reg = new ArtifactParserRegistry();
    expect(reg.agents().sort()).toEqual(['claude-code', 'codex', 'cursor']);
    expect(reg.get('claude-code')?.agent).toBe('claude-code');
  });

  it('throws when discovering an unregistered agent', async () => {
    const reg = new ArtifactParserRegistry([]);
    await expect(reg.discoverConfigSet(root, 'cursor')).rejects.toThrow(
      /No artifact parser/,
    );
  });

  it('default parsers list contains three parsers', () => {
    expect(defaultParsers()).toHaveLength(3);
  });
});

describe('discoverConfigSet', () => {
  it('returns a schema-valid ConfigSet for a populated repo', async () => {
    await write('CLAUDE.md', '# rules');
    await write('.claude/commands/go.md', '---\ndescription: go\n---\nrun');
    const cs = await discoverConfigSet(root, 'claude-code');
    expect(cs.agent).toBe('claude-code');
    expect(() => ConfigSetSchema.parse(cs)).not.toThrow();
    expect(cs.artifacts.length).toBeGreaterThanOrEqual(2);
  });

  it('returns an empty ConfigSet for a repo with no config (robust to missing)', async () => {
    const cs = await discoverConfigSet(root, 'codex');
    expect(cs).toEqual({ agent: 'codex', artifacts: [] });
  });
});

describe('applyConfigSet', () => {
  it('round-trips a discovered config set into a sandbox dir', async () => {
    await write('CLAUDE.md', '# rules\nbe nice');
    await write('.claude/skills/pdf/SKILL.md', '---\nname: pdf\n---\nbody');
    await write('.claude/settings.json', JSON.stringify({ hooks: { X: [] } }));
    const cs = await discoverConfigSet(root, 'claude-code');

    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'skillci-sandbox-'));
    try {
      const written = await applyConfigSet(sandbox, cs);
      // The virtual settings#hooks artifact must not produce a second write.
      expect(written).toContain('CLAUDE.md');
      expect(written).toContain('.claude/settings.json');
      const settingsWrites = written.filter((w) => w === '.claude/settings.json');
      expect(settingsWrites).toHaveLength(1);

      const claudeMd = await fs.readFile(path.join(sandbox, 'CLAUDE.md'), 'utf8');
      expect(claudeMd).toContain('be nice');
      const settings = await fs.readFile(
        path.join(sandbox, '.claude/settings.json'),
        'utf8',
      );
      // Non-virtual settings content wins (raw JSON object, not the hooks block).
      expect(settings).toContain('hooks');
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });

  it('re-discovers an applied config set identically (idempotent shape)', async () => {
    await write('.cursorrules', 'rule one');
    await write('.cursor/rules/a.mdc', '---\ndescription: d\n---\nbody');
    const original = await discoverConfigSet(root, 'cursor');

    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'skillci-sandbox-'));
    try {
      await applyConfigSet(sandbox, original);
      const reread = await discoverConfigSet(sandbox, 'cursor');
      expect(reread.artifacts.map((a) => a.path).sort()).toEqual(
        original.artifacts.map((a) => a.path).sort(),
      );
      const origContent = original.artifacts.map((a) => [a.path, a.content]).sort();
      const reContent = reread.artifacts.map((a) => [a.path, a.content]).sort();
      expect(reContent).toEqual(origContent);
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe('diffConfigSets', () => {
  const base: ConfigSet = {
    agent: 'codex',
    artifacts: [
      { id: 'AGENTS.md', agent: 'codex', kind: 'instruction', path: 'AGENTS.md', content: 'v1', meta: {} },
      { id: 'codex.json', agent: 'codex', kind: 'settings', path: 'codex.json', content: '{}', meta: {} },
    ],
  };

  it('reports no changes for identical sets', () => {
    const diff = diffConfigSets(base, base);
    expect(diff.unchanged).toBe(true);
    expect(diff.entries).toEqual([]);
  });

  it('detects added, removed, and modified artifacts', () => {
    const candidate: ConfigSet = {
      agent: 'codex',
      artifacts: [
        // AGENTS.md modified
        { id: 'AGENTS.md', agent: 'codex', kind: 'instruction', path: 'AGENTS.md', content: 'v2', meta: {} },
        // codex.json removed (absent here)
        // new file added
        { id: 'codex.toml', agent: 'codex', kind: 'settings', path: 'codex.toml', content: 'x', meta: {} },
      ],
    };
    const diff = diffConfigSets(base, candidate);
    expect(diff.unchanged).toBe(false);
    const byId = Object.fromEntries(diff.entries.map((e) => [e.id, e.status]));
    expect(byId['AGENTS.md']).toBe('modified');
    expect(byId['codex.json']).toBe('removed');
    expect(byId['codex.toml']).toBe('added');
  });
});
