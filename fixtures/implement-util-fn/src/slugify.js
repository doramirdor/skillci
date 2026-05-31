/**
 * Convert an arbitrary string into a URL-friendly slug.
 *
 * NOTE (fixture seed): unimplemented. The agent must implement this so that
 * `node check.js` exits 0.
 *
 * Expected behavior:
 *   "Hello, World!"  -> "hello-world"
 *   "  Spaced  Out " -> "spaced-out"
 *   "Café del Mar"   -> "cafe-del-mar"  (accents stripped is acceptable; at
 *                                        minimum non-alphanumerics collapse to '-')
 */
export function slugify(input) {
  throw new Error('not implemented');
}
