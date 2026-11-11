import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";
import { EmbeddedWidgetProvider } from "./widget-presentation";
import hatchStyles from "./plot-hatch.module.css";
import type { QueryResult, Threshold, Widget } from "./schema";

afterEach(cleanup);

const MINUTE = 60_000;
const bands: Threshold[] = [
  { value: 0, status: "ok" },
  { value: 2, status: "warning" },
  { value: 5, status: "critical" },
];
const widget: Widget = { id: "burn", title: "Availability burn", type: "timeseries", providerId: "metrics", query: "burn", unit: "x", layout: { x: 0, y: 0, w: 8, h: 4 } };
const configured = (thresholds: Threshold[] = bands, extra: Partial<NonNullable<Widget["options"]>> = {}): Widget => ({ ...widget, options: { thresholds, ...extra } });

/** Minute-spaced samples: warning from minute 1 to 2, critical at 3, ok at 4-5, critical at 6-7, ok at 8. */
const burn: QueryResult = {
  series: [{
    name: "burn",
    labels: { service: "api" },
    points: [1, 2.5, 3, 6, 1, 1, 6, 6, 1].map((value, index) => ({ timestamp: index * MINUTE, value })),
  }],
};

describe("time-series breach shading", () => {
  it("shades each breaching stretch with its level, with no hatching", () => {
    const { container } = render(<WidgetVisualization widget={configured()} result={burn} />);
    const shaded = [...container.querySelectorAll<HTMLElement>("[data-breach-band]")];
    // Critical spans are drawn before warning spans, each in time order.
    expect(shaded.map((band) => [band.dataset.level, band.dataset.from, band.dataset.to])).toEqual([
      ["critical", String(3 * MINUTE), String(4 * MINUTE)],
      ["critical", String(6 * MINUTE), String(8 * MINUTE)],
      ["warning", String(1 * MINUTE), String(3 * MINUTE)],
    ]);
    for (const band of shaded) {
      expect(band).toHaveAttribute("aria-hidden", "true");
      expect(band.className).not.toContain(hatchStyles.hatch);
      expect(Number.parseFloat(band.style.width)).toBeGreaterThan(0);
    }
  });

  it("does not shade a colour-only threshold or a status that does not breach", () => {
    const { container } = render(<WidgetVisualization widget={configured([{ value: 0, color: "#e8554e" }, { value: 2, status: "info" }])} result={burn} />);
    expect(container.querySelectorAll("[data-breach-band]")).toHaveLength(0);
    expect(container.querySelector("[data-breach-summary]")).toBeNull();
  });

  it("emphasises the breaching stretch of the series with a heavier stroke", () => {
    const { container } = render(<WidgetVisualization widget={configured()} result={burn} />);
    const plain = container.querySelectorAll('path[stroke-width="1.8"]').length;
    const heavy = container.querySelectorAll('path[stroke-width="3.3"]');
    expect(plain).toBeGreaterThan(0);
    expect(heavy.length).toBeGreaterThan(0);
  });

  it("draws no shading or emphasis when the widget is embedded", () => {
    const { container } = render(
      <EmbeddedWidgetProvider>
        <WidgetVisualization widget={configured()} result={burn} />
      </EmbeddedWidgetProvider>,
    );
    expect(container.querySelectorAll("[data-breach-band]")).toHaveLength(0);
    expect(container.querySelector('path[stroke-width="3.3"]')).toBeNull();
    expect(container.querySelector("[data-breach-summary]")).toBeNull();
  });

  it("draws no shading for a series with no breaches", () => {
    const calm: QueryResult = { series: [{ name: "burn", labels: {}, points: [1, 1, 1, 1].map((value, index) => ({ timestamp: index * MINUTE, value })) }] };
    const { container } = render(<WidgetVisualization widget={configured()} result={calm} />);
    expect(container.querySelectorAll("[data-breach-band]")).toHaveLength(0);
    expect(container.querySelector("[data-breach-summary]")).toBeNull();
  });
});

describe("time-series breach summary", () => {
  it("names each breaching level, its intervals and its time in breach in the footer", () => {
    const { container } = render(<WidgetVisualization widget={configured()} result={burn} />);
    const summary = container.querySelector<HTMLElement>("[data-breach-summary]")!;
    expect(summary).toBeInTheDocument();
    const critical = summary.querySelector('[data-breach-level="critical"]')!;
    const warning = summary.querySelector('[data-breach-level="warning"]')!;
    expect(critical).toHaveTextContent("Critical · 2 intervals · 3 min");
    expect(warning).toHaveTextContent("Warning · 1 interval · 2 min");
    expect(summary).toHaveTextContent("Critical · 2 intervals · 3 min; Warning · 1 interval · 2 min");
  });

  it("says when the result is partial", () => {
    const { container } = render(<WidgetVisualization widget={configured()} result={{ ...burn, truncated: true }} />);
    expect(container.querySelector("[data-breach-summary]")).toHaveTextContent("partial result");
  });
});
