import { describe, expect, it } from "vitest";
import { minimumHeightsOf } from "./canvas";
import { canvasLayout } from "./responsive-layout";
import { registerSloSummaryPlugin, sloMinHeight } from "./plugins/slo-summary";
import type { Widget } from "./schema";

// The slo-summary plugin is listed in the library. Its widgets take the intrinsic minimum height the plugin declares,
// whether or not the plugin is listed.
describe("canvas minimum heights", () => {
  it("applies the plugin minimum height to a listed plugin widget", () => {
    registerSloSummaryPlugin();
    const widget = {
      id: "slo", type: "plugin", pluginId: "slo-summary", title: "SLO", dataKind: "metrics", providerId: "p",
      query: "q", layout: { x: 0, y: 0, w: 6, h: 2 },
    } as unknown as Widget;
    expect(minimumHeightsOf([widget]).get("slo")).toBe(360);
  });

  it("grows a narrow projection so a short saved objective card keeps its phone-width height", () => {
    registerSloSummaryPlugin();
    const widget = {
      id: "slo", type: "plugin", pluginId: "slo-summary", title: "SLO", dataKind: "metrics", providerId: "p",
      query: "q", layout: { x: 0, y: 0, w: 6, h: 5 },
    } as unknown as Widget;
    const layout = canvasLayout([widget], "stacked", 390, minimumHeightsOf([widget]));
    // The grid track is 74px with a 16px allowance, so a 360px minimum needs at least six tracks.
    expect(layout.find(item => item.i === "slo")?.h).toBeGreaterThanOrEqual(6);
  });
});

// A services card lists up to maxRows groups, so its minimum height grows with the cap and a listed row is never clipped.
describe("services card minimum height", () => {
  const services = (maxRows?: number) => ({
    id: "slo", type: "plugin", pluginId: "slo-summary", title: "SLO", dataKind: "metrics", providerId: "p", query: "q",
    layout: { x: 0, y: 0, w: 12, h: 5 },
    config: { objective: 99.9, period: "30d", total: "http_requests_total{service=~\"a|b\"}", bad: "http_requests_total{code=\"5xx\"}", groupBy: "service", ...(maxRows === undefined ? {} : { maxRows }) },
  }) as unknown as Widget;
  // A grid track is 74px and a card of h tracks is h * 74 - 16 px tall.
  const pixels = (h: number) => h * 74 - 16;

  it("derives the minimum from the six-row default and the row cap", () => {
    registerSloSummaryPlugin();
    expect(minimumHeightsOf([services()]).get("slo")).toBe(130 + 6 * 64);
    expect(minimumHeightsOf([services(6)]).get("slo")).toBe(sloMinHeight(services(6).config));
    // Twelve rows are valid only without the multiwindow preset, whose 16-series groups cap the rows at six.
    const twelve = { ...services(12), config: { ...(services(12).config as object), burnAlerts: "none" } } as unknown as Widget;
    expect(minimumHeightsOf([twelve]).get("slo")).toBe(130 + 12 * 64);
  });

  it("fits six rows and the truncation note in a 12-wide five-row card on a desktop canvas", () => {
    registerSloSummaryPlugin();
    const widget = services(6);
    const layout = canvasLayout([widget], "compact", 1512, minimumHeightsOf([widget]));
    const h = layout.find(item => item.i === "slo")?.h ?? 0;
    expect(pixels(h)).toBeGreaterThanOrEqual(sloMinHeight(widget.config));
  });

  it("fits six two-line rows and the truncation note in a 12-wide five-row card at phone width", () => {
    registerSloSummaryPlugin();
    const widget = services(6);
    const layout = canvasLayout([widget], "stacked", 390, minimumHeightsOf([widget]));
    const h = layout.find(item => item.i === "slo")?.h ?? 0;
    expect(pixels(h)).toBeGreaterThanOrEqual(130 + 6 * 48);
  });

  it("keeps a single objective at its fixed minimum", () => {
    registerSloSummaryPlugin();
    const single = { ...services(), config: { objective: 99.9, period: "30d", total: "up", bad: "up{code=\"5xx\"}" } } as unknown as Widget;
    expect(minimumHeightsOf([single]).get("slo")).toBe(360);
  });
});
