// Fails at width 300 before resolve() looked up bucket.sourceCells: a narrow plot resamples windows the keyed lookup had dropped.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DistributionHeatmap } from "./rich-metrics";
import type { QueryResult, Widget } from "../schema";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const widget: Widget = { id: "latency", title: "Latency distribution", type: "plugin", pluginId: "distribution-heatmap", providerId: "metrics", dataKind: "metrics", query: "buckets", unit: "ms", layout: { x: 0, y: 0, w: 4, h: 6 }, config: { bucketLabel: "le", bucketUnit: "ms", densityUnit: "observations/s", maxColumns: 48 } };
const buckets = ["10", "25", "50", "100", "250", "500", "+Inf"];
const result: QueryResult = { series: buckets.map((le, b) => ({ name: `≤ ${le}`, labels: { le }, points: Array.from({ length: 61 }, (_, i) => ({ timestamp: (i + 1) * 60000, value: i === 27 || i === 28 ? null : (b + 1) * 1000 + i * (b + 1) * (b < 5 ? 3 + ((i * 7) % 5) : 1) })) })) };

describe("distribution hover on a sampled narrow plot", () => {
  it.each([250, 300, 330])("every drawn column opens at width %i", (width) => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, width, height: 240, left: 0, right: width, top: 0, bottom: 240, toJSON() {} }));
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const { container } = render(<DistributionHeatmap widget={widget} result={result} />);
    const chart = screen.getByRole("group", { name: /histogram buckets/ });
    const columns = [...new Set([...container.querySelectorAll("[data-bucket-value]")].map(cell => cell.getAttribute("data-timestamp")))];
    fireEvent.focus(chart);
    let closed = 0;
    for (let index = columns.length - 2; index >= 0; index--) {
      act(() => { fireEvent.keyDown(chart, { key: "ArrowLeft" }); });
      if (!screen.queryByRole("region", { name: "Observation details" })) { closed++; fireEvent.keyDown(chart, { key: "Enter" }); }
    }
    expect(closed).toBe(0);
  });
});
