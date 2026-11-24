"use client";

import { useSyncExternalStore, type ComponentType } from "react";
import { BuiltinWidgetRenderer } from "./chart-renderers";
import type { DrilldownContext } from "./drilldown";
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
  parseConfig?: (config: Widget["config"]) => Widget["config"];
  /**
   * Checks loaded data against the configuration before the editor accepts it. Return one issue per problem;
   * an empty list means the renderer can draw the result. A check that throws is reported as one issue.
   */
  validateInput?: (result: QueryResult, config: Widget["config"]) => readonly WidgetInputIssue[];
  /** Host sizing contract. Compact and narrow canvas projections respect minHeight; saved layouts remain authored. */
  sizing?: WidgetSizing;
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
export interface WidgetSizing {
  mode: "intrinsic" | "fill";
  minWidth?: number;
  minHeight?: number;
  /** A minimum height that depends on the authored config, such as the rows a services card lists. Wins over minHeight. */
  minHeightFor?: (config: Widget["config"]) => number;
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
  },
  {
    id: "stat",
    type: "stat",
    label: "Single value",
    description: "One number, clear context",
    dataKind: "metrics",
    render: BuiltinWidgetRenderer,
  },
  {
    id: "bar",
    type: "bar",
    label: "Bar chart",
    description: "Compare services at a glance",
    dataKind: "metrics",
    render: BuiltinWidgetRenderer,
  },
  {
    id: "heatmap",
    type: "heatmap",
    label: "Status heatmap",
    description: "Service health at a glance",
    dataKind: "metrics",
    render: BuiltinWidgetRenderer,
  },
  {
    id: "table",
    type: "table",
    label: "Metrics table",
    description: "Get closer to the underlying values",
    dataKind: "metrics",
    render: BuiltinWidgetRenderer,
  },
  {
    id: "traces",
    type: "traces",
    label: "Trace explorer",
    description: "Follow requests across services",
    dataKind: "traces",
    render: BuiltinWidgetRenderer,
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
  validateConfigFields(plugin.configFields);
  validateStyleMetadata(plugin);
  if (!["metrics", "traces", "records"].includes(plugin.dataKind))
    throw new Error("Widget plugin data kind must be metrics, traces or records");
  if (
    typeof plugin.render !== "function" &&
    (typeof plugin.render !== "object" || !plugin.render)
  )
    throw new Error("Widget plugin needs a React renderer");
  const definition = Object.freeze({
    ...plugin,
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

/**
 * Whether the widget draws value thresholds. Reads the renderer's answer through one helper, so S9's capability
 * metadata can replace this body without touching callers.
 */
export function supportsThresholds(widget: Pick<Widget, "type" | "pluginId" | "config">): boolean {
  return ["heatmap", "stat", "bar", "timeseries"].includes(widget.type) ||
    widget.pluginId === "threshold-gauge" ||
    ["record-table", "status-grid", "uptime-calendar", "uptime-timeline", "connection-map"].includes(widget.pluginId ?? "") ||
    (widget.pluginId === "incident-calendar" && widget.config?.colorMode === "thresholds");
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
