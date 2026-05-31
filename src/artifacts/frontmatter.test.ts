import { describe, it, expect } from 'vitest';
import { parseFrontmatter, parseFlatYaml } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('returns the whole input as body when no frontmatter is present', () => {
    const res = parseFrontmatter('# Just markdown\n\nhello');
    expect(res.hasFrontmatter).toBe(false);
    expect(res.data).toEqual({});
    expect(res.body).toBe('# Just markdown\n\nhello');
  });

  it('splits a leading --- block from the body', () => {
    const src = '---\nname: my-skill\ndescription: Does a thing\n---\nBody text here';
    const res = parseFrontmatter(src);
    expect(res.hasFrontmatter).toBe(true);
    expect(res.data.name).toBe('my-skill');
    expect(res.data.description).toBe('Does a thing');
    expect(res.body).toBe('Body text here');
  });

  it('handles CRLF line endings', () => {
    const src = '---\r\nname: x\r\n---\r\nbody';
    const res = parseFrontmatter(src);
    expect(res.hasFrontmatter).toBe(true);
    expect(res.data.name).toBe('x');
    expect(res.body).toBe('body');
  });

  it('does not treat a non-leading --- as frontmatter', () => {
    const src = 'intro\n---\nname: x\n---\n';
    const res = parseFrontmatter(src);
    expect(res.hasFrontmatter).toBe(false);
    expect(res.body).toBe(src);
  });
});

describe('parseFlatYaml', () => {
  it('coerces booleans and numbers', () => {
    const data = parseFlatYaml('alwaysApply: true\nweight: 3\nratio: 0.5\noff: false');
    expect(data.alwaysApply).toBe(true);
    expect(data.off).toBe(false);
    expect(data.weight).toBe(3);
    expect(data.ratio).toBe(0.5);
  });

  it('parses inline arrays', () => {
    const data = parseFlatYaml('globs: [src/**, "*.ts"]');
    expect(data.globs).toEqual(['src/**', '*.ts']);
  });

  it('parses block lists', () => {
    const data = parseFlatYaml('globs:\n  - src/**\n  - test/**');
    expect(data.globs).toEqual(['src/**', 'test/**']);
  });

  it('strips quotes and trailing comments', () => {
    const data = parseFlatYaml('name: "hello" # a greeting\nother: world');
    expect(data.name).toBe('hello');
    expect(data.other).toBe('world');
  });

  it('does not strip a # inside a quoted value', () => {
    const data = parseFlatYaml('tag: "a#b"');
    expect(data.tag).toBe('a#b');
  });

  it('ignores nested/indented non-list lines', () => {
    const data = parseFlatYaml('top: value\n  nested: ignored');
    expect(data.top).toBe('value');
    expect(data.nested).toBeUndefined();
  });
});
