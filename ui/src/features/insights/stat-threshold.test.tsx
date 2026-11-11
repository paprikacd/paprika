import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";

const stat = { id: "availability", title: "Availability", type: "stat", providerId: "p", query: "q", unit: "%", layout: { x: 0, y: 0, w: 4, h: 3 } } as const;

describe("stat readings near a threshold", () => {
  it("never rounds 99.86 across a 99.9 threshold, and keeps the exact value as the title", () => {
    const { container } = render(
      <WidgetVisualization
        widget={{ ...stat, options: { thresholds: [{ value: 99.9, color: "#36876c", label: "Objective" }] } } as never}
        result={{ series: [{ name: "availability", labels: {}, points: [{ timestamp: 1000, value: 99.86 }] }] }}
      />,
    );
    const value = container.querySelector<HTMLElement>('[data-metric-value="99.86"]');
    expect(value).not.toBeNull();
    expect(value?.textContent).toContain("99.86");
    expect(value?.textContent).not.toContain("99.9%");
    expect(value).toHaveAttribute("title", "99.86%");
  });
});
