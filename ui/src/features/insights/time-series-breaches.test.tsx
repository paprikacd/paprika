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
type Series = NonNullable<QueryResult["series"]>[number];
const series = (name: string, values: (number | null)[], minutes: number[] = values.map((_, index) => index)): Series =>
  ({ name, labels: { service: name }, points: values.map((value, index) => ({ timestamp: minutes[index] * MINUTE, value })) });
const xs = (path: Element) => [...path.getAttribute("d")!.matchAll(/[ML]([\d.e+-]+),/g)].map((match) => Number(match[1]));

/** Minute-spaced samples: warning at minutes 1-2, critical at 3, ok at 4-5, critical at 6-7, ok at 8. */
const burn: QueryResult = { series: [series("burn", [1, 2.5, 3, 6, 1, 1, 6, 6, 1])] };

describe("time-series breach shading", () => {
  it("shades each breaching stretch with its level, with no hatching", () => {
    const { container } = render(<WidgetVisualization widget={configured()} result={burn} />);
    const shaded = [...container.querySelectorAll<HTMLElement>("[data-breach-band]")];
    // Warning is drawn before critical, so critical paints over any overlap. Each level runs in time order.
    expect(shaded.map((band) => [band.dataset.level, band.dataset.from, band.dataset.to])).toEqual([
      ["warning", String(1 * MINUTE), String(3 * MINUTE)],
      ["critical", String(3 * MINUTE), String(4 * MINUTE)],
      ["critical", String(6 * MINUTE), String(8 * MINUTE)],
    ]);
    for (const band of shaded) {
      expect(band).toHaveAttribute("aria-hidden", "true");
      expect(band.className).not.toContain(hatchStyles.hatch);
      expect(Number.parseFloat(band.style.width)).toBeGreaterThan(0);
    }
  });

  it("paints critical after warning where the two levels overlap in time, so critical is never hidden", () => {
    // Payments breach at warning from minute 1 to 4; checkout breaches at critical inside that window, from minute 2 to 3.
    const overlap: QueryResult = {
      series: [
        series("payments", [1, 2.5, 2.5, 2.5, 2.5, 1], [0, 1, 2, 3, 4, 5]),
        series("checkout", [1, 1, 6, 6, 1, 1], [0, 1, 2, 3, 4, 5]),
      ],
    };
    const { container } = render(<WidgetVisualization widget={configured()} result={overlap} />);
    const shaded = [...container.querySelectorAll<HTMLElement>("[data-breach-band]")];
    const levels = shaded.map((band) => band.dataset.level);
    expect(levels).toEqual(["warning", "critical"]);
    const critical = shaded.findIndex((band) => band.dataset.level === "critical");
    const warning = shaded.findIndex((band) => band.dataset.level === "warning");
    expect(critical).toBeGreaterThan(warning);
    // Checkout is critical from minute 2 to 4 and payments is warning from minute 1 to 5.
    expect(container.querySelector("[data-breach-summary]")).toHaveTextContent("Critical · 1 interval · 2 min; Warning · 1 interval · 4 min");
  });

  it("puts every breach band before the no-sample hatches, and ends a gap-closed breach where the hatch starts", () => {
    // Samples at minutes 0, 1, 2 and 5, so the breach at minutes 1-2 is followed by a gap, which is hatched from minute 2.
    const gapped: QueryResult = { series: [series("burn", [1, 3, 3, 1], [0, 1, 2, 5])] };
    const { container } = render(<WidgetVisualization widget={configured()} result={gapped} />);
    const band = container.querySelector<HTMLElement>("[data-breach-band]")!;
    const hatch = container.querySelector<HTMLElement>("[data-no-sample-band]")!;
    expect(band).toBeInTheDocument();
    expect(hatch).toBeInTheDocument();
    expect(band.dataset.to).toBe(String(2 * MINUTE));
    expect(hatch.dataset.from).toBe(String(2 * MINUTE));
    expect(Number(band.dataset.to)).toBeLessThanOrEqual(Number(hatch.dataset.from));
    expect(band.compareDocumentPosition(hatch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("never shades past the last observed sample", () => {
    // A breach that runs to the last sample ends there, so the band cannot overhang the plotted window.
    const trailing: QueryResult = { series: [series("burn", [1, 6, 6], [0, 1, 2])] };
    const { container } = render(<WidgetVisualization widget={configured()} result={trailing} />);
    const band = container.querySelector<HTMLElement>("[data-breach-band]")!;
    expect(band.dataset.to).toBe(String(2 * MINUTE));
    expect(container.querySelector("[data-breach-summary]")).toHaveTextContent("Critical · 1 interval · 1 min");
  });

  it("reports a breach that is the last sample as a single sample, with no band", () => {
    const single: QueryResult = { series: [series("burn", [1, 6], [0, 1])] };
    const { container } = render(<WidgetVisualization widget={configured()} result={single} />);
    expect(container.querySelectorAll("[data-breach-band]")).toHaveLength(0);
    expect(container.querySelector("[data-breach-summary]")).toHaveTextContent("Critical · 1 single sample");
  });

  it("does not shade a colour-only threshold or a status that does not breach", () => {
    const { container } = render(<WidgetVisualization widget={configured([{ value: 0, color: "#e8554e" }, { value: 2, status: "info" }])} result={burn} />);
    expect(container.querySelectorAll("[data-breach-band]")).toHaveLength(0);
    expect(container.querySelector("[data-breach-summary]")).toBeNull();
  });

  it("draws the breaching stretch heavier, starting and ending on the threshold crossings of the drawn line", () => {
    const { container } = render(<WidgetVisualization widget={configured()} result={burn} />);
    const line = container.querySelector('path[stroke-width="1.8"]')!;
    // Two separate stretches are two paths, since a null break separates them.
    const heavy = [...container.querySelectorAll('path[stroke-width="3.3"]')];
    expect(heavy).toHaveLength(2);
    const plain = xs(line);
    expect(plain).toHaveLength(9);
    // Each stretch lists its vertices in order: [entry, minute 1, minute 2, minute 3, exit] and [entry, minute 6, minute 7, exit].
    // Stretch one: minute 0 is 1, minute 1 is 2.5 and the warning edge is 2, so entry is 2/3 of the way from minute 0 to 1.
    // Its exit: minute 3 is 6, minute 4 is 1 and the critical edge is 5, so the exit is 1/5 of the way from minute 3 to 4.
    // Stretch two: minute 5 is 1 and minute 6 is 6, so entry is 4/5 of the way from minute 5 to 6. Minute 7 is 6 and minute 8
    // is 1, so the exit is 1/5 of the way from minute 7 to 8.
    const first = xs(heavy[0]), second = xs(heavy[1]);
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(4);
    expect(first[0]).toBeCloseTo(plain[0] + (2 / 3) * (plain[1] - plain[0]), 2);
    expect(first[4]).toBeCloseTo(plain[3] + 0.2 * (plain[4] - plain[3]), 2);
    expect(second[0]).toBeCloseTo(plain[5] + 0.8 * (plain[6] - plain[5]), 2);
    expect(second[3]).toBeCloseTo(plain[7] + 0.2 * (plain[8] - plain[7]), 2);
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
    const calm: QueryResult = { series: [series("burn", [1, 1, 1, 1])] };
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
