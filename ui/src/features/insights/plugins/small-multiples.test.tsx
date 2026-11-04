import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QueryResult, Widget } from "../schema";
import { getWidgetDefinition } from "../widget-registry";
import { registerSmallMultiplesPlugin, SmallMultiples, smallMultiplesDomains, smallMultiplesPath } from "./small-multiples";

const widget: Widget = { id: "hosts", title: "Host trends", type: "plugin", pluginId: "small-multiples", dataKind: "metrics", providerId: "metrics", query: "up", unit: "%", layout: { x: 0, y: 0, w: 8, h: 4 }, config: { columns: 2, maxSeries: 2, maxPoints: 8 } };
const result: QueryResult = { series: [
  { name: "alpha", labels: { instance: "alpha" }, points: [{ timestamp: 1000, value: 0 }, { timestamp: 2000, value: null }, { timestamp: 3000, value: 10 }] },
  { name: "beta", labels: { instance: "beta" }, points: [{ timestamp: 2000, value: -4 }, { timestamp: 4000, value: 20 }] },
  { name: "omitted", labels: {}, points: [{ timestamp: 5000, value: 500 }] },
] };

describe("small multiples", () => {
  it("uses shared domains from the unsampled displayed series and keeps null gaps", () => {
    const selected = result.series!.slice(0, 2), domain = smallMultiplesDomains(selected, undefined)!;
    expect(domain).toEqual({ start: 1000, end: 4000, min: -4, max: 20 });
    expect(smallMultiplesPath(selected[0].points, domain).match(/M/g)).toHaveLength(2);
    const { container } = render(<SmallMultiples widget={widget} result={result} />);
    const plots = [...container.querySelectorAll("[data-domain-start]")];
    expect(plots).toHaveLength(2);
    expect(plots.map(plot => [plot.getAttribute("data-domain-start"), plot.getAttribute("data-domain-end"), plot.getAttribute("data-domain-min"), plot.getAttribute("data-domain-max")])).toEqual([["1000", "4000", "-4", "20"], ["1000", "4000", "-4", "20"]]);
    expect(screen.getByText("Showing 2 of 3 series")).toBeInTheDocument();
  });
  it("uses configured bounds, handles constant or empty observations and clips marks to the scale", () => {
    expect(smallMultiplesDomains(result.series!.slice(0, 2), { min: 0, max: 100 })).toEqual({ start: 1000, end: 4000, min: 0, max: 100 });
    const constant = [{ name: "flat", labels: {}, points: [{ timestamp: 1000, value: 5 }] }];
    expect(smallMultiplesDomains(constant, undefined)).toEqual({ start: 1000, end: 1001, min: 4, max: 5 });
    expect(smallMultiplesDomains([], undefined)).toBeUndefined();
    const { container } = render(<SmallMultiples widget={{ ...widget, options: { min: 0, max: 100 } }} result={result} />);
    expect(container.querySelectorAll("clipPath rect")).toHaveLength(2);
    expect(container.querySelectorAll('[data-multiple-series="alpha"] [data-isolated-sample]')).toHaveLength(2);
  });
  it("inspects exact recorded samples by keyboard and selects null without reviving an old value", () => {
    const onContextChange = vi.fn();
    render(<SmallMultiples widget={widget} result={result} onContextChange={onContextChange} />);
    const plot = screen.getByRole("group", { name: /alpha trend/ });
    fireEvent.focus(plot);
    expect(screen.getByRole("tooltip")).toHaveTextContent("10%");
    expect(plot).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("No data");
    fireEvent.keyDown(plot, { key: "Enter" });
    expect(onContextChange).toHaveBeenLastCalledWith({ labels: { instance: "alpha" }, series: "alpha", value: null });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  it("keeps deliberate selection available when tooltips are off, without nesting embedded controls", () => {
    const onContextChange = vi.fn();
    const { rerender } = render(<SmallMultiples widget={{ ...widget, options: { showTooltip: false } }} result={result} onContextChange={onContextChange} />);
    const plot = screen.getByRole("group", { name: /alpha trend/ });
    fireEvent.focus(plot); fireEvent.keyDown(plot, { key: "ArrowLeft" }); fireEvent.keyDown(plot, { key: "ArrowLeft" }); fireEvent.keyDown(plot, { key: "Enter" });
    expect(onContextChange).toHaveBeenLastCalledWith({ labels: { instance: "alpha" }, series: "alpha", value: 0 });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    rerender(<SmallMultiples widget={widget} result={result} embedded />);
    expect(screen.getByRole("group", { name: /alpha trend/ })).not.toHaveAttribute("tabindex");
  });
  it("compacts generated node labels while retaining exact identities and authored names", () => {
    const generated: QueryResult = { series: [
      { name: '{cluster="omega", node="node-01"}', labels: { cluster: "omega", node: "node-01" }, points: [{ timestamp: 1000, value: 42 }] },
      { name: '{cluster="omega", node="node-02"}', labels: { cluster: "omega", node: "node-02" }, points: [{ timestamp: 1000, value: 43 }] },
    ] };
    const onContextChange = vi.fn();
    const { rerender } = render(<SmallMultiples widget={widget} result={generated} onContextChange={onContextChange} />);
    expect(screen.getByText("node-01")).toHaveAttribute("title", generated.series![0].name);
    const plot = screen.getByRole("group", { name: /cluster="omega", node="node-01"/ });
    fireEvent.focus(plot); fireEvent.keyDown(plot, { key: "Enter" });
    expect(onContextChange).toHaveBeenLastCalledWith({ labels: generated.series![0].labels, series: generated.series![0].name, value: 42 });
    expect(screen.getByRole("tooltip")).toHaveTextContent('cluster="omega"');
    const duplicate: QueryResult = { series: [...generated.series!, { ...generated.series![0], name: '{cluster="delta", node="node-01"}', labels: { cluster: "delta", node: "node-01" } }] };
    rerender(<SmallMultiples widget={widget} result={duplicate} />);
    expect(screen.getByText("node=node-01 · cluster=omega")).toBeInTheDocument();
    rerender(<SmallMultiples widget={widget} result={{ series: [{ ...generated.series![0], name: "Primary worker" }, generated.series![1]] }} />);
    expect(screen.getByText("Primary worker")).toBeInTheDocument();
  });
  it("registers safe, bounded authoring configuration idempotently", () => {
    registerSmallMultiplesPlugin(); registerSmallMultiplesPlugin();
    const definition = getWidgetDefinition("plugin", "small-multiples")!;
    expect(definition.dataKind).toBe("metrics");
    expect(definition.parseConfig!({ columns: 3, maxPoints: 120 })).toEqual({ columns: 3, maxPoints: 120 });
    expect(() => definition.parseConfig!({ maxSeries: 13 })).toThrow();
    expect(() => definition.parseConfig!({ columns: 2, other: true })).toThrow();
  });
});
