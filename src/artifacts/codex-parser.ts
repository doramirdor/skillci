/**
 * ArtifactParser for Codex config.
 *
 * Discovers and normalizes:
 * - `AGENTS.md` (instruction)            — the standing instructions file.
 * - codex config files (settings)        — `.codex/config.toml`,
 *   `.codex/config.json`, and a root `codex.toml`/`codex.json` when present.
 */
import * as path from 'node:path';
import type { Artifact, ArtifactParser, AgentKind } from '../core/index.js';
import { readFileSafe, relPosix } from './fs-utils.js';

/** Candidate codex config file locations, relative to the repo root. */
const CODEX_CONFIG_CANDIDATES = [
  '.codex/config.toml',
  '.codex/config.json',
  '.codex/config.yaml',
  '.codex/config.yml',
  'codex.toml',
  'codex.json',
];

export class CodexArtifactParser implements ArtifactParser {
  readonly agent: AgentKind = 'codex';

  async discover(rootDir: string): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];
    await this.discoverInstruction(rootDir, artifacts);
    await this.discoverConfig(rootDir, artifacts);
    artifacts.sort((a, b) => a.id.localeCompare(b.id));
    return artifacts;
  }

  /** Root `AGENTS.md` standing instructions. */
  private async discoverInstruction(rootDir: string, out: Artifact[]): Promise<void> {
    const file = path.join(rootDir, 'AGENTS.md');
    const content = await readFileSafe(file);
    if (content === undefined) return;
    out.push({
      id: 'AGENTS.md',
      agent: this.agent,
      kind: 'instruction',
      path: 'AGENTS.md',
      content,
      meta: { source: 'AGENTS.md' },
    });
  }

  /** Codex config files (settings). */
  private async discoverConfig(rootDir: string, out: Artifact[]): Promise<void> {
    for (const candidate of CODEX_CONFIG_CANDIDATES) {
      const file = path.join(rootDir, candidate);
      const content = await readFileSafe(file);
      if (content === undefined) continue;
      const rel = relPosix(rootDir, file);
      const ext = path.extname(file).toLowerCase();
      let valid = true;
      let parseError: string | undefined;
      if (ext === '.json') {
        try {
          JSON.parse(content);
        } catch (err) {
          valid = false;
          parseError = err instanceof Error ? err.message : String(err);
        }
      }
      out.push({
        id: rel,
        agent: this.agent,
        kind: 'settings',
        path: rel,
        content,
        meta: {
          source: 'codex-config',
          format: ext.replace('.', '') || 'unknown',
          valid,
          ...(parseError ? { parseError } : {}),
        },
      });
    }
  }
}
