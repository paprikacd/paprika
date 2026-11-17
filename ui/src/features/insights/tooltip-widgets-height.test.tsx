import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Series } from "./chart-data";
import { TooltipSubWidget } from "./tooltip-widgets";
import { tooltipViewSchema, type TooltipView } from "./schema";

afterEach(cleanup);

const series: Series = {
  name: "api",
  labels: {},
  points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 3 }, { timestamp: 3000, value: 2 }],
};

describe("compact tooltip history", () => {
  it("accepts the 80 pixel height alongside the existing sizes, and refuses neighbouring values", () => {
    for (const height of [80, 120, 160, 200, 320]) expect(tooltipViewSchema.safeParse({ type: "timeseries", height }).success).toBe(true);
    for (const height of [79, 81, 100, "80"]) expect(tooltipViewSchema.safeParse({ type: "timeseries", height }).success).toBe(false);
  });

  it("draws an 80 pixel history rather than falling back to the default height", () => {
    const view: TooltipView = { type: "timeseries", height: 80 };
    render(<TooltipSubWidget view={view} series={series} unit="%" />);
    const chart = screen.getByRole("img");
    expect(chart.getAttribute("viewBox")?.split(" ")[3]).toBe("80");
  });
});
