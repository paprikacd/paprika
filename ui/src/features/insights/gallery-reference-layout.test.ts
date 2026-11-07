import { describe, expect, it } from "vitest";
import { galleryDocuments } from "../../../../demo/insights-gallery/dashboards.mjs";
import { chartFixtureCollections } from "../../../e2e/fixtures/rich-chart-data";
import { dashboardSchema } from "./schema";

const providers = { metrics: "local-prometheus", traces: "local-tempo", records: "local-postgres" };

describe("provider-backed reference compositions", () => {
  it.each([
    ["edge-watch", ["ingress", "egress", "blocked", "connections"], [
      ["flow", 0, 1, 8, 5], ["destinations", 8, 1, 4, 5],
      ["locations", 0, 6, 4, 4], ["outcomes", 4, 6, 4, 4], ["risks", 8, 6, 4, 4],
      ["blocked-requests", 0, 10, 12, 4],
    ]],
    ["reliability-room", ["availability", "target", "budget"], [
      ["burn", 0, 1, 8, 5], ["services-attention", 8, 1, 4, 5],
      ["service-timeline", 0, 6, 8, 4], ["calendar", 8, 6, 4, 4],
      ["incidents-list", 0, 10, 12, 4],
    ]],
  ] as const)("keeps %s aligned, query-backed, and isolated from source fixtures", (id, stats, panels) => {
    const before = structuredClone(chartFixtureCollections);
    const result = galleryDocuments(providers);
    const board = dashboardSchema.parse(result.dashboards.find(board => board?.id === `local-gallery-${id}`));
    stats.forEach((id, index) => {
      expect(board.widgets.find(widget => widget.id === id)?.layout).toEqual({ x: index * (12 / stats.length), y: 0, w: 12 / stats.length, h: 1 });
    });
    panels.forEach(([id, x, y, w, h]) => {
      expect(board.widgets.find(widget => widget.id === id)?.layout).toEqual({ x, y, w, h });
    });
    for (const widget of board.widgets) {
      const saved = result.savedQueries.find(query => query.id === widget.queryRef?.id);
      expect(saved, widget.id).toBeDefined();
      expect(widget.query, widget.id).toBe(saved!.query);
      expect(widget.providerId, widget.id).toBe(saved!.providerId);
      for (const other of board.widgets.filter(other => other.id !== widget.id)) {
        const a = widget.layout, b = other.layout;
        expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y, `${widget.id} overlaps ${other.id}`).toBe(false);
      }
    }
    expect(chartFixtureCollections).toEqual(before);
  });
});
