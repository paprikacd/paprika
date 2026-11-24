import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Series } from "./chart-renderer-shared";
import type { Widget } from "./schema";
import { WidgetFooterActions } from "./widget-footer";

const widget = {
  id: "latency", type: "timeseries", title: "Latency", dataKind: "metrics", providerId: "p", query: "q",
  layout: { x: 0, y: 0, w: 6, h: 4 },
} as unknown as Widget;
const series = [{ name: "api", labels: {}, points: [{ timestamp: 1000, value: 2 }] }] as unknown as Series[];
const events = [{ timestamp: new Date(1000).toISOString(), label: "Deploy" }];

describe("WidgetFooterActions", () => {
  it("renders nothing when no action has anything to show", () => {
    const { container } = render(<WidgetFooterActions widget={widget} events={[]} inspect={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers events, the compare window, prior data and current data in that order", () => {
    const { container } = render(
      <WidgetFooterActions widget={widget} events={events} compare={<span>Compare window</span>} inspectPrior={series} inspect={series} />,
    );
    const row = container.querySelector("[data-chart-actions]");
    const labels = [...(row?.children ?? [])].map((child) => child.textContent ?? "");
    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain("event");
    expect(labels[1]).toBe("Compare window");
    expect(labels[2]).toContain("Inspect prior data");
    expect(labels[3]).toContain("Inspect data");
  });
});
