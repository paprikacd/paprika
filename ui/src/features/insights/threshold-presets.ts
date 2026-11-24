import type { Threshold } from "./schema";

/**
 * A named set of status bands. A preset writes status-only bands, ascending from 0, and replaces the list.
 * `build` returns undefined when the preset has no sensible scale for the widget's unit.
 */
export interface ThresholdPreset {
  id: string;
  name: string;
  build: (unit: string) => Threshold[] | undefined;
}

type Band = readonly [value: number, status: "ok" | "warning" | "critical", label: string];

function bands(list: readonly Band[]): Threshold[] {
  return list.map(([value, status, label]) => ({ value, status, label }));
}

/** Units that read a value as a plain ratio from 0 to 1. */
const RATIO_UNITS = new Set(["", "ratio"]);
/** Units that read a value as a multiple, as a burn rate is. */
const MULTIPLE_UNITS = new Set(["", "x", "×"]);

/**
 * A percentage unit uses 0 to 100, and no unit or `ratio` uses 0 to 1. Any other unit (ms, bytes, req/s) has no
 * scale for a proportion, so the preset is not offered rather than writing bands of the wrong size.
 */
function scaled(unit: string, percentScale: readonly Band[], ratioScale: readonly Band[]): Threshold[] | undefined {
  const trimmed = unit.trim();
  if (trimmed === "%") return bands(percentScale);
  return RATIO_UNITS.has(trimmed) ? bands(ratioScale) : undefined;
}

export const thresholdPresets: readonly ThresholdPreset[] = [
  {
    id: "availability",
    name: "Availability",
    build: (unit) => scaled(unit,
      [[0, "critical", "Breach"], [99, "warning", "At risk"], [99.9, "ok", "Healthy"]],
      [[0, "critical", "Breach"], [0.99, "warning", "At risk"], [0.999, "ok", "Healthy"]]),
  },
  {
    id: "errorRatio",
    name: "Error ratio",
    build: (unit) => scaled(unit,
      [[0, "ok", "Healthy"], [1, "warning", "Elevated"], [5, "critical", "High"]],
      [[0, "ok", "Healthy"], [0.01, "warning", "Elevated"], [0.05, "critical", "High"]]),
  },
  {
    id: "latency",
    name: "Latency",
    build: (unit) => {
      const trimmed = unit.trim();
      if (trimmed === "ms") return bands([[0, "ok", "Healthy"], [300, "warning", "Slow"], [1000, "critical", "Very slow"]]);
      if (trimmed === "s") return bands([[0, "ok", "Healthy"], [0.3, "warning", "Slow"], [1, "critical", "Very slow"]]);
      return undefined;
    },
  },
  {
    id: "burnRate",
    name: "Burn rate",
    build: (unit) => MULTIPLE_UNITS.has(unit.trim()) ? bands([[0, "ok", "Healthy"], [2, "warning", "Fast burn"], [10, "critical", "Very fast burn"]]) : undefined,
  },
  {
    id: "saturation",
    name: "Saturation",
    build: (unit) => scaled(unit,
      [[0, "ok", "Healthy"], [70, "warning", "Busy"], [90, "critical", "Saturated"]],
      [[0, "ok", "Healthy"], [0.7, "warning", "Busy"], [0.9, "critical", "Saturated"]]),
  },
];

/** The presets that fit a unit, in the order they are offered first. */
export function suggestedPresetIds(unit: string): readonly string[] {
  const trimmed = unit.trim();
  if (trimmed === "%") return ["availability", "errorRatio", "saturation"];
  if (trimmed === "ms" || trimmed === "s") return ["latency"];
  if (trimmed === "x" || trimmed === "×") return ["burnRate"];
  return [];
}
