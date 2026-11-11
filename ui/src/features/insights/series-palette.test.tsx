import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";
import { PALETTE } from "./chart-renderer-shared";
import type { QueryResult, Widget } from "./schema";
import { resolveSeriesColor } from "./series-colors";
import { SERIES_PALETTE, seriesRole, seriesSlot } from "./series-palette";

afterEach(cleanup);

const names = ["catalog", "checkout", "worker"];
const series: NonNullable<QueryResult["series"]> = names.map((service, index) => ({
  name: service,
  labels: { service },
  points: [{ timestamp: 1000, value: index + 1 }, { timestamp: 2000, value: index + 2 }],
}));
const base: Widget = {
  id: "rate",
  title: "Request rate by service",
  type: "timeseries",
  providerId: "prom",
  query: "rate",
  unit: "req/s",
  layout: { x: 0, y: 0, w: 8, h: 5 },
  options: { showLegend: true },
};

/** The raw legend swatch style for each series. jsdom drops var() values, so slot colours read as empty here. */
function legendSwatches(widget: Widget) {
  render(<WidgetVisualization widget={widget} result={{ series }} />);
  const list = screen.getByRole("list", { name: "Latest values by series" });
  return Object.fromEntries(names.map((name) => {
    const swatch = within(list).getByRole("listitem", { name: new RegExp(name) }).querySelector<HTMLElement>('[aria-hidden="true"]')!;
    return [name, swatch.getAttribute("style") ?? ""];
  }));
}

describe("shared series palette in time-series renderers", () => {
  it("indexes the shared slots in order and wraps after eight", () => {
    // The chart renderers index PALETTE by series position, so this list is the whole slot order they draw.
    expect(PALETTE).toBe(SERIES_PALETTE);
    PALETTE.forEach((token, index) => expect(token).toBe(seriesSlot(index)));
    expect(PALETTE[0]).toContain("var(--gamma-series-1,");
    expect(PALETTE[7]).toContain("var(--gamma-series-8,");
    expect(PALETTE[8 % PALETTE.length]).toBe(PALETTE[0]);
  });

  it("leaves series without authored colours to the slots", () => {
    const swatches = legendSwatches(base);
    for (const name of names) expect(swatches[name], name).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it("lets an authored label rule override the slot for its series only", () => {
    const widget: Widget = { ...base, options: { ...base.options, seriesColors: [{ label: "service", value: "checkout", color: "#15c7a1" }] } };
    const swatches = legendSwatches(widget);
    expect(swatches.checkout).toContain("#15c7a1");
    expect(swatches.catalog).not.toContain("#15c7a1");
    expect(swatches.worker).not.toContain("#15c7a1");
  });

  it("keeps a widget colour on the first series ahead of the slot", () => {
    const swatches = legendSwatches({ ...base, color: "#aa1122" });
    expect(swatches.catalog).toContain("#aa1122");
    expect(swatches.checkout).not.toContain("#aa1122");
  });

  it("resolves a role rule to its named token ahead of the slot", () => {
    const rules = [{ label: "service", value: "worker", role: "server-error" as const }];
    expect(resolveSeriesColor({ service: "worker" }, rules, seriesSlot(2))).toBe(seriesRole("server-error"));
    expect(resolveSeriesColor({ service: "catalog" }, rules, seriesSlot(0))).toBe(seriesSlot(0));
    expect(seriesRole("server-error")).toContain("var(--gamma-series-server-error,");
  });
});
