// Standalone verification script (no test runner needed). Exits non-zero on
// the first failed assertion so it can back a `command` objective check.
import assert from 'node:assert/strict';
import { slugify } from './src/slugify.js';

assert.equal(slugify('Hello, World!'), 'hello-world');
assert.equal(slugify('  Spaced  Out '), 'spaced-out');
assert.equal(slugify('Multiple---Dashes'), 'multiple-dashes');
assert.equal(slugify('UPPER and lower'), 'upper-and-lower');

console.log('slugify: all checks passed');
