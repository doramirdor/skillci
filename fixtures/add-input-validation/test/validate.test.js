import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAge } from '../src/validate.js';

test('accepts a valid non-negative integer', () => {
  assert.equal(validateAge(30), 30);
  assert.equal(validateAge(0), 0);
});

test('rejects non-number input', () => {
  assert.throws(() => validateAge('30'), TypeError);
  assert.throws(() => validateAge(null), TypeError);
});

test('rejects negative numbers', () => {
  assert.throws(() => validateAge(-1), RangeError);
});

test('rejects non-integers', () => {
  assert.throws(() => validateAge(3.5), RangeError);
});
