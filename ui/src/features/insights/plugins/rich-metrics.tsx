import { lazy } from "react"
import { ArrowDownUp, Grid2X2, Layers } from "lucide-react"
import { getWidgetDefinition, registerWidgetPlugin, type WidgetSizing } from "../widget-registry"
import { directionalConfigSchema, distributionConfigSchema, stackedConfigSchema } from "./rich-metrics-data"
import { metricAnnotationEditor, seriesColorEditor } from "./sub-editors"

// The metric renderers and their stylesheets load when a widget of their type first renders, so the registry stays light.
const loadView = () => import("./rich-metrics-view")
const DistributionHeatmap = lazy(() => loadView().then((module) => ({ default: module.DistributionHeatmap })))
const StackedTimeseries = lazy(() => loadView().then((module) => ({ default: module.StackedTimeseries })))
const DirectionalTraffic = lazy(() => loadView().then((module) => ({ default: module.DirectionalTraffic })))

/** Stacked and directional plots: a plot room, with a fifth narrow track when the statistics table sits below the chart. */
const legendPlotSizing: WidgetSizing = {
  mode: "fill",
  denseRoom: () => "plot",
  narrowMinRows: config => config?.legendDisplay === "table" ? 5 : undefined,
};

export function registerRichMetricPlugins() {
  if (!getWidgetDefinition("plugin", "distribution-heatmap")) registerWidgetPlugin({
    id: "distribution-heatmap", label: "Distribution heatmap", description: "Cumulative histogram buckets as density over time", dataKind: "metrics", render: DistributionHeatmap,
    styleControls: ["unit", "decimals", "legend", "tooltips"],
    defaultConfig: { bucketLabel: "le", densityUnit: "observations/s", aggregation: "none", colorScale: "linear", maxBuckets: 24, maxColumns: 60 },
    configFields: [
      { key: "bucketLabel", label: "Bucket boundary label", kind: "text", placeholder: "le" },
      { key: "bucketUnit", label: "Bucket unit override", kind: "text", placeholder: "Widget unit", help: "Leave empty to use the widget unit; this only labels bucket boundaries, never density values." },
      { key: "densityUnit", label: "Density unit", kind: "text", help: "Use a query-side rate for per-second units. The chart only differences cumulative buckets." },
      { key: "colorScale", label: "Color scale", kind: "select", options: [{ value: "linear", label: "Linear" }, { value: "logarithmic", label: "Logarithmic" }], help: "Logarithmic colors spread positive values between the smallest and largest observations in the shown buckets, before time sampling; zero remains separate. Values and query results are unchanged." },
      { key: "aggregation", label: "Histogram groups", kind: "select", options: [{ value: "none", label: "Require a single group" }, { value: "sum", label: "Sum matching bucket boundaries" }] },
      { key: "maxBuckets", label: "Maximum buckets", kind: "number", min: 1, max: 48, step: 1 },
      { key: "maxColumns", label: "Maximum time columns", kind: "number", min: 8, max: 120, step: 1 },
    ], parseConfig: value => distributionConfigSchema.parse(value ?? {}),
    icon: Grid2X2,
    capabilities: { inspectorPlacement: true },
  });
  if (!getWidgetDefinition("plugin", "stacked-timeseries")) registerWidgetPlugin({
    id: "stacked-timeseries", label: "Stacked time series", description: "Compare contributions with stacked areas or time bars", dataKind: "metrics", render: StackedTimeseries,
    styleControls: ["unit", "decimals", "color", "legend", "grid", "tooltips"],
    defaultConfig: { display: "area", maxSeries: 8, maxPoints: 120, legendDisplay: "compact", legendPosition: "bottom" },
    configFields: [
      { key: "display", label: "Stack display", kind: "select", options: [{ value: "area", label: "Stacked area" }, { value: "bar", label: "Stacked time bars" }] },
      { key: "legendDisplay", label: "Legend display", kind: "select", options: [{ value: "compact", label: "Compact latest values" }, { value: "table", label: "Current, mean and max table" }], help: "Table statistics use raw returned samples before display sampling. Mean ignores missing values." },
      { key: "legendPosition", label: "Legend position", kind: "select", options: [{ value: "bottom", label: "Below the chart" }, { value: "right", label: "Right side" }], help: "Right-side legends move below the chart in narrow panels." },
      { key: "maxSeries", label: "Maximum series", kind: "number", min: 1, max: 12, step: 1 },
      { key: "maxPoints", label: "Maximum time columns", kind: "number", min: 12, max: 240, step: 1 },
    ], parseConfig: value => stackedConfigSchema.parse(value ?? {}),
    sizing: legendPlotSizing,
    icon: Layers,
    capabilities: { inspectorPlacement: true, colorFallback: "series" },
    configEditors: [seriesColorEditor, metricAnnotationEditor],
  });
  if (!getWidgetDefinition("plugin", "directional-traffic")) registerWidgetPlugin({
    id: "directional-traffic", label: "Directional traffic", description: "Inbound above zero and outbound below, with original values", dataKind: "metrics", render: DirectionalTraffic,
    styleControls: ["unit", "decimals", "color", "legend", "grid", "tooltips"],
    defaultConfig: { directionLabel: "direction", outboundValue: "outbound", symmetricAxis: false, maxSeries: 8, maxPoints: 120, legendDisplay: "compact", legendPosition: "bottom" },
    configFields: [
      { key: "directionLabel", label: "Direction label", kind: "text", placeholder: "direction" },
      { key: "outboundValue", label: "Outbound label value", kind: "text", placeholder: "outbound", help: "Matching series are drawn below zero. Query values must be nonnegative." },
      { key: "symmetricAxis", label: "Center zero on the value axis", kind: "boolean", help: "Use equal positive and negative bounds without changing the recorded traffic values." },
      { key: "legendDisplay", label: "Legend display", kind: "select", options: [{ value: "compact", label: "Compact latest values" }, { value: "table", label: "Current, mean and max table" }], help: "Table statistics preserve raw outbound values. Mean ignores missing values." },
      { key: "legendPosition", label: "Legend position", kind: "select", options: [{ value: "bottom", label: "Below the chart" }, { value: "right", label: "Right side" }], help: "Right-side legends move below the chart in narrow panels." },
      { key: "maxSeries", label: "Maximum series", kind: "number", min: 1, max: 12, step: 1 },
      { key: "maxPoints", label: "Maximum time columns", kind: "number", min: 12, max: 240, step: 1 },
    ], parseConfig: value => directionalConfigSchema.parse(value ?? {}),
    sizing: legendPlotSizing,
    icon: ArrowDownUp,
    capabilities: { inspectorPlacement: true, colorFallback: "series" },
    configEditors: [seriesColorEditor],
  });
}
