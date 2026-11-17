import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";
import { autoAxisDomain, axisScale } from "./units";

const line = { id: "line", title: "Line", type: "timeseries", providerId: "p", query: "q", unit: "%", layout: { x: 0, y: 0, w: 6, h: 4 } } as const;
const constant = (value: number) => ({ series: [{ name: "s", labels: {}, points: [1000, 2000, 3000].map(timestamp => ({ timestamp, value })) }] });
const tickLabels = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-ts-key^="y-tick-label:"]')].map(node => node.textContent ?? "");

describe("rendered axis labels", () => {
  it("labels a constant 0.04 % series with the ticks the chart draws, all distinct", () => {
    const { container } = render(<WidgetVisualization widget={line as never} result={constant(0.04)} />);
    const rendered = tickLabels(container);
    expect(rendered.length).toBeGreaterThan(1);
    expect(new Set(rendered).size).toBe(rendered.length);
    // Labels come from the same domain the chart draws, so they match the computed scale.
    const domain = autoAxisDomain([0.04, 0.04], 3, false);
    const computed = axisScale(domain, "%", { compact: true, count: 3 }).ticks.map(tick => axisScale(domain, "%", { compact: true, count: 3 }).label(tick));
    expect(rendered).toEqual(computed);
  });

  it("labels a constant 1.5 x series with distinct ticks, not 1.4/1.5/1.5/1.6/1.6", () => {
    const { container } = render(<WidgetVisualization widget={{ ...line, unit: "x" } as never} result={constant(1.5)} />);
    const rendered = tickLabels(container);
    expect(new Set(rendered).size).toBe(rendered.length);
  });
});

describe("plugin axes share one label scale", () => {
  it("labels small-multiple extremes in one unit with distinct text", async () => {
    const { registerSmallMultiplesPlugin } = await import("./plugins/small-multiples");
    registerSmallMultiplesPlugin();
    const widget = { id: "multiples", title: "Multiples", type: "plugin", pluginId: "small-multiples", dataKind: "metrics", providerId: "p", query: "q", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 } };
    const { container } = render(<WidgetVisualization widget={widget as never} result={{ series: [{ name: "a", labels: {}, points: [998, 1001, 1003].map((value, index) => ({ timestamp: 1000 * (index + 1), value })) }] }} />);
    const axis = [...container.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find(node => node.children.length === 2 && node.children[0].tagName === "SPAN" && /\d/.test(node.children[0].textContent ?? ""));
    const extremes = [...(axis?.children ?? [])].map(node => node.textContent ?? "");
    expect(extremes).toHaveLength(2);
    expect(extremes[0]).not.toEqual(extremes[1]);
    expect(extremes.every(text => text.endsWith(" s"))).toBe(true);
  });
});
