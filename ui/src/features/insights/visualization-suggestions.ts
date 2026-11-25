import type { DataKind, QueryResult } from "./schema";
import type { WidgetDefinition } from "./widget-registry";

/** The most suggestions offered at once. */
const MAX_SUGGESTIONS = 3;

/** The value a visualization switcher uses for a definition: its type, or `plugin:<id>` for a plugin. */
export function visualizationValue(definition: Pick<WidgetDefinition, "type" | "id">): string {
  return definition.type === "plugin" ? `plugin:${definition.id}` : definition.type;
}

/** Visualizations that suit a metrics result, by how many series it holds and whether it carries histogram buckets. */
function metricCandidates(result: QueryResult): string[] {
  const series = result.series ?? [];
  if (series.length === 0) return [];
  const candidates: string[] = [];
  if (series.some((entry) => "le" in entry.labels)) candidates.push("plugin:distribution-heatmap");
  if (series.length === 1) candidates.push("stat", "timeseries");
  else if (series.length <= 8) candidates.push("timeseries", "bar");
  else if (series.length <= 40) candidates.push("bar", "heatmap");
  else candidates.push("heatmap", "plugin:status-grid");
  return candidates;
}

/** Visualizations that suit a records result: a table, or a map when it has latitude and longitude columns. */
function recordCandidates(result: QueryResult): string[] {
  const keys = new Set((result.records?.columns ?? []).map((column) => column.key.toLowerCase()));
  const hasPosition = (keys.has("lat") || keys.has("latitude")) && (keys.has("lon") || keys.has("longitude"));
  return hasPosition ? ["plugin:geo-heatmap", "plugin:record-table"] : ["plugin:record-table"];
}

/**
 * Visualizations to offer for a loaded result, best first. Suggestions never cross data kinds, so a metrics result
 * never offers a trace or record view. The widget's current visualization is left out, and at most three are returned.
 */
export function suggestVisualizations(
  result: QueryResult,
  definitions: readonly WidgetDefinition[],
  current: string | undefined,
  kind: DataKind,
): string[] {
  const sameKind = definitions.filter((definition) => definition.dataKind === kind);
  const byRule = kind === "metrics" ? metricCandidates(result) : kind === "records" ? recordCandidates(result) : [];
  const byScore = sameKind
    .filter((definition) => definition.suggest !== undefined && definition.suggest(result) >= 0.5)
    .map(visualizationValue);
  const offered = new Set<string>();
  for (const value of [...byRule, ...byScore]) {
    if (value === current) continue;
    if (!sameKind.some((definition) => visualizationValue(definition) === value)) continue;
    offered.add(value);
    if (offered.size === MAX_SUGGESTIONS) break;
  }
  return [...offered];
}
