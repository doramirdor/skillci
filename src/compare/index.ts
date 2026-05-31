/**
 * Public barrel for the `compare` module.
 *
 * The comparator aggregates baseline-vs-candidate scores into deltas and a
 * `Verdict`, and decides promotability. Domain types live in `../core`.
 */
export { compareOutcomes, shouldPromote } from './compare.js';
