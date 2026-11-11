import { createContext, useContext } from "react";
import { latestPoint } from "./chart-data";
import { thresholdForValue } from "./chart-renderer-shared";
import type { QueryResult, Threshold, Widget } from "./schema";

/**
 * One attention verdict per tile. Only author-declared statuses count: a threshold's `status` (warning or critical)
 * is the single source of a breach, and a colour-only threshold never raises attention. Nothing here infers health
 * from a value, so unknown or missing data is never reported as healthy.
 *
 * Precedence, highest first: critical, warning, failed, stale, partial, ok, pending. A breach on the last valid
 * sample is still reported when a later refresh fails, because the author's band is what the tile last showed.
 */
export const ATTENTION_STATES = ["critical", "warning", "failed", "stale", "partial", "ok", "pending"] as const;
export type AttentionState = (typeof ATTENTION_STATES)[number];
/** The states that draw a rail and a status chip. */
export type AttentionLevel = Extract<AttentionState, "critical" | "warning">;

export interface WidgetAttention {
  state: AttentionState;
  /** The threshold band that matched the displayed value, when the widget shows a single value. */
  band?: Threshold;
  /** Whether the displayed sample is older than the widget's author-declared `staleAfterSeconds`. */
  stale: boolean;
  /** Age of the displayed sample at the range end, in seconds, when it can be measured. */
  ageSeconds?: number;
}

/** The sample a single value displays: the first series' latest valid observation, as the stat renderer reads it. */
function displayedSample(result: QueryResult) {
  for (const series of result.series ?? []) {
    const point = latestPoint(series);
    if (point) return { value: point.value, timestamp: point.timestamp };
  }
  return undefined;
}

/**
 * The attention of one widget from its query outcome. `rangeEnd` is in Unix milliseconds, matching the dashboard
 * window; without it a sample cannot be aged, so it is never stale.
 */
export function widgetAttention(
  widget: Pick<Widget, "type" | "options">,
  result: QueryResult | undefined,
  error: unknown,
  rangeEnd: number | undefined,
): WidgetAttention {
  const thresholds = widget.options?.thresholds;
  const displayed = widget.type === "stat" && result ? displayedSample(result) : undefined;
  const band = displayed ? thresholdForValue(displayed.value, thresholds) : undefined;
  const ageSeconds = displayed && rangeEnd !== undefined && Number.isFinite(rangeEnd)
    ? Math.max(0, (rangeEnd - displayed.timestamp) / 1000)
    : undefined;
  const staleAfter = widget.options?.staleAfterSeconds;
  const stale = ageSeconds !== undefined && staleAfter !== undefined && ageSeconds > staleAfter;
  const base = { band, stale, ageSeconds };
  if (band?.status === "critical" || band?.status === "warning") return { ...base, state: band.status };
  if (error) return { ...base, state: "failed" };
  if (!result) return { ...base, state: "pending" };
  if (stale) return { ...base, state: "stale" };
  if (result.truncated) return { ...base, state: "partial" };
  return { ...base, state: "ok" };
}

/** The state alone, for callers that need only the verdict. */
export function evaluateWidgetAttention(
  widget: Pick<Widget, "type" | "options">,
  result: QueryResult | undefined,
  error: unknown,
  rangeEnd: number | undefined,
): AttentionState {
  return widgetAttention(widget, result, error, rangeEnd).state;
}

/** Whether a state draws the rail and a status chip. */
export function isAttentionLevel(state: AttentionState): state is AttentionLevel {
  return state === "critical" || state === "warning";
}

/**
 * The verdict a canvas tile computed for its widget. Renderers under that tile read it instead of evaluating again.
 * Embedded renderers (tooltips) do not inherit it, because they show a different widget.
 */
export const WidgetAttentionContext = createContext<WidgetAttention | undefined>(undefined);
export function useWidgetAttentionContext() {
  return useContext(WidgetAttentionContext);
}
