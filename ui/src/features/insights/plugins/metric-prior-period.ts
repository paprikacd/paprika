import { alignPriorPeriod, type ObservationWindow } from "../time-window";
import type { MetricSeries } from "./rich-metrics-data";

/** A stacked boundary is meaningful only when every displayed contribution is
 * present, uniquely matched and recorded in the preceding window. Directional
 * series are independent, so uniquely matched directions can be shown alone. */
export function metricPriorPeriod(current: MetricSeries[], previous: MetricSeries[], window: ObservationWindow, directional: boolean) {
  const matched = alignPriorPeriod(current, previous, window);
  if (!directional && matched.length !== current.length) return [];
  return matched;
}
