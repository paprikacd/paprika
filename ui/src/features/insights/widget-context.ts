import type { Drilldown, QueryResult, Widget } from "./schema";
import type { DrilldownContext } from "./drilldown";

type Series = NonNullable<QueryResult["series"]>[number];
type Trace = NonNullable<QueryResult["traces"]>[number];

/** JavaScript dates have a narrower valid range than finite IEEE numbers. */
export const validTimestamp = (value: number) =>
  Number.isFinite(value) && Math.abs(value) <= 8.64e15;

export function metricContext(
  series: Series,
  index: number,
  latestScrape = false,
): DrilldownContext {
  const labels = Object.entries(series.labels);
  const name =
    series.name ||
    labels.map(([key, value]) => `${key}=${value}`).join(", ") ||
    `Series ${index + 1}`;
  const point = series.points.reduce<Series["points"][number] | undefined>(
    (latest, current) =>
      validTimestamp(current.timestamp) &&
      (latestScrape ||
        (typeof current.value === "number" &&
          Number.isFinite(current.value))) &&
      (!latest || current.timestamp >= latest.timestamp)
        ? current
        : latest,
    undefined,
  );
  return {
    series: name,
    labels: series.labels,
    value:
      typeof point?.value === "number" && Number.isFinite(point.value)
        ? point.value
        : null,
  };
}

export function traceContext(trace: Trace): DrilldownContext {
  return {
    series: `${trace.service || "Unknown service"} · ${trace.operation || trace.traceId}`,
    labels: {
      traceId: trace.traceId,
      service: trace.service,
      operation: trace.operation,
      status: trace.status,
    },
    value:
      Number.isFinite(trace.durationMs) && trace.durationMs >= 0
        ? trace.durationMs
        : null,
  };
}

/** Labels, including empty values, form identity; object property order does not. */
export function contextKey(context: DrilldownContext): string {
  return JSON.stringify([
    context.series,
    Object.entries(context.labels ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ]);
}

export function widgetContexts(widget: Widget, result?: QueryResult) {
  if (!result) return [];
  return widget.type === "traces" || widget.dataKind === "traces"
    ? (result.traces ?? []).map(traceContext)
    : (result.series ?? []).map((series, index) =>
        metricContext(series, index, widget.type === "heatmap"),
      );
}

export function drilldownContextReason(
  link: Drilldown,
  context: DrilldownContext,
): string | undefined {
  for (const binding of link.bindings ?? []) {
    if (binding.source === "constant") continue;
    if (
      context.series === undefined &&
      context.labels === undefined &&
      context.value === undefined
    )
      return "Select a series or row first";
    if (
      binding.source === "label" &&
      (!context.labels || !Object.hasOwn(context.labels, binding.value!))
    )
      return `Selected signal has no label “${binding.value}”`;
    if (binding.source === "series" && context.series === undefined)
      return "Selected signal has no series name";
    if (
      binding.source === "value" &&
      (typeof context.value !== "number" || !Number.isFinite(context.value))
    )
      return "Selected signal has no finite value";
  }
}
