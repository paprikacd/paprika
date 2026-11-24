import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { galleryDocuments } from "../../../../demo/insights-gallery/dashboards.mjs";
import { minimumHeightsOf } from "./canvas";
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge";
import { canvasLayout, denseCanvasLayout, type CanvasMode } from "./responsive-layout";
import { dashboardSchema, type Widget } from "./schema";

// Pins the projections the canvas renders for every gallery board and for synthetic widgets that hit each
// sizing branch. The snapshot is committed before the sizing refactor. Refactors must leave it unchanged.
// Regenerate only when a projection change is intended: UPDATE_LAYOUT_PARITY=1 npx vitest run <this file>.

const snapshotPath = join(process.cwd(), "src/features/insights/testdata/responsive-layout-parity.json");
const providers = { metrics: "local-prometheus", traces: "local-tempo", records: "local-postgres" };
const widths = [1512, 900, 700, 390];
const modes: CanvasMode[] = ["wide", "compact", "stacked"];

function project(widgets: readonly Widget[]) {
  const minimumHeights = minimumHeightsOf(widgets);
  const out: Record<string, unknown> = {};
  for (const mode of modes) for (const width of widths) out[`${mode}@${width}`] = canvasLayout(widgets, mode, width, minimumHeights);
  out["dense@1512"] = denseCanvasLayout(widgets, "wide", 1512, false, minimumHeights);
  out["dense@1512:reference"] = denseCanvasLayout(widgets, "wide", 1512, true, minimumHeights);
  return out;
}

function widget(id: string, type: string, layout: { x: number; y: number; w: number; h: number }, extra: Record<string, unknown> = {}) {
  return { id, type, title: id, dataKind: "metrics", providerId: "p", query: "q", layout, ...extra } as unknown as Widget;
}

const synthetic: Widget[] = [
  widget("stat-a", "stat", { x: 0, y: 0, w: 3, h: 2 }),
  widget("stat-b", "stat", { x: 3, y: 0, w: 3, h: 2 }, { description: "Explained" }),
  widget("series", "timeseries", { x: 6, y: 0, w: 6, h: 4 }),
  widget("bars", "bar", { x: 0, y: 2, w: 6, h: 4 }),
  widget("heat", "heatmap", { x: 6, y: 4, w: 6, h: 4 }, { options: { showLabels: true, showValues: true } }),
  widget("rt-10", "plugin", { x: 0, y: 6, w: 6, h: 6 }, { pluginId: "record-table", config: { pageSize: 10 } }),
  widget("rt-spark", "plugin", { x: 6, y: 8, w: 6, h: 4 }, { pluginId: "record-table", config: { pageSize: 5, cellStyles: [{ display: "sparkline" }] } }),
  widget("rt-plain", "plugin", { x: 0, y: 12, w: 6, h: 4 }, { pluginId: "record-table", config: { pageSize: 5 } }),
  widget("cal-1", "plugin", { x: 6, y: 12, w: 6, h: 5 }, { pluginId: "incident-calendar", config: { months: 1 } }),
  widget("cal-3", "plugin", { x: 0, y: 16, w: 12, h: 6 }, { pluginId: "incident-calendar", config: { months: 3 } }),
  widget("sh-4", "plugin", { x: 0, y: 22, w: 6, h: 4 }, { pluginId: "status-history", config: { maxSeries: 4 } }),
  widget("sh-12", "plugin", { x: 6, y: 22, w: 6, h: 5 }, { pluginId: "status-history", config: { maxSeries: 12 } }),
  widget("stacked", "plugin", { x: 0, y: 27, w: 6, h: 4 }, { pluginId: "stacked-timeseries", config: { legendDisplay: "table" } }),
  widget("directional", "plugin", { x: 6, y: 27, w: 6, h: 4 }, { pluginId: "directional-traffic" }),
];

describe("responsive layout parity", () => {
  it("keeps the projections of every gallery board and synthetic widget unchanged", () => {
    registerDefaultWidgetPlugins();
    const result = galleryDocuments(providers);
    const boards = Object.fromEntries(
      result.dashboards.filter(Boolean).map((board: { id: string }) => {
        const parsed = dashboardSchema.parse(board);
        return [parsed.id, project(parsed.widgets)];
      }),
    );
    const actual = { boards, synthetic: project(synthetic) };
    if (process.env.UPDATE_LAYOUT_PARITY === "1") {
      writeFileSync(snapshotPath, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
    expect(actual).toEqual(expected);
  });
});
