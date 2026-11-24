import { describe, expect, it } from "vitest";
import type { DataKind, QueryResult } from "./schema";
import { suggestVisualizations } from "./visualization-suggestions";
import type { WidgetDefinition } from "./widget-registry";

const Renderer = () => null;
function definition(type: WidgetDefinition["type"], id: string, dataKind: DataKind, extra: Partial<WidgetDefinition> = {}): WidgetDefinition {
  return { id, type, label: id, description: id, dataKind, render: Renderer, ...extra } as WidgetDefinition;
}

const metrics = [
  definition("stat", "stat", "metrics"),
  definition("timeseries", "timeseries", "metrics"),
  definition("bar", "bar", "metrics"),
  definition("heatmap", "heatmap", "metrics"),
  definition("table", "table", "metrics"),
  definition("plugin", "distribution-heatmap", "metrics"),
  definition("plugin", "status-grid", "metrics"),
];
const traces = [definition("traces", "traces", "traces")];
const records = [
  definition("plugin", "record-table", "records"),
  definition("plugin", "geo-heatmap", "records"),
];
const all = [...metrics, ...traces, ...records];

function series(count: number, labels: Record<string, string> = {}): QueryResult {
  return { series: Array.from({ length: count }, (_, index) => ({ name: `s${index}`, labels: { ...labels, job: `job-${index}` }, points: [] })) };
}
function records_(columns: string[]): QueryResult {
  return { records: { columns: columns.map((key) => ({ key, label: key, type: "string" })) as never, rows: [] } };
}

describe("metrics suggestions", () => {
  it("offers a single value and a time series for one series", () => {
    expect(suggestVisualizations(series(1), all, "table", "metrics")).toEqual(["stat", "timeseries"]);
  });

  it("offers a time series and a bar chart for two to eight series", () => {
    expect(suggestVisualizations(series(5), all, "stat", "metrics")).toEqual(["timeseries", "bar"]);
  });

  it("offers bars and a heatmap for nine to forty series", () => {
    expect(suggestVisualizations(series(20), all, "timeseries", "metrics")).toEqual(["bar", "heatmap"]);
  });

  it("offers a heatmap and a status grid above forty series", () => {
    expect(suggestVisualizations(series(60), all, "timeseries", "metrics")).toEqual(["heatmap", "plugin:status-grid"]);
  });

  it("offers the distribution heatmap for histogram buckets", () => {
    expect(suggestVisualizations(series(1, { le: "0.5" }), all, "table", "metrics")[0]).toBe("plugin:distribution-heatmap");
  });

  it("drops the current visualization and returns at most three", () => {
    const suggested = suggestVisualizations(series(1, { le: "0.5" }), all, "stat", "metrics");
    expect(suggested).not.toContain("stat");
    expect(suggested.length).toBeLessThanOrEqual(3);
  });
});

describe("records and scores", () => {
  it("offers a geo heatmap for latitude and longitude columns", () => {
    expect(suggestVisualizations(records_(["lat", "lon", "name"]), all, "plugin:record-table", "records")).toEqual(["plugin:geo-heatmap"]);
  });

  it("offers the record table otherwise", () => {
    expect(suggestVisualizations(records_(["name"]), all, "plugin:geo-heatmap", "records")).toEqual(["plugin:record-table"]);
  });

  it("adds a plugin whose score reaches one half, and no lower score", () => {
    const high = definition("plugin", "high-fit", "metrics", { suggest: () => 0.5 });
    const low = definition("plugin", "low-fit", "metrics", { suggest: () => 0.49 });
    const suggested = suggestVisualizations(series(1), [...metrics, high, low], "table", "metrics");
    expect(suggested).toContain("plugin:high-fit");
    expect(suggested).not.toContain("plugin:low-fit");
  });
});

describe("kind isolation", () => {
  it("never offers a trace or record view for a metrics result", () => {
    const suggested = suggestVisualizations(series(1), all, "table", "metrics");
    expect(suggested.every((value) => !value.includes("traces") && !value.includes("record") && !value.includes("geo"))).toBe(true);
  });

  it("offers nothing for a trace result without a trace suggestion rule", () => {
    expect(suggestVisualizations({ traces: [] }, all, "traces", "traces")).toEqual([]);
  });
});
