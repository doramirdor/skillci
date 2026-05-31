/**
 * Public barrel for the `report` module.
 *
 * Renders a baseline-vs-candidate `Comparison` (plus the underlying
 * `RunOutcome`s) into stable JSON, clean Markdown, and a colorized terminal
 * summary. All renderers are pure, offline, and deterministic given a pinned
 * `generatedAt`. Domain types live in `../core`.
 */
export {
  renderJsonReport,
  renderMarkdownReport,
  renderTerminalReport,
} from './report.js';

export type {
  ReportOptions,
  TerminalReportOptions,
  JsonReport,
  JsonTaskRow,
  CostTotals,
  ObjectiveTotals,
  TaskClassification,
} from './report.js';
