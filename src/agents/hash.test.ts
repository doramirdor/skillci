import { describe, expect, it } from 'vitest';
import { SeededRandom, hashToSeed, seedStringFor } from './hash.js';
import { makeConfigSet, makeTask } from './test-helpers.js';

describe('hashToSeed', () => {
  it('is deterministic for the same input', () => {
    expect(hashToSeed('hello')).toBe(hashToSeed('hello'));
  });

  it('differs for different inputs', () => {
    expect(hashToSeed('a')).not.toBe(hashToSeed('b'));
  });

  it('returns an unsigned 32-bit integer', () => {
    const s = hashToSeed('anything');
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('SeededRandom', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new SeededRandom(123);
    const b = new SeededRandom(123);
    const seqA = [a.next(), a.next(), a.next()];
    const seqB = [b.next(), b.next(), b.next()];
    expect(seqA).toEqual(seqB);
  });

  it('produces floats in [0, 1)', () => {
    const r = new SeededRandom(42);
    for (let i = 0; i < 100; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('intBetween stays within bounds inclusive', () => {
    const r = new SeededRandom(7);
    for (let i = 0; i < 100; i++) {
      const v = r.intBetween(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
    }
  });

  it('tolerates a zero seed without getting stuck', () => {
    const r = new SeededRandom(0);
    expect(r.next()).not.toBe(r.next());
  });
});

describe('seedStringFor', () => {
  it('is stable regardless of artifact ordering', () => {
    const task = makeTask();
    const a = makeConfigSet('claude-code', ['one', 'two', 'three']);
    const reordered = {
      ...a,
      artifacts: [...a.artifacts].reverse(),
    };
    expect(seedStringFor(task, a)).toBe(seedStringFor(task, reordered));
  });

  it('changes when config content changes', () => {
    const task = makeTask();
    const a = makeConfigSet('claude-code', ['baseline']);
    const b = makeConfigSet('claude-code', ['candidate']);
    expect(seedStringFor(task, a)).not.toBe(seedStringFor(task, b));
  });

  it('changes when task id changes', () => {
    const cfg = makeConfigSet('claude-code', ['x']);
    expect(seedStringFor(makeTask({ id: 't1' }), cfg)).not.toBe(
      seedStringFor(makeTask({ id: 't2' }), cfg),
    );
  });
});
