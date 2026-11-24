import { variableSourceDependencies, type Dashboard } from "./schema";

/** A `{{name}}` placeholder in a query or a selector. Tooltip queries are tooltip-local and are not scanned. */
const placeholder = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export function placeholderNames(text: string): string[] {
  return [...text.matchAll(placeholder)].map((match) => match[1]);
}

/** One place on the dashboard that reads a variable: a widget, or another variable's source. */
export type VariableUse =
  | { kind: "widget"; widgetId: string; widgetTitle: string }
  | { kind: "variable"; variableName: string };

type Bindings = readonly { source?: string; variable?: string }[] | undefined;

/** Variable bindings only; a constant or label binding reads no dashboard variable. */
function readsVariable(bindings: Bindings, name: string): boolean {
  return (bindings ?? []).some((binding) => binding.source === "variable" && binding.variable === name);
}

/**
 * Where a dashboard reads a variable. Scans query placeholders, saved query and event bindings, saved tooltip
 * bindings, selection bindings, drilldowns that link back to this dashboard, and other variables' sources.
 */
export function variableReferences(dashboard: Dashboard, name: string): VariableUse[] {
  const uses: VariableUse[] = [];
  for (const widget of dashboard.widgets) {
    const tooltipSource = widget.options?.tooltipView?.source;
    const reads =
      placeholderNames(widget.query).includes(name) ||
      readsVariable(widget.queryRef?.bindings, name) ||
      readsVariable(widget.annotationSource?.queryRef.bindings, name) ||
      (tooltipSource?.type === "saved" && readsVariable(tooltipSource.ref.bindings, name)) ||
      (widget.selectionBindings ?? []).some((binding) => binding.variable === name) ||
      (widget.drilldowns ?? []).some((drilldown) =>
        // Application links carry no bindings and open no dashboard, so only dashboard drilldowns count.
        "dashboardId" in drilldown && drilldown.dashboardId === dashboard.id && (drilldown.bindings ?? []).some((binding) => binding.variable === name),
      );
    if (reads) uses.push({ kind: "widget", widgetId: widget.id, widgetTitle: widget.title });
  }
  for (const variable of dashboard.variables ?? []) {
    if (variable.name === name || !variable.source) continue;
    if (variableSourceDependencies(variable.source).includes(name)) uses.push({ kind: "variable", variableName: variable.name });
  }
  return uses;
}

/**
 * The dashboard with every rename applied at once, so a swap of two names works. Only references on this dashboard
 * change. Links on other dashboards keep the names they were written with, and the caller says so.
 */
export function rewriteVariableReferences(dashboard: Dashboard, renames: Readonly<Record<string, string>>): Dashboard {
  const keys = Object.keys(renames).filter((from) => renames[from] !== from);
  if (keys.length === 0) return dashboard;
  const map = (name: string) => (Object.prototype.hasOwnProperty.call(renames, name) ? renames[name] : name);
  const mapText = (text: string) => text.replace(placeholder, (_match, name: string) => `{{${map(name)}}}`);
  const mapBindings = <T extends { source?: string; variable?: string }>(bindings: readonly T[] | undefined) =>
    bindings?.map((binding) => (binding.source === "variable" && binding.variable !== undefined ? { ...binding, variable: map(binding.variable) } : binding));
  const mapSelection = <T extends { variable: string }>(bindings: readonly T[] | undefined) =>
    bindings?.map((binding) => ({ ...binding, variable: map(binding.variable) }));

  const next = structuredClone(dashboard);
  for (const widget of next.widgets) {
    widget.query = mapText(widget.query);
    if (widget.queryRef) widget.queryRef.bindings = mapBindings(widget.queryRef.bindings);
    if (widget.annotationSource) widget.annotationSource.queryRef.bindings = mapBindings(widget.annotationSource.queryRef.bindings);
    if (widget.selectionBindings) widget.selectionBindings = mapSelection(widget.selectionBindings);
    for (const drilldown of widget.drilldowns ?? []) {
      if ("dashboardId" in drilldown && drilldown.dashboardId === dashboard.id) drilldown.bindings = mapSelection(drilldown.bindings);
    }
    const source = widget.options?.tooltipView?.source;
    if (source?.type === "saved" && source.ref.bindings) source.ref.bindings = mapBindings(source.ref.bindings);
  }
  for (const variable of next.variables ?? []) {
    const source = variable.source;
    if (!source) continue;
    if (source.type === "labelValues" && source.selector !== undefined) source.selector = mapText(source.selector);
    if (source.type === "savedQuery") source.queryRef.bindings = mapBindings(source.queryRef.bindings);
  }
  return next;
}
