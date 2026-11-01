import { ZodError, type ZodIssue } from 'zod';
import { widgetKind, widgetSchema, type DataKind, type QueryResult, type Widget, type WidgetOptions } from '../vendor/paprika/ui/src/features/insights/schema';
import { getWidgetDefinition, type WidgetDefinition } from '../vendor/paprika/ui/src/features/insights/widget-registry';
import { validateFieldBindings } from './field-bindings';

export type DraftValidation = { widget: Widget; errors: [] } | { widget: null; errors: string[] };

export type EditorStyleControl = NonNullable<WidgetDefinition['styleControls']>[number];

/** The editor and renderer conversion use the same implemented-capability boundary. */
export function editorStyleControls(widget: Widget, definition = getWidgetDefinition(widget)): readonly EditorStyleControl[] {
  if (widget.type === 'plugin') return definition?.styleControls ?? [];
  if (widget.type === 'timeseries' || widget.type === 'bar') return ['unit', 'decimals', 'color', 'legend', 'grid', 'tooltips'];
  if (widget.type === 'stat') return ['unit', 'decimals', 'color', 'tooltips'];
  return ['unit', 'decimals', 'tooltips'];
}

/** Clearing an optional input restores the runtime default without a serialized placeholder. */
export function updateWidgetOption<K extends keyof WidgetOptions>(widget: Widget, key: K, value: WidgetOptions[K]): Widget {
  const options = { ...widget.options };
  if (value === undefined) delete options[key];
  else options[key] = value;
  return { ...widget, options };
}

const sharedTooltipKeys = ['showTooltip', 'inspectorDensity', 'tooltipPlacement', 'tooltipOffset', 'tooltipMaxWidth', 'tooltipMaxHeight'] as const;

function sharedTooltipOptions(options?: WidgetOptions): WidgetOptions {
  return Object.fromEntries(sharedTooltipKeys.flatMap(key => options?.[key] === undefined ? [] : [[key, options[key]]])) as WidgetOptions;
}

function issuePath(path: readonly PropertyKey[], fallback: string) {
  return path.reduce<string>((text, key) => typeof key === 'number' ? `${text}[${key}]` : `${text}${text ? '.' : ''}${String(key)}`, '') || fallback;
}

/** Plugin parsers throw ZodError, whose message is a serialized diagnostic array.
 * Show each actionable issue instead, preserving nested field and option context.
 */
function validationMessages(issues: readonly ZodIssue[], fallback: string, prefix: PropertyKey[] = [], alternative = ''): string[] {
  return issues.flatMap(issue => {
    const path = [...prefix, ...issue.path], label = `${issuePath(path, fallback)}${alternative}`;
    if (issue.code === 'invalid_union' && issue.errors.length) return [
      `${label}: choose one valid option.`,
      ...issue.errors.flatMap((branch, index) => validationMessages(branch, fallback, path, `${alternative} (option ${index + 1})`)),
    ];
    if ((issue.code === 'invalid_key' || issue.code === 'invalid_element') && issue.issues.length) return validationMessages(issue.issues, label, path, alternative);
    return [`${label}: ${issue.message.replace(/^Invalid input: /, '')}`];
  });
}

/** Validation is shared by live preview and Apply; unsupported config never reaches a renderer. */
export function validateEditorWidget(candidate: unknown, sourceKind: DataKind, result?: QueryResult): DraftValidation {
  const parsed = widgetSchema.safeParse(candidate);
  if (!parsed.success) return { widget: null, errors: validationMessages(parsed.error.issues, 'Panel') };
  const widget = parsed.data, definition = getWidgetDefinition(widget);
  if (!definition) return { widget: null, errors: ['Choose a visualization registered in this host.'] };
  if (definition.dataKind !== sourceKind || widgetKind(widget) !== sourceKind) return { widget: null, errors: ['This visualization does not accept the current data kind.'] };
  try {
    const config = definition.parseConfig?.(widget.config);
    if (result) {
      const diagnostics = validateFieldBindings(definition, config ?? widget.config, result);
      if (diagnostics.length) return { widget: null, errors: diagnostics.map(issue => issue.message) };
    }
    if (result) definition.validateInput?.(result, config ?? widget.config);
    return { widget: config === undefined ? widget : { ...widget, config }, errors: [] };
  } catch (error) {
    if (error instanceof ZodError) return { widget: null, errors: validationMessages(error.issues, 'Configuration') };
    return { widget: null, errors: [error instanceof Error ? error.message : 'Check the visualization configuration.'] };
  }
}

export interface EditorDraftState { draft: Widget; preview: Widget; errors: string[]; past: Widget[]; future: Widget[] }
export function createEditorDraft(widget: Widget, result?: QueryResult): EditorDraftState {
  const copy = structuredClone(widget);
  const validation = validateEditorWidget(copy, widgetKind(widget), result);
  return { draft: copy, preview: validation.widget ?? copy, errors: validation.errors, past: [], future: [] };
}
/** Source refreshes revalidate an open draft without becoming a presentation edit. */
export function revalidateEditorDraft(state: EditorDraftState, kind: DataKind, result?: QueryResult): EditorDraftState {
  const validation = validateEditorWidget(state.draft, kind, result);
  return { ...state, preview: validation.widget ?? state.preview, errors: validation.errors };
}
export function reviseEditorDraft(state: EditorDraftState, draft: Widget, kind: DataKind, result?: QueryResult): EditorDraftState {
  const validation = validateEditorWidget(draft, kind, result);
  return { draft, preview: validation.widget ?? state.preview, errors: validation.errors, past: [...state.past, state.draft].slice(-40), future: [] };
}
export function travelEditorDraft(state: EditorDraftState, direction: 'undo' | 'redo', kind: DataKind, result?: QueryResult): EditorDraftState {
  const from = direction === 'undo' ? state.past : state.future;
  const draft = from.at(-1);
  if (!draft) return state;
  const validation = validateEditorWidget(draft, kind, result);
  return { draft, preview: validation.widget ?? state.preview, errors: validation.errors,
    past: direction === 'undo' ? state.past.slice(0, -1) : [...state.past, state.draft],
    future: direction === 'undo' ? [...state.future, state.draft] : state.future.slice(0, -1) };
}

/** Only offer conversions with a complete, valid mapping for the existing result. */
export function visualizationCandidate(widget: Widget, definition: WidgetDefinition, remembered?: Widget): Widget {
  if (getWidgetDefinition(widget)?.id === definition.id) return widget;
  const { pluginId: _pluginId, dataKind: _dataKind, config: _config, ...common } = widget;
  const cached = remembered && getWidgetDefinition(remembered)?.id === definition.id ? remembered : undefined;
  const supportsTooltip = definition.type !== 'plugin' || definition.styleControls?.includes('tooltips');
  const options = cached?.options ?? { decimals: widget.options?.decimals, showLegend: true, showTooltip: true, ...definition.defaultOptions,
    ...(supportsTooltip ? sharedTooltipOptions(widget.options) : {}),
  };
  return definition.type === 'plugin'
    ? { ...common, type: 'plugin', pluginId: definition.id, dataKind: definition.dataKind, options, config: cached?.config ?? definition.defaultConfig ?? {} }
    : { ...common, type: definition.type, options };
}
export function editorVisualizations(widget: Widget, result: QueryResult, definitions: readonly WidgetDefinition[]) {
  const kind = widgetKind(widget), current = getWidgetDefinition(widget)?.id;
  return definitions.filter(definition => {
    if (definition.id === current) return true;
    if (definition.dataKind !== kind || definition.id === 'reference-timeseries') return false;
    // Record alternatives need a real adapter for this result. Matching primitive
    // column types alone never proves semantic compatibility.
    if (kind === 'records' && definition.id !== 'record-table' && !definition.validateInput) return false;
    if (definition.id === 'distribution-heatmap' && !result.series?.every(series => 'le' in series.labels)) return false;
    if (definition.id === 'directional-traffic' && !result.series?.some(series => series.labels.direction)) return false;
    if (definition.type === 'plugin' && definition.defaultConfig === undefined && definition.id !== 'record-table') return false;
    return !!validateEditorWidget(visualizationCandidate(widget, definition), kind, result).widget;
  });
}

export interface EditorDataTable { columns: string[]; rows: (string | number | boolean | null)[][]; total: number; capped: boolean }
export function editorDataTable(result: QueryResult, limit = 500): EditorDataTable {
  if (result.records) return { columns: result.records.columns.map(column => `${column.label ?? column.key}${column.unit ? ` (${column.unit})` : ''}`), rows: result.records.rows.slice(0, limit), total: result.records.rows.length, capped: result.records.rows.length > limit };
  if (result.series) {
    const total = result.series.reduce((sum, series) => sum + series.points.length, 0);
    const rows: EditorDataTable['rows'] = [];
    outer: for (const series of result.series) for (const point of series.points) {
      if (rows.length >= limit) break outer;
      rows.push([series.name, Number.isFinite(point.timestamp) ? new Date(point.timestamp).toISOString() : 'Invalid timestamp', point.value, Object.entries(series.labels).map(([key, value]) => `${key}=${value}`).join(' · ')]);
    }
    return { columns: ['Series', 'Timestamp (UTC)', 'Exact value', 'Labels'], rows, total, capped: total > limit };
  }
  const traces = result.traces ?? [];
  return { columns: ['Trace', 'Service', 'Operation', 'Duration (ms)', 'Status'], rows: traces.slice(0, limit).map(trace => [trace.traceId, trace.service, trace.operation, trace.durationMs, trace.status]), total: traces.length, capped: traces.length > limit };
}
