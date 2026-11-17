"use client";

import { useSyncExternalStore, type ComponentType } from "react";
import { BuiltinWidgetRenderer } from "./chart-renderers";
import type { DrilldownContext } from "./drilldown";
import {
  widgetOptionsSchema,
  type DataKind,
  type QueryResult,
  type Widget,
  type WidgetOptions,
} from "./schema";

export interface WidgetRendererProps {
  widget: Widget;
  result: QueryResult;
  /** Embedded tooltip rendering must remain static: no nested tooltip or inspector. */
  embedded?: boolean;
  /** A deliberate selected signal, used by host-controlled dashboard drilldowns. */
  onContextChange?: (context: DrilldownContext) => void;
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
}
export interface WidgetSizing {
  mode: "intrinsic" | "fill";
  minWidth?: number;
  minHeight?: number;
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
  snapshot = Object.freeze([...widgetDefinitions, ...plugins.values()]);
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

export function getWidgetPlugins(): readonly WidgetDefinition[] {
  return snapshot.filter((entry) => entry.type === "plugin");
}
export function useWidgetDefinitions(): readonly WidgetDefinition[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
