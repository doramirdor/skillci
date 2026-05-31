/**
 * Public API of the `artifacts` module: parsers that discover & normalize
 * coding-agent config into the shared `Artifact` / `ConfigSet` contracts, a
 * registry, and the discover/apply/diff helpers the rest of SkillCI consumes.
 */
export { ClaudeArtifactParser } from './claude-parser.js';
export { CursorArtifactParser } from './cursor-parser.js';
export { CodexArtifactParser } from './codex-parser.js';

export {
  ArtifactParserRegistry,
  defaultParsers,
  defaultRegistry,
  discoverConfigSet,
  applyConfigSet,
  diffConfigSets,
  type ArtifactChangeStatus,
  type ArtifactDiffEntry,
  type ConfigSetDiff,
} from './registry.js';

export {
  parseFrontmatter,
  parseFlatYaml,
  type ParsedFrontmatter,
} from './frontmatter.js';
