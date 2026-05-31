import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ClaudeArtifactParser,
  CursorArtifactParser,
  CodexArtifactParser,
} from './index.js';
import type { Artifact } from '../core/index.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillci-artifacts-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Writes a file under the temp root, creating parents. */
async function write(rel: string, content: string): Promise<void> {
  const dest = path.join(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content, 'utf8');
}

function byPath(arts: Artifact[], p: string): Artifact | undefined {
  return arts.find((a) => a.path === p);
}

describe('ClaudeArtifactParser', () => {
  it('returns [] for an empty/missing config tree', async () => {
    const arts = await new ClaudeArtifactParser().discover(root);
    expect(arts).toEqual([]);
  });

  it('discovers CLAUDE.md as an instruction', async () => {
    await write('CLAUDE.md', '# Project rules\nBe concise.');
    const arts = await new ClaudeArtifactParser().discover(root);
    const instr = byPath(arts, 'CLAUDE.md');
    expect(instr?.kind).toBe('instruction');
    expect(instr?.agent).toBe('claude-code');
    expect(instr?.content).toContain('Be concise');
  });

  it('discovers skills with manifest metadata and bundled files', async () => {
    await write(
      '.claude/skills/pdf/SKILL.md',
      '---\nname: pdf-helper\ndescription: Work with PDFs\n---\nInstructions',
    );
    await write('.claude/skills/pdf/scripts/run.py', 'print("hi")');
    const arts = await new ClaudeArtifactParser().discover(root);
    const skillArts = arts.filter((a) => a.kind === 'skill');
    expect(skillArts).toHaveLength(2);
    const manifest = byPath(skillArts, '.claude/skills/pdf/SKILL.md');
    expect(manifest?.meta.isManifest).toBe(true);
    expect(manifest?.meta.skillName).toBe('pdf-helper');
    expect(manifest?.meta.description).toBe('Work with PDFs');
    const script = byPath(skillArts, '.claude/skills/pdf/scripts/run.py');
    expect(script?.meta.isManifest).toBe(false);
    expect(script?.meta.skill).toBe('pdf');
  });

  it('discovers hooks from the hooks dir', async () => {
    await write('.claude/hooks/pre-commit.sh', '#!/bin/sh\necho hi');
    const arts = await new ClaudeArtifactParser().discover(root);
    const hook = byPath(arts, '.claude/hooks/pre-commit.sh');
    expect(hook?.kind).toBe('hook');
    expect(hook?.meta.source).toBe('hooks-dir');
  });

  it('discovers slash commands with frontmatter description', async () => {
    await write(
      '.claude/commands/review.md',
      '---\ndescription: Review the diff\n---\nDo a review',
    );
    const arts = await new ClaudeArtifactParser().discover(root);
    const cmd = byPath(arts, '.claude/commands/review.md');
    expect(cmd?.kind).toBe('slash-command');
    expect(cmd?.meta.command).toBe('review');
    expect(cmd?.meta.description).toBe('Review the diff');
  });

  it('discovers settings.json and surfaces inline hooks separately', async () => {
    const settings = {
      model: 'claude-sonnet',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
    };
    await write('.claude/settings.json', JSON.stringify(settings, null, 2));
    const arts = await new ClaudeArtifactParser().discover(root);
    const settingsArt = arts.find(
      (a) => a.kind === 'settings' && a.id === '.claude/settings.json',
    );
    expect(settingsArt?.meta.valid).toBe(true);
    expect(settingsArt?.meta.hasInlineHooks).toBe(true);
    const inlineHook = arts.find((a) => a.id === '.claude/settings.json#hooks');
    expect(inlineHook?.kind).toBe('hook');
    expect(inlineHook?.meta.virtual).toBe(true);
    expect(inlineHook?.content).toContain('PreToolUse');
  });

  it('marks invalid settings.json with a parse error', async () => {
    await write('.claude/settings.json', '{ not valid json');
    const arts = await new ClaudeArtifactParser().discover(root);
    const settingsArt = arts.find((a) => a.kind === 'settings');
    expect(settingsArt?.meta.valid).toBe(false);
    expect(typeof settingsArt?.meta.parseError).toBe('string');
  });
});

describe('CursorArtifactParser', () => {
  it('discovers .mdc rules with globs/alwaysApply meta', async () => {
    await write(
      '.cursor/rules/style.mdc',
      '---\ndescription: TS style\nglobs: [src/**]\nalwaysApply: false\n---\nUse strict mode',
    );
    const arts = await new CursorArtifactParser().discover(root);
    const rule = byPath(arts, '.cursor/rules/style.mdc');
    expect(rule?.kind).toBe('rule');
    expect(rule?.agent).toBe('cursor');
    expect(rule?.meta.description).toBe('TS style');
    expect(rule?.meta.globs).toEqual(['src/**']);
    expect(rule?.meta.alwaysApply).toBe(false);
  });

  it('discovers legacy .cursorrules', async () => {
    await write('.cursorrules', 'Always write tests.');
    const arts = await new CursorArtifactParser().discover(root);
    const rule = byPath(arts, '.cursorrules');
    expect(rule?.kind).toBe('rule');
    expect(rule?.meta.legacy).toBe(true);
  });

  it('ignores non-.mdc files in the rules dir', async () => {
    await write('.cursor/rules/notes.txt', 'ignore me');
    const arts = await new CursorArtifactParser().discover(root);
    expect(arts).toEqual([]);
  });
});

describe('CodexArtifactParser', () => {
  it('discovers AGENTS.md as instruction', async () => {
    await write('AGENTS.md', '# Agents\nGuidelines here');
    const arts = await new CodexArtifactParser().discover(root);
    const instr = byPath(arts, 'AGENTS.md');
    expect(instr?.kind).toBe('instruction');
    expect(instr?.agent).toBe('codex');
  });

  it('discovers codex config files as settings with format meta', async () => {
    await write('.codex/config.toml', 'model = "o4"');
    await write('codex.json', '{"model":"o4"}');
    const arts = await new CodexArtifactParser().discover(root);
    const toml = byPath(arts, '.codex/config.toml');
    expect(toml?.kind).toBe('settings');
    expect(toml?.meta.format).toBe('toml');
    const json = byPath(arts, 'codex.json');
    expect(json?.meta.format).toBe('json');
    expect(json?.meta.valid).toBe(true);
  });

  it('flags invalid JSON codex config', async () => {
    await write('codex.json', '{bad');
    const arts = await new CodexArtifactParser().discover(root);
    const json = byPath(arts, 'codex.json');
    expect(json?.meta.valid).toBe(false);
  });
});
