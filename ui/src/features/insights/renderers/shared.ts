import { type CSSProperties } from "react";
import type { QueryResult, Threshold } from "../schema";

export type Trace = NonNullable<QueryResult["traces"]>[number];

export const MAX_ROWS = 100;

/** The API's "unknown" means a search result did not report a status. */
export function statusReported(status: string | undefined): boolean {
  const value = (status ?? "").trim().toLowerCase();
  return value !== "" && value !== "unknown";
}

/** Heatmap cells take the critical frame only; warning cells keep their fill and label. */
export function critical(threshold: Threshold | undefined) {
  return threshold?.status === "critical" ? "critical" : undefined;
}

/**
 * The frame is drawn in the cell's own text colour, which is the ink that reads on its fill. Page ink has only about
 * 1.2 to 1.3:1 against the critical fill, so it would not be visible.
 */
export function criticalStroke(threshold: Threshold | undefined): CSSProperties {
  return critical(threshold) ? ({ "--status-stroke-color": "currentColor" } as CSSProperties) : {};
}
