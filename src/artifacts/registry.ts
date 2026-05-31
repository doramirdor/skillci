/**
 * The artifact parser registry and the public discover/apply/diff helpers that
 * the rest of SkillCI consumes.
 */
import * as path from 'node:path';
import {
  ArtifactSchema,
  ConfigSetSchema,
  type AgentKind,
  type Artifact,
  type ArtifactParser,
  type ConfigSet,
} from '../core/index.js';
import { ClaudeArtifactParser } from './claude-parser.js';
import { CursorArtifactParser } from './cursor-parser.js';
import { CodexArtifactParser } from './codex-parser.js';
import { writeFileEnsured } from './fs-utils.js';

/**
 * A registry mapping each {@link AgentKind} to its {@link ArtifactParser}.
 * Constructed with the three built-in parsers by default; additional parsers
 * can be registered to override or extend support.
 */
export class ArtifactParserRegistry {
  private readonly parsers = new Map<AgentKind, ArtifactParser>();

  constructor(parsers: ArtifactParser[] = defaultParsers()) {
    for (const parser of parsers) this.register(parser);
  }

  /** Registers (or replaces) the parser for its declared agent. */
  register(parser: ArtifactParser): void {
    this.parsers.set(parser.agent, parser);
  }

  /** Returns the parser for `agent`, or `undefined` when none is registered. */
  get(agent: AgentKind): ArtifactParser | undefined {
    return this.parsers.get(agent);
  }

  /** The agents this registry can parse. */
  agents(): AgentKind[] {
    return [...this.parsers.keys()];
  }

  /**
   * Discovers and normalizes a full {@link ConfigSet} for `agent` under
   * `rootDir`. Throws when no parser is registered for the agent. The result is
   * validated against the shared schema so downstream modules can trust it.
   */
  async discoverConfigSet(rootDir: string, agent: AgentKind): Promise<ConfigSet> {
    const parser = this.parsers.get(agent);
    if (!parser) {
      throw new Error(`No artifact parser registered for agent "${agent}"`);
    }
    const artifacts = await parser.discover(rootDir);
    const validated = artifacts.map((a) => ArtifactSchema.parse(a));
    return ConfigSetSchema.parse({ agent, artifacts: validated });
  }
}

/** The built-in parsers for all three MVP agents. */
export function defaultParsers(): ArtifactParser[] {
  return [
    new ClaudeArtifactParser(),
    new CursorArtifactParser(),
    new CodexArtifactParser(),
  ];
}

/** A process-wide default registry, used by the standalone helpers below. */
export const defaultRegistry = new ArtifactParserRegistry();

/**
 * Discovers and normalizes the {@link ConfigSet} for `agent` under `rootDir`,
 * using the default registry. Robust to missing files — a repo with no config
 * for the agent yields a `ConfigSet` with an empty `artifacts` array.
 */
export function discoverConfigSet(rootDir: string, agent: AgentKind): Promise<ConfigSet> {
  return defaultRegistry.discoverConfigSet(rootDir, agent);
}

/**
 * Writes every artifact in `configSet` into `targetDir` (a sandbox). Each
 * artifact's `path` is treated as relative to `targetDir`. Virtual artifacts
 * that share an on-disk path with a real artifact (e.g. the inline-hooks view
 * of `settings.json`) are de-duplicated so each path is written exactly once,
 * with the non-virtual artifact winning. Returns the POSIX paths written.
 */
export async function applyConfigSet(
  targetDir: string,
  configSet: ConfigSet,
): Promise<string[]> {
  // De-dupe by path; prefer non-virtual content for shared paths.
  const byPath = new Map<string, Artifact>();
  for (const artifact of configSet.artifacts) {
    const existing = byPath.get(artifact.path);
    const isVirtual = artifact.meta?.virtual === true;
    if (!existing) {
      byPath.set(artifact.path, artifact);
    } else {
      const existingVirtual = existing.meta?.virtual === true;
      // Replace only if the existing one is virtual and the new one isn't.
      if (existingVirtual && !isVirtual) byPath.set(artifact.path, artifact);
    }
  }

  const written: string[] = [];
  for (const [relPath, artifact] of byPath) {
    const dest = path.join(targetDir, relPath);
    await writeFileEnsured(dest, artifact.content);
    written.push(relPath);
  }
  written.sort();
  return written;
}

/** The nature of an artifact-level change between two config sets. */
export type ArtifactChangeStatus = 'added' | 'removed' | 'modified';

/** A single artifact-level difference between baseline and candidate. */
export interface ArtifactDiffEntry {
  /** The artifact id (stable, path-derived). */
  id: string;
  /** The artifact path. */
  path: string;
  /** Normalized artifact kind. */
  kind: Artifact['kind'];
  /** Whether the artifact was added, removed, or modified. */
  status: ArtifactChangeStatus;
}

/** The full diff between a baseline and candidate {@link ConfigSet}. */
export interface ConfigSetDiff {
  /** The agent both sides target. */
  agent: AgentKind;
  /** Per-artifact changes (sorted by id). */
  entries: ArtifactDiffEntry[];
  /** True when there are no changes. */
  unchanged: boolean;
}

/**
 * Computes the artifact-level diff between two config sets (candidate relative
 * to baseline). Artifacts are matched by `id`; content equality determines
 * `modified`. The two sets should target the same agent — when they differ the
 * candidate's agent is reported.
 */
export function diffConfigSets(baseline: ConfigSet, candidate: ConfigSet): ConfigSetDiff {
  const baseById = new Map(baseline.artifacts.map((a) => [a.id, a]));
  const candById = new Map(candidate.artifacts.map((a) => [a.id, a]));

  const entries: ArtifactDiffEntry[] = [];

  for (const [id, cand] of candById) {
    const base = baseById.get(id);
    if (!base) {
      entries.push({ id, path: cand.path, kind: cand.kind, status: 'added' });
    } else if (base.content !== cand.content) {
      entries.push({ id, path: cand.path, kind: cand.kind, status: 'modified' });
    }
  }

  for (const [id, base] of baseById) {
    if (!candById.has(id)) {
      entries.push({ id, path: base.path, kind: base.kind, status: 'removed' });
    }
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return {
    agent: candidate.agent,
    entries,
    unchanged: entries.length === 0,
  };
}
