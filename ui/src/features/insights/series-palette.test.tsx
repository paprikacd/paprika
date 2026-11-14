import { cleanup, render } from "@testing-library/react";
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

/** The stroke each drawn series line carries, in draw order. jsdom keeps SVG presentation values verbatim, var() included. */
function drawnStrokes(widget: Widget, drawn: typeof series = series): string[] {
  const { container } = render(<WidgetVisualization widget={widget} result={{ series: drawn }} />);
  return [...container.querySelectorAll("path[stroke]")].map((path) => path.getAttribute("stroke") ?? "");
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

  // Name mode (the default). The identity is the labels, service=<name>, so catalog, checkout and worker take the
  // slots their identities hash to (1, 6 and 3), not their positions.
  it("draws each series in its identity slot, not its position", () => {
    expect(drawnStrokes(base)).toEqual([seriesSlot(1), seriesSlot(6), seriesSlot(3)]);
  });

  it("keeps the older position slots when a widget asks for index mode", () => {
    expect(drawnStrokes({ ...base, options: { ...base.options, seriesColorMode: "index" } })).toEqual([seriesSlot(0), seriesSlot(1), seriesSlot(2)]);
  });

  it("draws an authored label rule for its series only, and leaves the other slots", () => {
    const widget: Widget = { ...base, options: { ...base.options, seriesColors: [{ label: "service", value: "checkout", color: "#15c7a1" }] } };
    expect(drawnStrokes(widget)).toEqual([seriesSlot(1), "#15c7a1", seriesSlot(3)]);
  });

  // A widget colour applies only when the widget draws one series. With three series it is ignored.
  it("ignores a widget colour on a multi-series widget", () => {
    expect(drawnStrokes({ ...base, color: "#aa1122" })).toEqual([seriesSlot(1), seriesSlot(6), seriesSlot(3)]);
  });

  it("applies a widget colour to a single-series widget ahead of its slot", () => {
    expect(drawnStrokes({ ...base, color: "#aa1122" }, series.slice(1, 2))).toEqual(["#aa1122"]);
  });

  it("draws a role rule as its named token, ahead of the slot", () => {
    const widget: Widget = { ...base, options: { ...base.options, seriesColors: [{ label: "service", value: "worker", role: "server-error" }] } };
    // server-error claims slot 7 (zero-based 6), so checkout, whose home is 6, steps to the next free slot.
    expect(drawnStrokes(widget)).toEqual([seriesSlot(1), seriesSlot(7), seriesRole("server-error")]);
  });

  it("resolves a role rule to its named token and leaves unmatched series on their slots", () => {
    const rules = [{ label: "service", value: "worker", role: "server-error" as const }];
    expect(resolveSeriesColor({ service: "worker" }, rules, seriesSlot(2))).toBe(seriesRole("server-error"));
    expect(resolveSeriesColor({ service: "catalog" }, rules, seriesSlot(0))).toBe(seriesSlot(0));
  });
});
