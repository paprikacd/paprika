import type { StylePreset } from "./widget-registry";

// Each preset writes ordinary presentation options. No preset changes the query, the source or the analysis.

export const timeseriesStylePresets: readonly StylePreset[] = [
  { id: "clean-line", name: "Clean line", preview: "line", options: { display: "line", lineWidth: 2, fillOpacity: 0.12, showGrid: true, gridX: false, showLegend: true } },
  { id: "soft-area", name: "Soft area", preview: "area", options: { display: "area", lineWidth: 2, fillOpacity: 0.12, showGrid: true, gridX: false, showLegend: true } },
  { id: "compare", name: "Compare", preview: "line", options: { display: "line", lineWidth: 1.5, fillOpacity: 0.12, showGrid: true, gridX: true, showLegend: true } },
];

export const barStylePresets: readonly StylePreset[] = [
  { id: "clean-bars", name: "Clean bars", preview: "bars", options: { showGrid: true, showLegend: true } },
  { id: "minimal-bars", name: "Minimal", preview: "bars", options: { showGrid: false, showLegend: false } },
  { id: "axis-caption-bars", name: "Axis caption", preview: "bars", options: { showGrid: true, axisUnit: "caption" } },
];

export const statStylePresets: readonly StylePreset[] = [
  { id: "value-only", name: "Value only", preview: "value", options: { showSparkline: false, showStatBar: false } },
  { id: "sparkline-beside", name: "Sparkline beside", preview: "sparkline", options: { showSparkline: true, sparklinePlacement: "side" } },
  { id: "sparkline-behind", name: "Sparkline behind", preview: "sparkline", options: { showSparkline: true, sparklinePlacement: "background" } },
];

export const heatmapStylePresets: readonly StylePreset[] = [
  { id: "labels-and-values", name: "Labels and values", preview: "cells", options: { showLabels: true, showValues: true } },
  { id: "values-only", name: "Values only", preview: "cells", options: { showLabels: false, showValues: true } },
  { id: "color-only", name: "Color only", preview: "cells", options: { showLabels: false, showValues: false } },
];
