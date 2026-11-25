import { describe, expect, it } from "vitest";
import { exactMetric, formatMetricDetails } from "./chart-data";
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge";
import { getWidgetPlugins } from "./widget-registry";
import { formatMetric } from "./units";

// Floating-point noise that the widgets produce in practice, paired with the text Auto and exact rows must show.
const noisy = [5.878749999999975, 0.1 + 0.2, 296303060975000, 7.191875000000073];

describe("exact values round to 12 significant digits and group digits", () => {
  it.each([
    [5.878749999999975, "", "5.87875"],
    [0.1 + 0.2, "", "0.3"],
    [296303060975000, "bytes", "296,303,060,975,000 bytes"],
    [7.191875000000073, "observations/s", "7.191875 observations/s"],
    [12.345678, "%", "12.345678%"],
    [-0, "ms", "0 ms"],
    [1234567.5, "", "1,234,567.5"],
    [NaN, "ms", "—"],
    [123456789012345, "", "123,456,789,012,345"],
    [1e-25, "", "1e-25"],
  ])("exactMetric(%s, %j) is %j", (value, unit, expected) => {
    expect(exactMetric(value, unit)).toBe(expected);
  });
});

describe("Auto never prints floating-point noise", () => {
  it.each(noisy)("formatMetricDetails(%s) has no run of six or more decimals", (value) => {
    expect(formatMetricDetails(value, "")).not.toMatch(/\.\d{6,}/);
    expect(formatMetricDetails(value, "")).not.toMatch(/\d{15,}/);
  });

  it("uses reading precision with unit scaling when decimals are unset", () => {
    expect(formatMetricDetails(296303060975000, "bytes")).toBe(formatMetric(296303060975000, "bytes"));
    expect(formatMetricDetails(5.878749999999975, "observations/s")).toBe(formatMetric(5.878749999999975, "observations/s"));
  });

  it("applies explicit decimals to the same value", () => {
    expect(formatMetricDetails(5.878749999999975, "", 2)).toBe("5.88");
    expect(formatMetricDetails(0.1 + 0.2, "", 0)).toBe("0");
  });
});

// Every widget type that shows a number exposes the Decimal places control, so authors can always choose precision.
describe("every numeric plugin exposes Decimal places", () => {
  it("lists decimals in styleControls for each registered plugin", () => {
    registerDefaultWidgetPlugins();
    const plugins = getWidgetPlugins();
    expect(plugins.length).toBeGreaterThan(10);
    const missing = plugins.filter((plugin) => !plugin.styleControls?.includes("decimals")).map((plugin) => plugin.id);
    expect(missing).toEqual([]);
  });
});

// A guard: production code outside the formatters does not stringify metric values for display. Attributes such as
// data-observation-value carry the raw machine value and are allowed by name below.
describe("no raw metric strings outside the formatters", () => {
  it("finds no String() call on a metric value in display text", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = join(process.cwd(), "src/features/insights");
    // Also flags `.toString()` on the same metric names. Template literals are not matched: label maps use `${value}` for text.
    const pattern = /(String\(\s*[\w.[\]?!]*\b(value|durationMs|latest\w*|point\.value|datum\.value|activeValue|cell\.value|row\[\w+\])\s*\)|\b(value|durationMs|point\.value|datum\.value|activeValue)\.toString\(\))/;
    // Each exception names a file and a fragment of the line. Raw machine values in data-* attributes, query and
    // variable parameters (not display text), the non-numeric fallbacks, and the helpers that format numbers.
    const allowed: [file: string, fragment: string][] = [
      ["renderers/trace-list.tsx", "? String(trace.durationMs)"],
      ["plot-tooltip.tsx", "point.value === null ? \"missing\" : String(point.value)"],
      ["drilldown.ts", "String(context.value)"],
      ["drilldown.ts", "typeof value === \"number\" ? String(value) : value"],
      ["query-connections.ts", "String(value)"],
      ["saved-query-controls.tsx", "String(binding.value)"],
      ["plugins/operational-records-data.ts", "[[item.key, String(value)]]"],
      ["plugins/records.tsx", "return value === null || value === undefined ? \"—\" : String(value)"],
      // An editable number field round-trips the stored value as text; it is input, not display.
      ["threshold-list-editor.tsx", "value.toString()"],
      ["plugins/records.tsx", "Invalid history"],
      ["plugins/record-charts.tsx", "const contextText="],
      ["plugins/record-table-cells.tsx", "const displayed = "],
      ["renderers/stat.tsx", "data-metric-value={String(first.point.value)}"],
      ["metric-tooltip-content.tsx", "data-metric-value="],
      ["example-catalog-query.ts", "const key = String(row[stock])"],
      ["plugins/operational-records-data.ts", "const labelValue"],
      ["plugins/operational-records-data.ts", "[[item.key, String(row[index])]]"],
      ["plugins/operational-records-view.tsx", "data-threshold="],
      ["plugins/record-charts.tsx", "const categories="],
      ["plugins/record-charts.tsx", "categories.indexOf(String(value))"],
      ["plugins/record-charts.tsx", "onContextChange?.("],
      ["plugins/records.tsx", "[[col.key, String(row[i])]]"],
    ];
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) && !/units\.ts$|chart-data\.ts$/.test(name)) {
          readFileSync(path, "utf8").split("\n").forEach((line, index) => {
            if (pattern.test(line) && !allowed.some(([file, fragment]) => path.endsWith(file) && line.includes(fragment)))
              offenders.push(`${relative(root, path)}:${index + 1}: ${line.trim().slice(0, 120)}`);
          });
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
