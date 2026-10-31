import { seriesName, type Point, type Series } from "./chart-data"
import { interpolateQueryLiterals } from "./drilldown"
import { validTimestamp } from "./widget-context"
import type { TooltipQuerySource } from "./schema"

/** Authoring validation uses typed placeholders without accessing a provider. */
export function validateTooltipQueryTemplate(source: TooltipQuerySource): void {
  interpolateQueryLiterals(source.query, Object.fromEntries((source.bindings ?? []).map(binding => [
    binding.variable,
    "field" in binding && binding.field !== "series" ? 1 : "validation",
  ])))
}

/** An explicit point is authoritative; null/missing context must never fall back to a newer sample. */
export function resolveTooltipQuery(source: TooltipQuerySource, series: Series, point?: Point): string {
  const variables: Record<string, string | number> = Object.create(null)
  for (const binding of source.bindings ?? []) {
    if ("label" in binding) {
      if (!Object.hasOwn(series.labels, binding.label))
        throw new Error(`This signal has no label “${binding.label}” for tooltip variable “${binding.variable}”.`)
      variables[binding.variable] = series.labels[binding.label]
    } else if (binding.field === "series") {
      variables[binding.variable] = seriesName(series, 0)
    } else if (binding.field === "value") {
      if (typeof point?.value !== "number" || !Number.isFinite(point.value))
        throw new Error(`This observation has no finite value for tooltip variable “${binding.variable}”.`)
      variables[binding.variable] = point.value
    } else {
      if (!point || !validTimestamp(point.timestamp))
        throw new Error(`This observation has no valid timestamp for tooltip variable “${binding.variable}”.`)
      variables[binding.variable] = point.timestamp / 1000
    }
  }
  try {
    return interpolateQueryLiterals(source.query, variables)
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : "The tooltip query variables are invalid.")
      .replaceAll("dashboard variable", "tooltip variable"))
  }
}
