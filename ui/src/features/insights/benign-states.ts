/**
 * The plain copy a widget shows when a reading is missing, a result is empty, a sample is old, or a list is cut to a
 * series cap. Renderers import these strings rather than writing their own, so each state reads the same in every
 * chart. Truncation copy lives in truncation.ts and is re-exported here.
 */
export { limitFact, sourceNotice, truncationNote } from "./truncation";

/** A reading, cell or sample that is not there. */
export const NO_DATA = "No data";

/** An empty result for a time range with no recorded observations. */
export const EMPTY_RANGE = {
  title: "No data in this time range",
  hint: "Try a wider time range or adjust this widget’s query.",
} as const;

/** An empty result whose source was partial or capped. */
export const EMPTY_INCOMPLETE = {
  title: "No observations returned",
  partialHint: "The provider response may be incomplete. Narrow the query or check the data source.",
  contextualHint: "No observations were included in this incomplete response.",
} as const;

/** The chip for a stat whose response was partial. Incomplete, not breached. */
export const PARTIAL_CHIP = "Partial";

/** The chip for a stat whose latest valid sample is old. A stale value is old, not bad. */
export function staleChip(age: string): string {
  return `Stale · ${age}`;
}

/** The full sentence behind the stale chip. */
export function staleDetail(age: string): string {
  return `Last valid sample: ${age} before range end.`;
}

/** The note for a series list cut to a cap. Every chart uses this wording. */
export function seriesShown(shown: number, total: number): string {
  return `Showing ${shown} of ${total} series`;
}
