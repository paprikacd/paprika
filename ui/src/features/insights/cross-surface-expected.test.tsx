import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";
import { RecordTable } from "./plugins/records";
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge";
import type { QueryResult, Widget } from "./schema";

registerDefaultWidgetPlugins();

// Hard-coded expectations: a formatter that ignores decimals, or one that prints float noise, fails these.
afterEach(() => { document.body.innerHTML = ""; });

const layout = { x: 0, y: 0, w: 6, h: 4 };
const series = (value: number) => ({ series: [{ name: "latency", labels: { service: "api" }, points: [{ timestamp: Date.UTC(2026, 0, 1), value }] }] }) as QueryResult;
const stat = (unit: string, value: number, decimals?: number) => {
  const widget: Widget = { id: "w", title: "Latency", type: "stat", providerId: "metrics", query: "latency", unit, layout, options: decimals === undefined ? {} : { decimals } };
  const { container } = render(<WidgetVisualization widget={widget} result={series(value)} />);
  return (container.textContent ?? "").replace(/\s+/g, "");
};

describe("hard-coded reading text per decimals setting", () => {
  it.each([
    { decimals: 2, expected: "5.88ms" },
    { decimals: 0, expected: "6ms" },
  ])("stat 5.878749999999975 ms at decimals $decimals reads $expected", ({ decimals, expected }) => {
    expect(stat("ms", 5.878749999999975, decimals)).toContain(expected);
  });

  it("stat 0.1 + 0.2 at decimals 2 reads 0.30, and at decimals 0 reads 0", () => {
    expect(stat("", 0.1 + 0.2, 2)).toContain("0.30");
    expect(stat("", 0.1 + 0.2, 0)).toMatch(/(^|[^\d.])0($|[^\d.])/);
  });

  it("stat 296303060975000 bytes at decimals 2 reads 269.49TiB, not 15 raw digits", () => {
    const text = stat("bytes", 296303060975000, 2);
    expect(text).toContain("269.49TiB");
    expect(text).not.toMatch(/\d{15}/);
  });

  it.each([
    { value: 5.878749999999975, unit: "ms", decimals: 3, expected: "5.879ms" },
    { value: 5.878749999999975, unit: "ms", decimals: undefined, expected: "5.88ms" },
    { value: 0.1 + 0.2, unit: "", decimals: 3, expected: "0.300" },
    { value: 296303060975000, unit: "bytes", decimals: 3, expected: "269.486TiB" },
    { value: 296303060975000, unit: "bytes", decimals: undefined, expected: "269TiB" },
  ])("stat $value $unit at decimals $decimals reads $expected", ({ value, unit, decimals, expected }) => {
    expect(stat(unit, value, decimals)).toContain(expected);
  });

  it("a threshold gauge reads its reading at the widget's decimals, on its own scale", () => {
    const gauge = (value: number, decimals?: number) => {
      const widget: Widget = { id: "g", title: "Latency", type: "plugin", pluginId: "threshold-gauge", providerId: "metrics", query: "latency", unit: "ms", layout, options: { min: 0, max: 10, decimals, thresholds: [{ value: 2, status: "warning" }] } };
      const { container } = render(<WidgetVisualization widget={widget} result={series(value)} />);
      return (container.querySelector("[data-gauge-number]")?.textContent ?? "").trim();
    };
    expect(gauge(5.878749999999975, 3)).toBe("5.879");
    expect(gauge(5.878749999999975, 0)).toBe("6");
    expect(gauge(5.878749999999975)).toBe("5.88");
  });

  it("a record table column reads 269.486 TiB at decimals 3 and 269 TiB in Auto", () => {
    const widget: Widget = { id: "t", title: "Files", type: "plugin", pluginId: "record-table", providerId: "p", dataKind: "records", query: "files", unit: "", layout, options: { decimals: 3 }, config: {} };
    const result: QueryResult = { records: { columns: [{ key: "name", type: "string" }, { key: "size", type: "number", unit: "bytes" }], rows: [["archive", 296303060975000]] } };
    const { container } = render(<RecordTable widget={widget} result={result} />);
    expect((container.textContent ?? "").replace(/\s+/g, "")).toContain("269.486TiB");
    const auto = render(<RecordTable widget={{ ...widget, options: {} }} result={result} />);
    expect((auto.container.textContent ?? "").replace(/\s+/g, "")).toContain("269TiB");
  });

  it("a record table column reads 269.49 TiB at decimals 2", () => {
    const widget: Widget = { id: "t", title: "Files", type: "plugin", pluginId: "record-table", providerId: "p", dataKind: "records", query: "files", unit: "", layout, options: { decimals: 2 }, config: {} };
    const result: QueryResult = { records: { columns: [{ key: "name", type: "string" }, { key: "size", type: "number", unit: "bytes" }], rows: [["archive", 296303060975000]] } };
    const { container } = render(<RecordTable widget={widget} result={result} />);
    expect((container.textContent ?? "").replace(/\s+/g, "")).toContain("269.49TiB");
  });
});
