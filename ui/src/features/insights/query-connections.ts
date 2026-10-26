import { MAX_DASHBOARD_VARIABLES, widgetKind, type Dashboard, type QueryResult, type SavedQueryBinding, type SavedQueryParameter, type TooltipQuerySource, type Widget } from "./schema";
import type { QueryFetcher } from "./query";
import { savedQueryParameterValue } from "./saved-queries";

export interface QueryFields {
  seriesCount: number;
  labels: { name: string; samples: string[]; present: number }[];
  partial: boolean;
}
export interface QueryFieldSnapshot {
  widgetId: string;
  key: string;
  fetcher: QueryFetcher;
  fields?: QueryFields;
}
export function queryConnectionKey(widget: Widget, range: { start: number; end: number }) {
  return JSON.stringify([widget.id, widget.providerId, widget.query, widget.queryRef, widgetKind(widget), range.start, range.end]);
}
/** Describes already-loaded graph results, without requesting or copying history. */
export function queryFields(result: QueryResult): QueryFields {
  const series = (result.series ?? []).slice(0, 1000);
  const labels = new Map<string, { name: string; samples: string[]; present: number }>();
  let partial = !!result.truncated || (result.series?.length ?? 0) > series.length;
  for (const entry of series) for (const [name, value] of Object.entries(entry.labels)) {
    if (name === "__name__" || !name || name.length > 128) continue;
    let label = labels.get(name);
    if (!label) {
      if (labels.size >= 64) { partial = true; continue; }
      label = { name, samples: [], present: 0 }; labels.set(name, label);
    }
    label.present++;
    if (label.samples.length < 3 && !label.samples.includes(value)) label.samples.push(value);
  }
  return { seriesCount: series.length, labels: [...labels.values()].sort((a, b) => a.name.localeCompare(b.name)), partial };
}
export interface ConnectionContext {
  variables?: Dashboard["variables"];
  values?: Record<string, string>;
  fields?: QueryFields;
  parentBindings?: SavedQueryBinding[];
  allowObservation?: boolean;
}
export interface ConnectionSuggestion { binding: SavedQueryBinding; label: string; reason: string }
function accepts(parameter: SavedQueryParameter, value: unknown) {
  try {
    if (typeof value !== "string" && typeof value !== "number") return false;
    if (parameter.type === "string") return typeof value === "string";
    savedQueryParameterValue(parameter, String(value)); return true;
  } catch { return false; }
}
export function suggestParameterConnection(parameter: SavedQueryParameter, context: ConnectionContext): ConnectionSuggestion | undefined {
  const variables = context.variables ?? [];
  const variableValue = (name: string) => context.values?.[name] ?? variables.find((item) => item.name === name)?.defaultValue;
  const inherited = context.parentBindings?.find((item) => item.parameter === parameter.name);
  if (inherited && ((inherited.source === "constant" && accepts(parameter, inherited.value)) ||
    (inherited.source === "variable" && variables.some((item) => item.name === inherited.variable) && (parameter.type === "string" || accepts(parameter, variableValue(inherited.variable)))))) {
    return { binding: { ...inherited }, label: "Use graph connection", reason: inherited.source === "variable" ? `Dashboard variable: ${inherited.variable}` : `Fixed value: ${JSON.stringify(inherited.source === "constant" ? inherited.value : "")}` };
  }
  const label = context.fields?.labels.find((item) => item.name === parameter.name);
  if (context.allowObservation && label && parameter.type === "string")
    return { binding: { parameter: parameter.name, source: "label", label: label.name }, label: `Use graph label: ${label.name}`, reason: label.samples.map((value) => JSON.stringify(value)).join(", ") };
  const variable = variables.find((item) => item.name === parameter.name);
  if (variable && (parameter.type === "string" || accepts(parameter, variableValue(variable.name))))
    return { binding: { parameter: parameter.name, source: "variable", variable: variable.name }, label: `Use dashboard variable: ${variable.name}`, reason: variableValue(variable.name) === undefined ? "Uses the dashboard’s selected value." : `Current value: ${variableValue(variable.name)}` };
  if (context.allowObservation && ((parameter.type === "number" && ["value", "timestamp"].includes(parameter.name)) || (parameter.type === "string" && parameter.name === "series")))
    return { binding: { parameter: parameter.name, source: "field", field: parameter.name as "value" | "timestamp" | "series" }, label: `Use observation ${parameter.name}`, reason: parameter.name === "timestamp" ? "Exact observation time in Unix seconds." : "Uses the selected observation, without rounding." };
}
export function tooltipMappingSuggestions(source: TooltipQuerySource, fields?: QueryFields): NonNullable<TooltipQuerySource["bindings"]> {
  const names = [...new Set([...source.query.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((match) => match[1]))];
  return names.filter((name) => name.length <= 64 && !source.bindings?.some((item) => item.variable === name)).flatMap<NonNullable<TooltipQuerySource["bindings"]>[number]>((variable) => {
    const labelExists = fields?.labels.some((label) => label.name === variable);
    // A template alone cannot disambiguate a label from an observation field.
    if (labelExists && ["value", "timestamp", "series"].includes(variable)) return [];
    if (labelExists) return [{ variable, label: variable }];
    if (["value", "timestamp", "series"].includes(variable)) return [{ variable, field: variable as "value" | "timestamp" | "series" }];
    return [];
  }).slice(0, Math.max(0, MAX_DASHBOARD_VARIABLES - (source.bindings?.length ?? 0)));
}
