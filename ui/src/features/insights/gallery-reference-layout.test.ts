import { describe, expect, it } from "vitest";
import { galleryDocuments } from "../../../../demo/insights-gallery/dashboards.mjs";
import { chartFixtureCollections } from "../../../e2e/fixtures/rich-chart-data";
import { dashboardSchema } from "./schema";
import { compileSloQuery } from "./slo";

const providers = { metrics: "local-prometheus", traces: "local-tempo", records: "local-postgres" };

describe("provider-backed reference compositions", () => {
  it.each([
    ["edge-watch", [
      ["ingress", 0, 0, 3, 1], ["egress", 3, 0, 3, 1], ["blocked", 6, 0, 3, 1], ["connections", 9, 0, 3, 1],
      ["flow", 0, 1, 8, 5], ["destinations", 8, 1, 4, 5],
      ["locations", 0, 6, 4, 4], ["outcomes", 4, 6, 4, 4], ["risks", 8, 6, 4, 4],
      ["blocked-requests", 0, 10, 12, 4],
    ]],
    ["reliability-room", [
      ["slo", 0, 0, 8, 4], ["incidents", 8, 0, 4, 4],
      ["burn", 0, 4, 6, 5], ["services-attention", 6, 4, 6, 5],
      ["service-timeline", 0, 9, 8, 4], ["calendar", 8, 9, 4, 4],
      ["incidents-list", 0, 13, 12, 4],
    ]],
  ] as const)("keeps %s aligned, query-backed, and isolated from source fixtures", (id, panels) => {
    const before = structuredClone(chartFixtureCollections);
    const result = galleryDocuments(providers);
    const board = dashboardSchema.parse(result.dashboards.find(board => board?.id === `local-gallery-${id}`));
    panels.forEach(([id, x, y, w, h]) => {
      expect(board.widgets.find(widget => widget.id === id)?.layout).toEqual({ x, y, w, h });
    });
    for (const widget of board.widgets) {
      if (widget.pluginId === "slo-summary") {
        // An SLO card takes its query from its config, so the stored text must be the text compiled from that config.
        expect(widget.queryRef, widget.id).toBeUndefined();
        expect(widget.query, widget.id).toBe(compileSloQuery(widget.config as never));
        continue;
      }
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

  it("reads Reliability Room availability and budget from one SLO card on the request-error SLI", () => {
    const result = galleryDocuments(providers);
    const board = dashboardSchema.parse(result.dashboards.find(board => board?.id === "local-gallery-reliability-room"));
    const card = board.widgets.find(widget => widget.id === "slo");
    expect(card?.pluginId).toBe("slo-summary");
    expect(card?.config).toMatchObject({ objective: 99.9, period: "30d", total: expect.stringContaining("paprika_demo_requests_total"), bad: expect.stringContaining('code="5xx"') });
    expect(card?.config).not.toHaveProperty("groupBy");
    const services = board.widgets.find(widget => widget.id === "services-attention");
    expect(services?.config).toMatchObject({ objective: 99.9, period: "30d", groupBy: "service", maxRows: 6 });
    // The budget is not clamped: an overspent objective must be able to show a negative remaining budget.
    expect(JSON.stringify(board.widgets)).not.toContain("clamp_min(1 -");
    // The retired availability, target, budget and attention readings must not survive in the gallery store.
    for (const retired of ["local-ab-reliability-room-availability", "local-ab-reliability-room-target", "local-ab-reliability-room-budget", "local-reliability-attention"]) {
      expect(result.savedQueries.find(query => query.id === retired), retired).toBeUndefined();
    }
    const burn = board.widgets.find(widget => widget.id === "burn")?.query ?? "";
    expect(burn).toContain('code="5xx"');
    expect(burn).not.toContain("paprika_demo_probe_up");
  });
});
