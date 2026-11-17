import { expect, it } from "vitest";
import { dashboardSchema } from "./schema";
import { galleryDocuments } from "../../../../demo/insights-gallery/dashboards.mjs";
import { chartFixtureCollections } from "../../../e2e/fixtures/rich-chart-data";

it("sizes the generated five-source gauge without mutating original fixture geometry", () => {
  const before = structuredClone(chartFixtureCollections);
  const result = galleryDocuments({ metrics: "local-prometheus", traces: "local-tempo", records: "local-postgres" });
  const board = dashboardSchema.parse(result.dashboards.find(board => board?.id === "local-gallery-collection-control"));
  const gauge = board.widgets.find(widget => widget.id === "source-freshness")!;
  expect(gauge.layout).toEqual({ x: 8, y: 1, w: 4, h: 5 });
  expect(gauge.config).toMatchObject({ maxSeries: 5, seriesMode: "all", showThresholds: true, showStatus: true });
  expect(gauge.options).toMatchObject({ min: 0, max: 60 });
  expect(chartFixtureCollections).toEqual(before);
});
