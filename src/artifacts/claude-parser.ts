/**
 * ArtifactParser for Claude Code config.
 *
 * Discovers and normalizes:
 * - `.claude/skills/**` (skill)          — SKILL.md + bundled files.
 * - `.claude/hooks/**`  (hook)           — hook scripts.
 * - `.claude/settings.json` hooks (hook) — declarative hooks in settings.
 * - `.claude/commands/*.md` (slash-command).
 * - `CLAUDE.md` (instruction).
 * - `.claude/settings.json` (settings).
 */
import * as path from 'node:path';
import type { Artifact, ArtifactParser, AgentKind } from '../core/index.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  isDir,
  listFiles,
  listDirs,
  readFileSafe,
  relPosix,
  walkFiles,
} from './fs-utils.js';

export class ClaudeArtifactParser implements ArtifactParser {
  readonly agent: AgentKind = 'claude-code';

  async discover(rootDir: string): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];
    const claudeDir = path.join(rootDir, '.claude');

    await this.discoverInstruction(rootDir, artifacts);
    await this.discoverSkills(rootDir, claudeDir, artifacts);
    await this.discoverHooks(rootDir, claudeDir, artifacts);
    await this.discoverCommands(rootDir, claudeDir, artifacts);
    await this.discoverSettings(rootDir, claudeDir, artifacts);

    artifacts.sort((a, b) => a.id.localeCompare(b.id));
    return artifacts;
  }

  /** CLAUDE.md at the repo root (instruction). */
  private async discoverInstruction(rootDir: string, out: Artifact[]): Promise<void> {
    const file = path.join(rootDir, 'CLAUDE.md');
    const content = await readFileSafe(file);
    if (content === undefined) return;
    out.push({
      id: 'CLAUDE.md',
      agent: this.agent,
      kind: 'instruction',
      path: 'CLAUDE.md',
      content,
      meta: { source: 'CLAUDE.md' },
    });
  }

  /**
   * `.claude/skills/<name>/` directories. The SKILL.md frontmatter (name,
   * description) is surfaced in meta; every bundled file becomes its own
   * artifact so the whole skill is faithfully copied into a sandbox.
   */
  private async discoverSkills(
    rootDir: string,
    claudeDir: string,
    out: Artifact[],
  ): Promise<void> {
    const skillsDir = path.join(claudeDir, 'skills');
    if (!(await isDir(skillsDir))) return;

    for (const skillDir of await listDirs(skillsDir)) {
      const skillName = path.basename(skillDir);
      const files = await walkFiles(skillDir);
      // Locate the SKILL.md (case-insensitive) to extract shared metadata.
      const skillMd = files.find(
        (f) => path.basename(f).toLowerCase() === 'skill.md',
      );
      let skillMeta: Record<string, unknown> = {};
      if (skillMd) {
        const md = await readFileSafe(skillMd);
        if (md !== undefined) {
          const fm = parseFrontmatter(md);
          skillMeta = {
            skillName: typeof fm.data.name === 'string' ? fm.data.name : skillName,
            description: fm.data.description,
            frontmatter: fm.data,
          };
        }
      } else {
        skillMeta = { skillName };
      }

      for (const file of files) {
        const content = await readFileSafe(file);
        if (content === undefined) continue;
        const rel = relPosix(rootDir, file);
        const isManifest = file === skillMd;
        out.push({
          id: rel,
          agent: this.agent,
          kind: 'skill',
          path: rel,
          content,
          meta: {
            skill: skillName,
            isManifest,
            ...(isManifest ? skillMeta : { skillName }),
          },
        });
      }
    }
  }

  /** Executable/script hooks under `.claude/hooks/`. */
  private async discoverHooks(
    rootDir: string,
    claudeDir: string,
    out: Artifact[],
  ): Promise<void> {
    const hooksDir = path.join(claudeDir, 'hooks');
    if (!(await isDir(hooksDir))) return;
    for (const file of await walkFiles(hooksDir)) {
      const content = await readFileSafe(file);
      if (content === undefined) continue;
      const rel = relPosix(rootDir, file);
      out.push({
        id: rel,
        agent: this.agent,
        kind: 'hook',
        path: rel,
        content,
        meta: { source: 'hooks-dir', name: path.basename(file) },
      });
    }
  }

  /** `.claude/commands/*.md` slash commands. */
  private async discoverCommands(
    rootDir: string,
    claudeDir: string,
    out: Artifact[],
  ): Promise<void> {
    const commandsDir = path.join(claudeDir, 'commands');
    if (!(await isDir(commandsDir))) return;
    for (const file of await walkFiles(commandsDir)) {
      if (!file.toLowerCase().endsWith('.md')) continue;
      const content = await readFileSafe(file);
      if (content === undefined) continue;
      const rel = relPosix(rootDir, file);
      const fm = parseFrontmatter(content);
      const commandName = path.basename(file, path.extname(file));
      out.push({
        id: rel,
        agent: this.agent,
        kind: 'slash-command',
        path: rel,
        content,
        meta: {
          command: commandName,
          description: fm.data.description,
          frontmatter: fm.data,
        },
      });
    }
  }

  /**
   * `.claude/settings.json` — both the settings artifact itself and any
   * declarative `hooks` block it contains (surfaced as a separate hook
   * artifact for visibility, while the settings file remains the source of
   * truth that gets written into the sandbox).
   */
  private async discoverSettings(
    rootDir: string,
    claudeDir: string,
    out: Artifact[],
  ): Promise<void> {
    const settingsFile = path.join(claudeDir, 'settings.json');
    const content = await readFileSafe(settingsFile);
    if (content === undefined) return;
    const rel = relPosix(rootDir, settingsFile);

    let parsed: unknown;
    let parseError: string | undefined;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }

    const hooksBlock =
      parsed && typeof parsed === 'object' && 'hooks' in parsed
        ? (parsed as Record<string, unknown>).hooks
        : undefined;

    out.push({
      id: rel,
      agent: this.agent,
      kind: 'settings',
      path: rel,
      content,
      meta: {
        valid: parseError === undefined,
        ...(parseError ? { parseError } : {}),
        ...(hooksBlock !== undefined ? { hasInlineHooks: true } : {}),
      },
    });

    if (hooksBlock !== undefined) {
      out.push({
        id: `${rel}#hooks`,
        agent: this.agent,
        kind: 'hook',
        // Same on-disk path; applyConfigSet de-dupes by path so this virtual
        // hook artifact never causes a double write.
        path: rel,
        content: JSON.stringify(hooksBlock, null, 2),
        meta: { source: 'settings.json', virtual: true },
      });
    }
  }
}
