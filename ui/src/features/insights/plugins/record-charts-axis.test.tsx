import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { RecordLine } from "./record-charts"
import type { QueryResult, Widget } from "../schema"

afterEach(cleanup)

// Numeric x ticks follow decimals at the tick step's precision; identifiers stay whole and ungrouped.
const line = (xKey: string, decimals: number | undefined, rows: (number | string)[][]) => {
  const widget: Widget = { id: "chart", title: "Latency", type: "plugin", pluginId: "records-line", dataKind: "records", providerId: "p", query: "records", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, options: decimals === undefined ? {} : { decimals }, config: { x: xKey, y: ["latency"] } };
  const result: QueryResult = { records: { columns: [{ key: xKey, type: "number" }, { key: "latency", type: "number", unit: "ms" }], rows } };
  return render(<RecordLine widget={widget} result={result} />);
}
const xLabels = (container: HTMLElement) => [...container.querySelectorAll('text[text-anchor="middle"]')].map(node => node.textContent ?? "");

describe("record line x axis labels", () => {
  it("writes identifier ticks whole and ungrouped at decimals 3", () => {
    const { container } = line("order_id", 3, [[10021, 5.87875], [10022, 4], [10024, 6]]);
    const labels = xLabels(container);
    expect(labels).toContain("10021");
    expect(labels).toContain("10024");
    expect(labels.join(" ")).not.toMatch(/10,02\d/);
    expect(labels.join(" ")).not.toMatch(/\.500/);
  });

  it("labels a fractional x at the tick step's precision, not collapsed to zero at decimals 0", () => {
    const { container } = line("offset", 0, [[0.3, 1], [1.8, 2], [3.3, 3]]);
    const labels = xLabels(container);
    expect(labels).toContain("0.3");
    expect(labels).toContain("3.3");
    expect(labels).not.toContain("0");
  });
});

describe("record line identifier axes", () => {
  it("names a selected identifier observation without grouping its id", () => {
    const { container } = line("order_id", 2, [[10021, 5.87875], [10022, 4], [10024, 6]]);
    const labels = [...container.querySelectorAll("[aria-label]")].map(node => node.getAttribute("aria-label") ?? "");
    expect(labels.join(" ")).toContain("10021");
    expect(labels.join(" ")).not.toContain("10,021");
  });

  it("rounds the middle tick of an identifier axis to a whole id", () => {
    const { container } = line("order_id", 2, [[10021, 5.87875], [10024, 4]]);
    const labels = xLabels(container);
    expect(labels.join(" ")).not.toMatch(/10022\.5|10023\.5/);
    expect(labels.some(label => /^\d+$/.test(label))).toBe(true);
  });

  it("labels a middle tick with an id that is present in the data, not the midpoint of two ids", () => {
    const { container } = line("order_id", 2, [[10021, 5.87875], [10022, 4], [10024, 6]]);
    const ids = xLabels(container).filter(label => /^\d+$/.test(label));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(["10021", "10022", "10024"]).toContain(id);
  });
});
