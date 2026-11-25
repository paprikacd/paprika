"use client";

import { useSyncExternalStore, type ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { ZodType } from "zod";
import { BuiltinWidgetRenderer } from "./chart-renderers";
import type { DrilldownContext } from "./drilldown";
import { barStylePresets, heatmapStylePresets, statStylePresets, timeseriesStylePresets } from "./style-presets";
import { gridStarters, seriesStarters, statStarters, traceStarters } from "./starter-queries";
import {
  widgetOptionsSchema,
  type DataKind,
  type Provider,
  type QueryResult,
  type Widget,
  type WidgetOptions,
} from "./schema";

export interface WidgetRendererProps {
  widget: Widget;
  result: QueryResult;
  /** Embedded tooltip rendering must remain static: no nested tooltip or inspector. */
  embedded?: boolean;
  /**
   * Reports the signal under focus, hover or a series pick. It sets the drilldown link context and must never change dashboard filters.
   * Selectable plugins still activate through this callback until they migrate to onActivate, so for them it can change filters.
   */
  onContextChange?: (context: DrilldownContext) => void;
  /**
   * A deliberate activation (click, Enter or Space) of a mark, which may change dashboard filters. A renderer calls it
   * for activation and falls back to onContextChange when it is not passed.
   */
  onActivate?: (context: DrilldownContext) => void;
}
export interface WidgetDefinition {
  id: string;
  type: Widget["type"];
  label: string;
  description: string;
  dataKind: DataKind;
  render: ComponentType<WidgetRendererProps>;
  defaultOptions?: WidgetOptions;
  defaultConfig?: Widget["config"];
  /** Trusted host-owned field descriptions; persisted documents carry values only. */
  configFields?: readonly WidgetConfigField[];
  /**
   * false keeps a registered plugin renderable for saved widgets while leaving it out of the widget library, the
   * visualization switchers and the AI guidance lists. Defaults to true.
   */
  listed?: boolean;
  /** Only expose controls the renderer actually implements. */
  styleControls?: readonly ("unit" | "decimals" | "color" | "legend" | "grid" | "tooltips")[];
  /**
   * Parses the plugin's configuration. Set configSchema instead when the plugin has a Zod schema; registration then
   * derives parseConfig from it, so the editor, the viewer and the dashboard checks share one parser.
   */
  parseConfig?: (config: Widget["config"]) => Widget["config"];
  /** The plugin's configuration schema, which the registry turns into parseConfig. Each configuration must be an object. */
  configSchema?: ZodType;
  /**
   * Checks loaded data against the configuration before the editor accepts it. Return one issue per problem;
   * an empty list means the renderer can draw the result. A check that throws is reported as one issue.
   */
  validateInput?: (result: QueryResult, config: Widget["config"]) => readonly WidgetInputIssue[];
  /** Host sizing contract. Compact and narrow canvas projections respect minHeight; saved layouts remain authored. */
  sizing?: WidgetSizing;
  /** The icon the widget library shows for this plugin. */
  icon?: LucideIcon;
  /** What the renderer supports, read by the editors so they never repeat its id. */
  capabilities?: WidgetCapabilities;
  /** Sub-editors for this plugin's configuration. Each loads on first use, so its code and styles stay out of the first view. */
  configEditors?: readonly WidgetConfigEditorLoader[];
  // Authoring metadata (S11): one contiguous block. Omitted fields keep the built-in behaviour.
  /** Style sections the editor shows, in this order. Omitted means every section in STYLE_SECTION_IDS. */
  optionSections?: readonly StyleSectionId[];
  /** One-click appearance presets for the Style tab. Each set of options must pass widgetOptionsSchema. */
  stylePresets?: readonly StylePreset[];
  /** Queries offered as chips when the editor's query is still empty or a default. Each must return data for its family. */
  starterQueries?: readonly StarterQuery[];
  /** Scores how well a loaded result suits this widget, from 0 to 1. Only scores of 0.5 or more are suggested. */
  suggest?: (result: QueryResult) => number;
}
/** The Style tab sections, in their default order. A renderer narrows or reorders them with `optionSections`. */
export const STYLE_SECTION_IDS = ["highlight", "value", "color", "lines", "axes", "card", "cells", "legend"] as const;
export type StyleSectionId = (typeof STYLE_SECTION_IDS)[number];
export interface StylePreset {
  id: string;
  name: string;
  options: Partial<WidgetOptions>;
  /** The mark the preset button draws, so every choice reads at a glance. */
  preview: "line" | "area" | "bars" | "value" | "sparkline" | "cells";
}
export interface StarterQuery {
  id: string;
  label: string;
  providerTypes: readonly Provider["type"][];
  query: string;
  unit?: string;
  /** The starter a new widget of this family begins with. */
  default?: boolean;
}
/** What a renderer supports. Each field is read by the editors and the canvas; none is a plugin id check. */
export interface WidgetCapabilities {
  /** The observation inspector reads tooltip placement, offset and size. */
  inspectorPlacement?: boolean;
  /** The palette slot the widget draws without its own colour. Undefined when no slot applies. */
  colorFallback?: "series" | "chart2";
  /** Value thresholds apply. A function decides for one configuration. */
  thresholds?: boolean | ((config: Widget["config"]) => boolean);
  /** Status thresholds are the default when a widget sets none. */
  defaultStatusThresholds?: boolean;
  /** Explicit minimum and maximum bounds apply. */
  bounds?: boolean;
  /** The tooltip view controls the renderer honours. */
  tooltipViewControls?: readonly ("decimals" | "color" | "legend")[];
  /** Whether the tile folds its description into a panel for this configuration. */
  compactDescription?: (config: Widget["config"]) => boolean;
  /** A line shown above the tooltip settings. */
  tooltipIntro?: string;
}
/** Loads one sub-editor. The component receives the plugin configuration and reports each change as the next one. */
export type WidgetConfigEditorLoader = () => Promise<{
  default: ComponentType<{ config: Record<string, unknown>; onChange(next: Record<string, unknown>): void }>;
}>;
/**
 * The dense viewing room a renderer's content needs. Rooms are defined once in responsive-layout.ts; a renderer names
 * the room that fits its content and never hard-codes row counts.
 */
export type DenseRoom = "plot" | "reading" | "tall" | "tall-table" | "calendar";
export interface WidgetSizing {
  mode: "intrinsic" | "fill";
  minWidth?: number;
  minHeight?: number;
  /** A minimum height that depends on the authored config, such as the rows a services card lists. Wins over minHeight. */
  minHeightFor?: (config: Widget["config"]) => number;
  /** The dense room for this configuration. Undefined keeps the default room. */
  denseRoom?: (config: Widget["config"]) => DenseRoom | undefined;
  /** The minimum rows on a narrow canvas, for configurations that show more than an ordinary card. Undefined keeps 4. */
  narrowMinRows?: (config: Widget["config"]) => number | undefined;
  /** The fine-grid rows to use in the reference compact view. Undefined keeps the room's rule. */
  referenceFineRows?: (config: Widget["config"]) => number | undefined;
}
export interface WidgetInputIssue {
  /** The configuration key the issue concerns, when one applies. */
  field?: string;
  message: string;
}
export type WidgetRecordType = "string" | "number" | "boolean" | "timestamp";
/** The column role a text field expects. Trusted renderer code declares it; a field label never implies it. */
export interface WidgetFieldBinding {
  types: readonly WidgetRecordType[];
  /** A unit every accepted column must declare, when the renderer needs one. */
  unit?: string;
  acceptedUnits?: readonly string[];
  /** What the field means, shown beside its requirement. */
  role?: string;
  /** An explicitly empty mapping is valid, and the configuration keeps it empty. */
  optional?: boolean;
}
export interface WidgetConfigField {
  key: string;
  label: string;
  kind: "text" | "number" | "boolean" | "select";
  placeholder?: string;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly { value: string; label: string }[];
  /** A column key from an already-loaded record result; numeric fields are validated by the renderer. */
  recordColumn?: "any" | "number";
  /** The column role a text or number input expects. Supersedes `recordColumn`, which keeps working as its alias. */
  binding?: WidgetFieldBinding;
  /** The value the field takes when the configuration does not set it, for fields whose default depends on other settings. */
  defaultFor?: (config: Widget["config"]) => unknown;
}
export type WidgetPlugin = Omit<WidgetDefinition, "type">;

const recordTypes: readonly WidgetRecordType[] = ["string", "number", "boolean", "timestamp"];

/** `recordColumn` is the older spelling of a binding: "number" accepts numeric columns and "any" accepts every column. */
export function effectiveFieldBinding(field: WidgetConfigField): WidgetFieldBinding | undefined {
  if (field.binding) return field.binding;
  if (field.recordColumn === "number") return { types: ["number"] };
  if (field.recordColumn === "any") return { types: recordTypes };
  return undefined;
}

/** Runs a renderer's own data check. A check that throws is reported as an issue, never as a silent pass. */
export function widgetInputIssues(definition: WidgetDefinition | undefined, result: QueryResult, config: Widget["config"]): readonly WidgetInputIssue[] {
  if (!definition?.validateInput) return [];
  try {
    return definition.validateInput(result, config);
  } catch {
    return [{ message: "The loaded result could not be checked for this widget." }];
  }
}

function validateSizing(sizing: WidgetSizing | undefined) {
  if (sizing === undefined) return;
  if (sizing.mode !== "intrinsic" && sizing.mode !== "fill")
    throw new Error("Widget plugin sizing mode must be intrinsic or fill");
  for (const key of ["minWidth", "minHeight"] as const) {
    const value = sizing[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new Error(`Widget plugin sizing ${key} must be a finite, nonnegative number`);
  }
  if (sizing.minHeightFor !== undefined && typeof sizing.minHeightFor !== "function")
    throw new Error("Widget plugin sizing minHeightFor must be a function");
  for (const key of ["denseRoom", "narrowMinRows", "referenceFineRows"] as const) {
    if (sizing[key] !== undefined && typeof sizing[key] !== "function")
      throw new Error(`Widget plugin sizing ${key} must be a function`);
  }
}

/** Checks the authoring metadata of a plugin. Preset options use the dashboard schema, which refuses unknown keys. */
function validateStyleMetadata(plugin: WidgetPlugin) {
  for (const section of plugin.optionSections ?? []) {
    if (!(STYLE_SECTION_IDS as readonly string[]).includes(section))
      throw new Error(`Widget plugin option section “${section}” is not a style section`);
  }
  for (const preset of plugin.stylePresets ?? []) {
    if (!widgetOptionsSchema.safeParse(preset.options).success)
      throw new Error(`Widget plugin style preset “${preset.id}” has options the dashboard does not accept`);
  }
  for (const starter of plugin.starterQueries ?? []) {
    if (starter.query.length < 1 || starter.query.length > 8192)
      throw new Error(`Widget plugin starter query “${starter.id}” must be 1 to 8192 characters`);
  }
  if (plugin.suggest !== undefined && typeof plugin.suggest !== "function")
    throw new Error("Widget plugin suggest must be a function");
}

function validateConfigFields(fields: readonly WidgetConfigField[] | undefined) {
  for (const field of fields ?? []) {
    const binding = field.binding;
    if (!binding) continue;
    if (!Array.isArray(binding.types) || binding.types.length === 0 || binding.types.some((type) => !recordTypes.includes(type)))
      throw new Error(`Configuration field “${field.key}” needs binding types from string, number, boolean or timestamp`);
    if (binding.acceptedUnits !== undefined && (!Array.isArray(binding.acceptedUnits) || binding.acceptedUnits.length === 0))
      throw new Error(`Configuration field “${field.key}” needs at least one accepted unit`);
  }
}

export const widgetDefinitions: readonly WidgetDefinition[] = Object.freeze([
  {
    id: "timeseries",
    type: "timeseries",
    label: "Time series",
    description: "See how a signal changes over time",
    dataKind: "metrics",
    render: BuiltinWidgetRenderer,
    stylePresets: timeseriesStylePresets,
    starterQueries: seriesStarters,
  },
  {
    id: "stat",
    type: "stat",
    label: "Single value",
    description: "One number, clear context",
    dataKind: "metrics",
    render: BuiltinWidgetRenderer,
    stylePresets: statStylePresets,
    starterQueries: statStarters,
  },
  {
    id: "bar",
    type: "bar",
    label: "Bar chart",
    description: "Compare services at a glance",
    dataKind: "metrics",
    render: BuiltinWidgetRenderer,
    stylePresets: barStylePresets,
    starterQueries: seriesStarters,
  },
  {
    id: "heatmap",
    type: "heatmap",
    label: "Status grid",
    description: "Service health at a glance",
    dataKind: "metrics",
    render: BuiltinWidgetRenderer,
    stylePresets: heatmapStylePresets,
    starterQueries: gridStarters,
  },
  {
    id: "table",
    type: "table",
    label: "Metrics table",
    description: "Get closer to the underlying values",
    dataKind: "metrics",
    render: BuiltinWidgetRenderer,
    starterQueries: gridStarters,
  },
  {
    id: "traces",
    type: "traces",
    label: "Trace explorer",
    description: "Follow requests across services",
    dataKind: "traces",
    render: BuiltinWidgetRenderer,
    starterQueries: traceStarters,
  },
] satisfies WidgetDefinition[]);

const plugins = new Map<string, WidgetDefinition>();
const listeners = new Set<() => void>();
let snapshot: readonly WidgetDefinition[] = widgetDefinitions;
const getSnapshot = () => snapshot;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function publish() {
  snapshot = Object.freeze([...widgetDefinitions, ...[...plugins.values()].filter((plugin) => plugin.listed !== false)]);
  listeners.forEach((listener) => listener());
}

/** Register trusted host code only. Dashboard documents can reference IDs, never executable code. */
export function registerWidgetPlugin(plugin: WidgetPlugin): () => void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(plugin.id))
    throw new Error("Widget plugin IDs must be valid identifiers");
  if (
    plugins.has(plugin.id) ||
    widgetDefinitions.some((entry) => entry.id === plugin.id)
  )
    throw new Error(`Widget plugin “${plugin.id}” is already registered`);
  if (!plugin.label.trim() || !plugin.description.trim())
    throw new Error("Widget plugins need a label and description");
  if (plugin.validateInput !== undefined && typeof plugin.validateInput !== "function")
    throw new Error("Widget plugin validateInput must be a function");
  validateSizing(plugin.sizing);
  if (plugin.configEditors !== undefined && !plugin.configEditors.every((load) => typeof load === "function"))
    throw new Error("Widget plugin configEditors must be loader functions");
  validateConfigFields(plugin.configFields);
  validateStyleMetadata(plugin);
  if (!["metrics", "traces", "records"].includes(plugin.dataKind))
    throw new Error("Widget plugin data kind must be metrics, traces or records");
  if (
    typeof plugin.render !== "function" &&
    (typeof plugin.render !== "object" || !plugin.render)
  )
    throw new Error("Widget plugin needs a React renderer");
  const parseConfig =
    plugin.parseConfig ??
    (plugin.configSchema
      ? (config: Widget["config"]) => plugin.configSchema?.parse(config ?? {}) as Widget["config"]
      : undefined);
  const definition = Object.freeze({
    ...plugin,
    ...(parseConfig ? { parseConfig } : {}),
    type: "plugin" as const,
    ...(plugin.defaultOptions
      ? { defaultOptions: widgetOptionsSchema.parse(plugin.defaultOptions) }
      : {}),
  });
  plugins.set(plugin.id, definition);
  publish();
  return () => {
    if (plugins.get(plugin.id) === definition) {
      plugins.delete(plugin.id);
      publish();
    }
  };
}

export function getWidgetDefinition(
  widget: Widget | Widget["type"],
  pluginId?: string,
): WidgetDefinition | undefined {
  const type = typeof widget === "string" ? widget : widget.type;
  const id = typeof widget === "string" ? pluginId : widget.pluginId;
  return type === "plugin"
    ? plugins.get(id ?? "")
    : widgetDefinitions.find((entry) => entry.type === type);
}

/** The capabilities a widget's renderer declares. Undefined fields mean the renderer does not support the feature. */
export function capabilitiesOf(widget: Pick<Widget, "type" | "pluginId">): WidgetCapabilities {
  return getWidgetDefinition(widget.type, widget.pluginId)?.capabilities ?? {};
}

/** Whether value thresholds apply to a widget. Built-in types decide by type; plugins declare it in their capabilities. */
export function supportsThresholds(widget: Pick<Widget, "type" | "pluginId" | "config">): boolean {
  if (widget.type !== "plugin") return widget.type === "heatmap" || widget.type === "stat" || widget.type === "bar" || widget.type === "timeseries";
  const declared = capabilitiesOf(widget).thresholds;
  return typeof declared === "function" ? declared(widget.config) : declared === true;
}

/** The Style sections a widget shows, in order. A renderer that declares none keeps every section. */
export function optionSectionsFor(widget: Widget): readonly StyleSectionId[] {
  return getWidgetDefinition(widget)?.optionSections ?? STYLE_SECTION_IDS;
}

export function getWidgetPlugins(): readonly WidgetDefinition[] {
  return snapshot.filter((entry) => entry.type === "plugin");
}

/** Every registered plugin, listed or not. The built-in plugin list the Go lint reads is this set. */
export function getRegisteredWidgetPlugins(): readonly WidgetDefinition[] {
  return [...plugins.values()];
}
export function useWidgetDefinitions(): readonly WidgetDefinition[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
