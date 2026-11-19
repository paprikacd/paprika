import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RecordList, RecordTable } from "./records";
import type { QueryResult, Widget } from "../schema";

afterEach(cleanup);

// A column with a scalable unit takes one scale for the whole column, so no cell mixes units or prints 15 raw digits.
const widget = (type: "plugin", pluginId: string, config: Widget["config"], decimals?: number): Widget => ({
  id: "files", title: "Files", type, pluginId, providerId: "p", dataKind: "records", query: "files", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 },
  options: decimals === undefined ? {} : { decimals }, config,
});
const result: QueryResult = {
  records: {
    columns: [{ key: "name", type: "string" }, { key: "size", type: "number", unit: "bytes" }],
    rows: [["archive", 296303060975000], ["notes", 1500000000000]],
  },
};

describe("record columns with a scalable unit", () => {
  it("shows one scale per column in the table at the widget's decimals", () => {
    const { container } = render(<RecordTable widget={widget("plugin", "records-table", {}, 2)} result={result} />);
    const text = container.textContent ?? "";
    expect(text).toContain("269.49 TiB");
    expect(text).toContain("1.36 TiB");
    expect(text).not.toContain("296303060975000");
    expect(text).not.toContain("296,303,060,975,000");
  });

  it("shows the same column scale in the record list", () => {
    const { container } = render(<RecordList widget={widget("plugin", "records-list", { title: "name", subtitle: "size" }, 2)} result={result} />);
    const text = container.textContent ?? "";
    expect(text).toContain("269.49 TiB");
    expect(text).not.toContain("296303060975000");
  });
});

describe("styled cells and identifiers read in their column's unit", () => {
  const barResult: QueryResult = {
    records: {
      columns: [{ key: "name", type: "string" }, { key: "size", type: "number", unit: "bytes" }, { key: "usage", type: "number", unit: "percent" }],
      rows: [["small", 1024], ["large", 296303060975000]],
    },
  };
  it("labels a bar cell with the text it shows, on the column scale, so a screen reader matches the sighted reading", () => {
    const bars = {
      ...widget("plugin", "records-table", { cellStyles: [{ column: "size", display: "bar", min: 0, max: 296303060975000 }] }, 3),
    };
    const { container } = render(<RecordTable widget={bars} result={barResult} />);
    const cells = [...container.querySelectorAll<HTMLElement>('[data-cell-display="bar"]')];
    // Each cell value takes its own unit step; the bounds keep the column's one scale.
    expect(cells.map(cell => cell.textContent)).toEqual(["1.000 KiB", "269.486 TiB"]);
    const labels = cells.map(cell => cell.getAttribute("aria-label") ?? "");
    expect(labels[0]).toContain("size: 1.000 KiB");
    expect(labels[1]).toContain("size: 269.486 TiB");
    // The scale bounds share the column unit and the authored decimals (3): no bound prints float noise.
    expect(labels[1]).toContain("Scale 0.000 TiB to 269.486 TiB");
    expect(labels.join(" ")).not.toMatch(/GiB|512\.000/);
  });

  it("reads a bar scale bound of 1500 ms as 1.5 s at zero decimals, not 2 s", () => {
    const latency: QueryResult = { records: { columns: [{ key: "name", type: "string" }, { key: "latency", type: "number", unit: "ms" }], rows: [["a", 0.4], ["b", 1500]] } };
    const bar = widget("plugin", "records-table", { cellStyles: [{ column: "latency", display: "bar", min: 0, max: 1500 }] }, 0);
    const { container } = render(<RecordTable widget={bar} result={latency} />);
    const labels = [...container.querySelectorAll<HTMLElement>('[data-cell-display="bar"]')].map(cell => cell.getAttribute("aria-label") ?? "");
    expect(labels[1]).toContain("Scale 0 s to 1.5 s");
  });

  it("keeps the authored decimals on a scale bound that a percent column shows", () => {
    const percent = widget("plugin", "records-table", { cellStyles: [{ column: "usage", display: "bar", min: 0, max: 200 }] }, 1);
    const { container } = render(<RecordTable widget={percent} result={{ records: { columns: [{ key: "name", type: "string" }, { key: "usage", type: "number", unit: "percent" }], rows: [["a", 78]] } }} />);
    const label = container.querySelector<HTMLElement>('[data-cell-display="bar"]')?.getAttribute("aria-label") ?? "";
    expect(label).toContain("78.0%");
    expect(label).toContain("Scale 0.0% to 200.0%");
  });

  it("shows an identifier column as stored, and keeps a measure with an identifier-like name in its unit", () => {
    const frame: QueryResult = {
      records: {
        columns: [
          { key: "order_id", type: "number" },
          { key: "retention_day", type: "number", unit: "ms" },
          { key: "rows", type: "number" },
        ],
        rows: [[10021, 86400000, 18432]],
      },
    };
    const { container } = render(<RecordTable widget={widget("plugin", "records-table", {}, 0)} result={frame} />);
    const text = container.textContent ?? "";
    expect(text).toContain("10021");
    // The column is a duration in ms: a single value of one day reads on the column's scale, in seconds.
    expect(text).toContain("86,400 s");
    expect(text).toContain("18,432");
    expect(text).not.toContain("10,021");
  });
});

describe("record cells scale each value on its own", () => {
  const mixed: QueryResult = {
    records: {
      columns: [{ key: "name", type: "string" }, { key: "size", type: "number", unit: "bytes" }],
      rows: [["tiny", 1023.6], ["huge", 296303060975000]],
    },
  };

  it("shows a small and a large value of one bytes column in their own units, not one column scale", () => {
    const { container } = render(<RecordTable widget={widget("plugin", "records-table", {}, 3)} result={mixed} />);
    const text = container.textContent ?? "";
    expect(text).toContain("1.000 KiB");
    expect(text).toContain("269.486 TiB");
    expect(text).not.toContain("0.000 TiB");
    expect(text).not.toMatch(/e-\d/);
  });

  it("reads a styled bar cell with its own unit in the value, its label and its scale", () => {
    const styled = widget("plugin", "records-table", { cellStyles: [{ column: "size", display: "bar", min: 0, max: 296303060975000, unit: "bytes" }] }, 3);
    const { container } = render(<RecordTable widget={styled} result={mixed} />);
    const cells = [...container.querySelectorAll<HTMLElement>('[data-cell-display="bar"]')];
    expect(cells.map(cell => cell.textContent)).toEqual(["1.000 KiB", "269.486 TiB"]);
    expect(cells[0].getAttribute("aria-label")).toContain("size: 1.000 KiB");
    expect(cells[1].getAttribute("aria-label")).not.toMatch(/296,303|296303/);
  });

  it("scales a styled cell by the unit its style names when the column has none", () => {
    const bare: QueryResult = { records: { columns: [{ key: "name", type: "string" }, { key: "size", type: "number" }], rows: [["tiny", 1023.6], ["huge", 296303060975000]] } };
    for (const [unit, expected] of [["bytes", ["1.000 KiB", "269.486 TiB"]]] as const) {
      cleanup();
      const styled = widget("plugin", "records-table", { cellStyles: [{ column: "size", display: "bar", min: 0, max: 296303060975000, unit }] }, 3);
      const { container } = render(<RecordTable widget={styled} result={bare} />);
      const cells = [...container.querySelectorAll<HTMLElement>('[data-cell-display="bar"]')];
      expect(cells.map(cell => cell.textContent)).toEqual(expected);
      for (const cell of cells) expect(cell.getAttribute("aria-label")).not.toMatch(/\d{3},\d{3},\d{3},\d{3}|\d{15}/);
    }
    cleanup();
    const ms: QueryResult = { records: { columns: [{ key: "name", type: "string" }, { key: "wait", type: "number" }], rows: [["api", 1500]] } };
    const timed = widget("plugin", "records-table", { cellStyles: [{ column: "wait", display: "bar", min: 0, max: 2000, unit: "ms" }] }, 3);
    const { container } = render(<RecordTable widget={timed} result={ms} />);
    expect(container.querySelector('[data-cell-display="bar"]')?.textContent).toBe("1.500 s");
  });
});

