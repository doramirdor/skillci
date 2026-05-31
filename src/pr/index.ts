/**
 * Public barrel for the `pr` module.
 *
 * Opens a GitHub pull request (via the `gh` CLI) to promote a candidate config
 * set — but ONLY when the comparison warrants it (`shouldPromote` is true).
 * DRY-RUN by default: prints the git/gh plan instead of executing. Domain types
 * live in `../core`.
 */
export {
  openPromotionPR,
  isGhAvailable,
  buildPromotionPlan,
  deriveBranchName,
  safeRelativePath,
  slugify,
  type OpenPromotionPRArgs,
  type OpenPromotionPROptions,
  type PromotionResult,
  type PlannedCommand,
  type PlannedFileWrite,
} from './pr.js';
