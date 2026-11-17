import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";

const stat = { id: "availability", title: "Availability", type: "stat", providerId: "p", query: "q", unit: "%", layout: { x: 0, y: 0, w: 4, h: 3 } } as const;
const render1 = (value: number, unit: string, threshold: number) =>
  render(
    <WidgetVisualization
      widget={{ ...stat, unit, options: { thresholds: [{ value: threshold, color: "#36876c", label: "Objective" }] } } as never}
      result={{ series: [{ name: "availability", labels: {}, points: [{ timestamp: 1000, value }] }] }}
    />,
  );

describe("stat readings near a threshold", () => {
  // Without the guard, three-figure precision reads 99.895 as 99.9, which is exactly the objective and so on the wrong
  // side of it: the displayed value must keep its side.
  it("does not read 99.895 % as 99.9 % against a 99.9 objective", () => {
    const { container } = render1(99.895, "%", 99.9);
    const value = container.querySelector<HTMLElement>('[data-metric-value="99.895"]');
    expect(value?.textContent).toContain("99.895");
    expect(value).toHaveAttribute("title", "99.895%");
  });

  it("does not read 99.86 ms as 99.9 ms against a 99.9 ms objective", () => {
    const { container } = render1(99.86, "ms", 99.9);
    const value = container.querySelector<HTMLElement>('[data-metric-value="99.86"]');
    expect(value?.textContent).toBe("99.86ms");
    expect(value).toHaveAttribute("title", "99.86 ms");
  });

  it("keeps an exact value on the side of its threshold even at the precision limit", () => {
    const { container } = render1(99.8999999999999, "%", 99.9);
    const value = container.querySelector<HTMLElement>("[data-metric-value]");
    expect(value?.textContent).not.toContain("99.9%");
  });
});
