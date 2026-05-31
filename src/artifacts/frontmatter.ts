/**
 * A tiny, dependency-free frontmatter parser.
 *
 * Agent config files (Claude skills, Cursor `.mdc` rules) commonly prefix their
 * markdown body with a `---`-delimited YAML block. We don't pull in a full YAML
 * dependency (the baseline dep set is intentionally small); instead we parse the
 * flat `key: value` subset that these frontmatter blocks actually use, plus
 * simple inline arrays (`[a, b]`) and quoted scalars. This is deliberately
 * conservative: anything we can't confidently parse is preserved as a raw
 * string, and the original body text is always returned untouched.
 */

/** Result of splitting a document into frontmatter + body. */
export interface ParsedFrontmatter {
  /** Parsed frontmatter key/value pairs (empty object when none present). */
  data: Record<string, unknown>;
  /** The document body with the frontmatter block removed. */
  body: string;
  /** Whether a frontmatter block was actually found. */
  hasFrontmatter: boolean;
}

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Splits `content` into frontmatter `data` and `body`. When no `---` block is
 * present at the very start, returns the whole input as `body` with empty data.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { data: {}, body: content, hasFrontmatter: false };
  }
  const rawBlock = match[1] ?? '';
  const body = match[2] ?? '';
  return { data: parseFlatYaml(rawBlock), body, hasFrontmatter: true };
}

/**
 * Parses a flat YAML block (the frontmatter subset). Supports:
 * - `key: value` scalars (strings/numbers/booleans),
 * - `key:` followed by `- item` list entries,
 * - inline arrays `key: [a, b, c]`,
 * - quoted strings, and `#` line comments.
 * Unsupported/nested structures are kept as raw trimmed strings.
 */
export function parseFlatYaml(block: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    i += 1;
    const trimmed = stripComment(line).trimEnd();
    if (trimmed.trim() === '') continue;
    // Skip indented lines that aren't list items (we only parse top-level keys).
    if (/^\s/.test(line) && !/^\s*-\s/.test(line)) continue;

    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    if (key === '') continue;
    const rest = trimmed.slice(colon + 1).trim();

    if (rest === '') {
      // Possible block list: gather subsequent `- item` lines.
      const items: unknown[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? '';
        const listMatch = /^\s*-\s+(.*)$/.exec(stripComment(next));
        if (!listMatch) break;
        items.push(coerceScalar((listMatch[1] ?? '').trim()));
        i += 1;
      }
      data[key] = items;
    } else {
      data[key] = parseValue(rest);
    }
  }
  return data;
}

/** Removes a trailing `#` comment that is not inside quotes. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let idx = 0; idx < line.length; idx += 1) {
    const ch = line[idx];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      // Only treat as a comment if preceded by whitespace or at line start.
      const prev = idx > 0 ? line[idx - 1] : ' ';
      if (prev === ' ' || prev === '\t' || idx === 0) return line.slice(0, idx);
    }
  }
  return line;
}

/** Parses a scalar-or-inline-array value. */
function parseValue(raw: string): unknown {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => coerceScalar(part.trim()));
  }
  return coerceScalar(raw);
}

/** Coerces an unquoted scalar to boolean/number when unambiguous. */
function coerceScalar(raw: string): unknown {
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  if (raw !== '' && /^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isNaN(n)) return n;
  }
  return raw;
}
