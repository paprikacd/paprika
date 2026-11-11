import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";
import { registerRecordChartPlugins } from "./plugins/record-charts";
import { registerSmallMultiplesPlugin } from "./plugins/small-multiples";
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge";
import { resolveTimeSeriesDomain } from "./time-series-chart";
import { axisScale, formatRecordValue, formatReading, niceAxis } from "./units";

registerRecordChartPlugins();
registerSmallMultiplesPlugin();
registerDefaultWidgetPlugins();

const base = { id: "w", title: "W", providerId: "p", query: "q", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } };
const pointSeries = (values: number[], name = "s") => ({ name, labels: { name }, points: values.map((value, index) => ({ timestamp: 60000 * (index + 1), value })) });
/** Fraction digits of a label's number, ignoring any prefix or unit. */
const fractionDigits = (text: string) => (/\.(\d+)/.exec(text)?.[1] ?? "").length;

describe("record charts use nice, reading-precision labels", () => {
  it.each([
    ["records-line", [12.3456789, 45.678912, 98.7654321]],
    ["records-bar", [812.0634, 1033.98765, 640.1234567]],
  ])("%s with non-round data labels its axis with at most two fraction digits", (pluginId, values) => {
    const widget = { ...base, type: "plugin", pluginId, dataKind: "records", config: { x: "t", y: ["v"] } };
    const result = { records: { columns: [{ key: "t", type: "number" }, { key: "v", type: "number" }], rows: values.map((value, index) => [index + 1, value]) } };
    const { container } = render(<WidgetVisualization widget={widget as never} result={result as never} />);
    const labels = [...container.querySelectorAll<SVGTextElement>("text[text-anchor='end']")].map(node => node.textContent ?? "").filter(text => /\d/.test(text));
    expect(labels.length).toBeGreaterThan(1);
    expect(Math.max(...labels.map(fractionDigits))).toBeLessThanOrEqual(2);
    expect(labels.some(label => label.includes("24.69135803") || label.includes("0.25849691K"))).toBe(false);
  });
});

describe("small multiples label extremes at reading precision", () => {
  it("shows 98.77% and 12.35% rather than eight digits", () => {
    const widget = { ...base, type: "plugin", pluginId: "small-multiples", dataKind: "metrics", unit: "%" };
    const { container } = render(<WidgetVisualization widget={widget as never} result={{ series: [pointSeries([12.3456789, 98.7654321], "cpu")] } as never} />);
    const texts = [...container.querySelectorAll("span")].map(node => node.textContent ?? "");
    expect(texts).toContain("98.77%");
    expect(texts).toContain("12.35%");
    expect(texts.some(text => /\d\.\d{3,}%/.test(text))).toBe(false);
  });
});

describe("threshold gauge keeps value, bounds and markers on one scale", () => {
  it("reads 1.23 s, 0 s, 2 s and 1.5 s together rather than 1,235 ms beside 2 s", () => {
    const widget = { ...base, type: "plugin", pluginId: "threshold-gauge", dataKind: "metrics", unit: "ms", options: { min: 0, max: 2000, thresholds: [{ value: 0, color: "#36876c" }, { value: 1500, color: "#c5584f", label: "Slow" }] } };
    const { container } = render(<WidgetVisualization widget={widget as never} result={{ series: [pointSeries([1234.5])] } as never} />);
    const text = container.textContent ?? "";
    expect(text).toContain("1.23");
    expect(text).toContain("2 s");
    expect(text).toContain("1.5 s");
    expect(text).not.toContain("ms");
  });
});

describe("metrics table compares each column on one scale", () => {
  it("gives every cell of a column the same unit", () => {
    const widget = { ...base, type: "table", unit: "ms" };
    const result = { series: [pointSeries([1033.99], "api"), pointSeries([1210.7], "web"), pointSeries([640.12, 980.4], "min")] };
    const { container } = render(<WidgetVisualization widget={widget as never} result={result as never} />);
    const rows = [...container.querySelectorAll("tbody tr")].map(row => [...row.querySelectorAll("td")].map(cell => cell.textContent ?? ""));
    expect(rows.length).toBe(3);
    for (const column of [1, 2, 3]) {
      const units = new Set(rows.map(row => (row[column] ?? "").replace(/^[-\d.,]+/, "")));
      expect(units.size).toBe(1);
    }
  });
});

describe("record precision never uses exponents and keeps every integer digit", () => {
  it.each([
    [2e15, "2,000,000,000,000,000"],
    [9.99e15, "9,990,000,000,000,000"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatRecordValue(value, "")).toBe(expected);
  });
});

describe("percent never reads 100 unless exactly 100, on either side", () => {
  it.each([
    [100.004, "100.004%"],
    [-100.004, "-100.004%"],
    [100, "100%"],
    [-100, "-100%"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatReading(value, "%").value + "%").toBe(expected);
  });
});

describe("threshold guard falls back to the exact value rather than crossing", () => {
  it("keeps 99.8999999999999999 below 99.9 at the precision limit", () => {
    const shown = formatReading(99.89999999999999, "%", { keepSides: [99.9] }).value;
    expect(Number(shown)).toBeLessThan(99.9);
  });
});

describe("byte-rate and unrecognised axis units", () => {
  it("abbreviates B/s with binary steps on axes and keeps the authored text when nothing scales", () => {
    const axis = axisScale([0, 1.4e9], "B/s", { compact: true, count: 3 });
    expect(axis.unit).toBe("GiB/s");
    expect(formatReading(5, "B/s")).toEqual({ value: "5", unit: "B/s" });
  });

  it.each(["W", "jobs", "cores", "MB/s", "req/min"])("abbreviates an unrecognised %s unit on an axis", unit => {
    const axis = axisScale([0, 1500000], unit, { compact: true, count: 4 });
    expect(axis.label(axis.ticks.at(-1)!, false)).toMatch(/[KMB]/);
  });

  it("keeps readings of unrecognised units unabbreviated", () => {
    expect(formatReading(1500, "W")).toEqual({ value: "1,500", unit: "W" });
  });
});

describe("nice ticks meet the requested count without odd fractions", () => {
  it("never places a tick at 37.5 on a 0–150 axis", () => {
    const ticks = niceAxis([0, 150], 5).ticks;
    expect(ticks).not.toContain(37.5);
    expect(ticks.every(tick => tick % 25 === 0)).toBe(true);
  });

  it("keeps a three-tick reference chart within one tick of its request", () => {
    const [low, high] = resolveTimeSeriesDomain([pointSeries([120, 180, 240])] as never, { referenceLines: [{ value: 500 }] } as never, 3)!;
    expect(low).toBeLessThanOrEqual(120);
    expect(high).toBeGreaterThanOrEqual(500);
    const ticks = axisScale([low, high], "ms", { count: 3 }).ticks;
    expect(Math.abs(ticks.length - 3)).toBeLessThanOrEqual(1);
  });
});

const FACTORS: Record<string, number> = { "": 1, B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, ms: 1e-3, s: 1, us: 1e-6, "%": 1 };
/** Each drawn gridline's value (from its key) and the value its label shows, scaled back to the authored unit. */
function gridlineAndLabel(container: HTMLElement, authoredUnit: string) {
  return [...container.querySelectorAll<HTMLElement>('[data-ts-key^="y-tick-label:"]')].map(node => {
    const drawn = Number(node.getAttribute("data-ts-key")!.replace("y-tick-label:number:", ""));
    const [, number, unit = ""] = /^(-?[\d,.]+)\s*(\S*)$/.exec(node.textContent ?? "") ?? [];
    return { drawn, shown: (Number(number?.replace(/,/g, "")) * (FACTORS[unit] ?? NaN)) / FACTORS[authoredUnit], label: node.textContent ?? "" };
  });
}

describe("each drawn gridline's value equals its label's value", () => {
  it.each([
    ["bytes 0..2000", { ...base, type: "timeseries", unit: "B" }, [0, 500, 1000, 1500, 2000]],
    ["milliseconds 10..1200", { ...base, type: "timeseries", unit: "ms" }, [10, 400, 800, 1200]],
  ])("%s", (_name, widget, values) => {
    const { container } = render(<WidgetVisualization widget={widget as never} result={{ series: [pointSeries(values)] } as never} />);
    const pairs = gridlineAndLabel(container, widget.unit);
    expect(pairs.length).toBeGreaterThan(1);
    for (const pair of pairs) expect(pair.shown).toBeCloseTo(pair.drawn, 6);
  });
});

describe("byte axis labels", () => {
  it("labels 500, 1000 and 2000 B in KiB at the values they sit at", () => {
    const axis = axisScale([0, 2000], "B", { count: 4 });
    for (const tick of axis.ticks) expect(Number(axis.label(tick, false).split(" ")[0]) * 1024).toBeCloseTo(tick, 6);
  });
});
