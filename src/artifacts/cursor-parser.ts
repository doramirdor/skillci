/**
 * ArtifactParser for Cursor config.
 *
 * Discovers and normalizes:
 * - `.cursor/rules/**\/*.mdc` (rule)  — modern scoped rules with frontmatter
 *   (`description`, `globs`, `alwaysApply`).
 * - `.cursorrules` (rule)            — the legacy single-file instruction.
 */
import * as path from 'node:path';
import type { Artifact, ArtifactParser, AgentKind } from '../core/index.js';
import { parseFrontmatter } from './frontmatter.js';
import { isDir, readFileSafe, relPosix, walkFiles } from './fs-utils.js';

export class CursorArtifactParser implements ArtifactParser {
  readonly agent: AgentKind = 'cursor';

  async discover(rootDir: string): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];
    await this.discoverMdcRules(rootDir, artifacts);
    await this.discoverLegacyRules(rootDir, artifacts);
    artifacts.sort((a, b) => a.id.localeCompare(b.id));
    return artifacts;
  }

  /** `.cursor/rules/**\/*.mdc` modern rules. */
  private async discoverMdcRules(rootDir: string, out: Artifact[]): Promise<void> {
    const rulesDir = path.join(rootDir, '.cursor', 'rules');
    if (!(await isDir(rulesDir))) return;
    for (const file of await walkFiles(rulesDir)) {
      if (!file.toLowerCase().endsWith('.mdc')) continue;
      const content = await readFileSafe(file);
      if (content === undefined) continue;
      const rel = relPosix(rootDir, file);
      const fm = parseFrontmatter(content);
      out.push({
        id: rel,
        agent: this.agent,
        kind: 'rule',
        path: rel,
        content,
        meta: {
          source: 'mdc',
          name: path.basename(file, '.mdc'),
          description: fm.data.description,
          globs: fm.data.globs,
          alwaysApply: fm.data.alwaysApply,
          frontmatter: fm.data,
        },
      });
    }
  }

  /** Legacy `.cursorrules` single file at the repo root. */
  private async discoverLegacyRules(rootDir: string, out: Artifact[]): Promise<void> {
    const file = path.join(rootDir, '.cursorrules');
    const content = await readFileSafe(file);
    if (content === undefined) return;
    out.push({
      id: '.cursorrules',
      agent: this.agent,
      kind: 'rule',
      path: '.cursorrules',
      content,
      meta: { source: 'cursorrules', legacy: true },
    });
  }
}
