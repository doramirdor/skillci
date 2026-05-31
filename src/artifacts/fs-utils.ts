/**
 * Filesystem helpers used by the artifact parsers. All functions are robust to
 * missing files/dirs — a non-existent path yields an empty result rather than
 * throwing, so parsers can run against repos that simply don't use a given
 * agent's config layout.
 */
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';

/** Returns true if `p` exists and is a regular file. */
export async function isFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/** Returns true if `p` exists and is a directory. */
export async function isDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** Reads a UTF-8 file, returning `undefined` when it does not exist. */
export async function readFileSafe(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Recursively walks `dir` and returns absolute paths of all regular files.
 * Returns `[]` when `dir` does not exist. Symlinks are not followed.
 */
export async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await recurse(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
    out.sort();
  }
  await recurse(dir);
  out.sort();
  return out;
}

/** Lists immediate file entries (absolute paths) of `dir`; `[]` if missing. */
export async function listFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = entries
    .filter((e) => e.isFile())
    .map((e) => path.join(dir, e.name));
  out.sort();
  return out;
}

/** Lists immediate subdirectories (absolute paths) of `dir`; `[]` if missing. */
export async function listDirs(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name));
  out.sort();
  return out;
}

/**
 * Normalizes a filesystem path to a POSIX-style relative path from `root`.
 * Used so artifact `path`/`id` fields are stable and OS-independent.
 */
export function relPosix(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join('/');
}

/** Writes `content` to `dest`, creating parent directories as needed. */
export async function writeFileEnsured(dest: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content, 'utf8');
}
