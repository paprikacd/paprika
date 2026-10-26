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
  parseConfig?: (config: Widget["config"]) => Widget["config"];
}
export type WidgetPlugin = Omit<WidgetDefinition, "type">;

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
  if (!["metrics", "traces"].includes(plugin.dataKind))
    throw new Error("Widget plugin data kind must be metrics or traces");
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
