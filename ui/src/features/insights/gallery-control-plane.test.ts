import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { galleryDocuments } from "../../../../demo/insights-gallery/dashboards.mjs";
import { chartFixtureCollections } from "../../../e2e/fixtures/rich-chart-data";
import { dashboardSchema } from "./schema";

const providers = { metrics: "local-prometheus", traces: "local-tempo", records: "local-postgres" };
const starterPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../internal/insights/starters/paprika-control-plane.json");
const starter = JSON.parse(readFileSync(starterPath, "utf8")) as { widgets: Array<Record<string, unknown>> };

describe("Paprika control-plane gallery copy", () => {
  it("parses and renders the starter's widgets against the local metrics provider", () => {
    const before = structuredClone(chartFixtureCollections);
    const result = galleryDocuments(providers);
    const copy = result.dashboards.find(dashboard => dashboard?.id === "local-gallery-control-plane");
    expect(copy).toBeDefined();
    expect(() => dashboardSchema.parse(copy)).not.toThrow();
    expect(copy!.widgets).toEqual(starter.widgets.map(widget => ({ ...widget, providerId: providers.metrics })));
    expect(copy!.widgets.map(widget => widget.id)).toEqual(starter.widgets.map(widget => widget.id));
    expect(chartFixtureCollections).toEqual(before);
  });

  it("keeps every gallery widget on the starter's grid without overlaps", () => {
    const result = galleryDocuments(providers);
    const copy = result.dashboards.find(dashboard => dashboard?.id === "local-gallery-control-plane")!;
    const boxes = copy.widgets.map(widget => ({ id: widget.id, ...(widget.layout as { x: number; y: number; w: number; h: number }) }));
    for (const a of boxes) {
      expect(a.x + a.w).toBeLessThanOrEqual(12);
      for (const b of boxes) {
        if (a === b) continue;
        expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });
});
