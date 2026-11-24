import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowProvider } from "../dashboard-window";
import { SavedQueryLibraryProvider } from "../saved-query-context";
import type { QueryResult, Widget } from "../schema";
import { DistributionHeatmap } from "./rich-metrics";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const widget: Widget = { id: "latency", title: "Latency distribution", type: "plugin", pluginId: "distribution-heatmap", providerId: "metrics", dataKind: "metrics", query: "buckets", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 }, config: { maxColumns: 120, traces: { providerId: "traces" } } } as Widget;
const series = (le: string, points: number[]): NonNullable<QueryResult["series"]>[number] => ({ name: `bucket ${le}`, labels: { le, route: "/checkout" }, points: points.map((value, index) => ({ timestamp: (index + 1) * 1000, value })) });
const result: QueryResult = { series: [series("10", [1, 1, 1, 1]), series("50", [2, 2, 3, 3]), series("+Inf", [3, 4, 5, 6])] };

// jsdom has no pointer capture, and fireEvent's generic events carry no button or primary flag, so the test builds mouse events
// that carry the pointer fields the brush reads.
function pointer(type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: type === "pointerup" ? 0 : 1 });
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
  return event;
}

// The plot's width comes from its container, and its hit areas from the svg; both are the same 600 by 240 box here.
function geometry() {
  Object.assign(Element.prototype, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => true });
  const box = { x: 0, y: 0, width: 600, height: 240, top: 0, left: 0, right: 600, bottom: 240, toJSON: () => ({}) };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(box);
  return vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue(box);
}

function drag(chart: Element, from: [number, number], to: [number, number], pointerId: number) {
  fireEvent(chart, pointer("pointerdown", from[0], from[1], pointerId));
  fireEvent(chart, pointer("pointermove", to[0], to[1], pointerId));
  fireEvent(chart, pointer("pointerup", to[0], to[1], pointerId));
}

describe("latency regions", () => {
  it("a short drag is an ordinary click, so it makes no region", () => {
    geometry();
    const { container } = render(<DistributionHeatmap widget={widget} result={result} />);
    drag(screen.getByRole("group", { name: /histogram buckets/ }), [300, 120], [303, 122], 1);
    expect(container.querySelector("[data-distribution-region]")).toBeNull();
  });

  it("a larger drag selects columns and buckets, does not set the dashboard range, and Escape clears it", async () => {
    geometry();
    const apply = vi.fn();
    const { container } = render(<DashboardWindowProvider value={{ apply }}><DistributionHeatmap widget={widget} result={result} /></DashboardWindowProvider>);
    const chart = screen.getByRole("group", { name: /histogram buckets/ });
    drag(chart, [200, 60], [500, 200], 2);
    expect(container.querySelector("[data-distribution-region]")).not.toBeNull();
    expect(apply).not.toHaveBeenCalled();
    expect(await screen.findByRole("region", { name: "Selected latency region" })).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(container.querySelector("[data-distribution-region]")).toBeNull();
  });

  it("offers the region's traces to the Explorer as a seeded trace search", async () => {
    geometry();
    const onOpenExplorer = vi.fn();
    const { container } = render(<SavedQueryLibraryProvider queries={[]} variables={[]} values={{}} onOpenExplorer={onOpenExplorer}><DistributionHeatmap widget={widget} result={result} /></SavedQueryLibraryProvider>);
    drag(screen.getByRole("group", { name: /histogram buckets/ }), [200, 60], [500, 200], 3);
    expect(container.querySelector("[data-distribution-region]")).not.toBeNull();
    const panel = await screen.findByRole("region", { name: "Selected latency region" });
    await act(async () => { within(panel).getByRole("button", { name: "Traces in this range" }).click(); });
    expect(onOpenExplorer).toHaveBeenCalledWith(expect.objectContaining({ providerId: "traces", kind: "traces" }));
  });
});
