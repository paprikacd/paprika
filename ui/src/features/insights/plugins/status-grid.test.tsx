import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, Widget } from "../schema";
import { StatusGrid, latestStatusPoint, statusGridConfigSchema } from "./status-grid";

afterEach(cleanup);
const widget: Widget = { id:"status", title:"Current monitors", type:"plugin", pluginId:"status-grid", providerId:"metrics", query:"up", unit:"", layout:{ x:0,y:0,w:8,h:4 }, options:{ decimals:2 } };
const series = (name: string, values: (number | null)[]): NonNullable<QueryResult["series"]>[number] => ({ name, labels:{ service:name }, points:values.map((value,index) => ({ timestamp:Date.UTC(2026,0,1,0,index),value })) });

describe("monitor status grid", () => {
  it("pins the cell that was clicked when two monitors share a name", () => {
    render(<StatusGrid widget={widget} result={{ series:[series("api",[1]),series("api",[0])] }} />);
    const cells = screen.getAllByRole("button", { name: /api: / });
    fireEvent.click(cells[1]);
    expect(cells[1]).toHaveAttribute("aria-pressed", "true");
    expect(cells[0]).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("tooltip")).toHaveTextContent("0");
  });
  it("uses the newest timestamp, including null, without reviving older status", () => {
    const input = series("api",[1,0,null]);
    input.points = [input.points[2],input.points[0],input.points[1]];
    expect(latestStatusPoint(input)?.value).toBeNull();
    render(<StatusGrid widget={widget} result={{ series:[input,series("worker",[0,1])] }} />);
    expect(screen.getByRole("button",{name:/api: No data · Unknown/})).toHaveAttribute("data-status-value","unknown");
    expect(screen.getByRole("button",{name:/worker: 1 · Healthy/})).toHaveAttribute("data-status-value","1");
    expect(screen.getByRole("group",{name:"Monitor status legend"})).toHaveTextContent("Unknown 1");
  });
  it("uses configured thresholds and reports exact selection without fabricating a status", () => {
    const select = vi.fn();
    const options = { ...widget.options, thresholds:[{value:0,color:"#10aa33",label:"Healthy"},{value:4,color:"#dd4422",label:"Warning"}] };
    render(<StatusGrid widget={{...widget,options}} result={{series:[series("db",[4.126]),series("empty",[null])]}} onContextChange={select} />);
    const status = screen.getByRole("button",{name:/db: 4.13 · Warning/});
    fireEvent.click(status);
    expect(select).toHaveBeenLastCalledWith({ labels:{service:"db"}, value:4.126, series:"db" });
    expect(screen.getByRole("tooltip").querySelector('[data-metric-value="4.126"]')).toHaveTextContent("4.13");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Warning");
    fireEvent.click(screen.getByRole("button",{name:/empty: No data/}));
    expect(select).toHaveBeenLastCalledWith({ labels:{service:"empty"}, value:null, series:"empty" });
  });
  it("adds a glyph chip and a 1 px or 2 px inset stroke for status bands, and leaves hex-only bands unmarked", () => {
    const statusOptions = { ...widget.options, thresholds: [{ value: 0, status: "critical" as const, label: "Down" }, { value: 2, status: "warning" as const, label: "Degraded" }, { value: 4, status: "ok" as const, label: "Up" }] };
    const { unmount } = render(<StatusGrid widget={{ ...widget, options: statusOptions }} result={{ series: [series("down", [0]), series("warn", [2]), series("up", [5])] }} />);
    expect(screen.getByRole("button", { name: /down: 0 · Down/ })).toHaveAttribute("data-status-stroke", "critical");
    expect(screen.getByRole("button", { name: /warn: 2 · Degraded/ })).toHaveAttribute("data-status-stroke", "warning");
    expect(screen.getByRole("button", { name: /up: 5 · Up/ })).not.toHaveAttribute("data-status-stroke");
    const legend = screen.getByRole("group", { name: "Monitor status legend" });
    expect(legend.querySelectorAll("[data-status]")).toHaveLength(3);
    expect(legend.querySelector('[data-status="critical"]')).toHaveTextContent("Critical: Down");
    unmount();
    const hex = render(<StatusGrid widget={{ ...widget, options: { ...widget.options, thresholds: [{ value: 0, color: "#10aa33", label: "Healthy" }, { value: 4, color: "#dd4422", label: "Warning" }] } }} result={{ series: [series("down", [0]), series("up", [5])] }} />);
    expect(hex.container.querySelector("[data-status-stroke]")).toBeNull();
    expect(hex.container.querySelector("[data-status]")).toBeNull();
  });
  it("bounds series and reports omissions and partial provider responses", () => {
    expect(() => statusGridConfigSchema.parse({maxSeries:2049})).toThrow();
    render(<StatusGrid widget={{...widget,config:{maxSeries:2}}} result={{series:[series("one",[1]),series("two",[0]),series("three",[1])],truncated:true}} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText("Showing 2 of 3")).toBeInTheDocument();
    expect(screen.getByText("Provider response may be incomplete")).toBeInTheDocument();
  });
  it("supports a single tab stop, arrow navigation, exact pinned details and Escape", () => {
    const result = {series:[series("api",[1]),series("worker",[0]),series("cron",[null])]};
    const { container, rerender } = render(<StatusGrid widget={widget} result={result} />);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("[data-status-index]")];
    expect(buttons.filter(button=>button.tabIndex===0)).toEqual([buttons[0]]);
    fireEvent.focus(buttons[0]); fireEvent.keyDown(buttons[0],{key:"ArrowRight"});
    expect(buttons[1]).toHaveFocus();
    fireEvent.click(buttons[1]);
    expect(buttons[1]).toHaveAttribute("aria-pressed","true");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Unhealthy");
    fireEvent.keyDown(buttons[1],{key:"Escape"});
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.focus(buttons[0]);
    // The same monitor stays open across a refresh and shows its new reading.
    rerender(<StatusGrid widget={widget} result={{series:[series("api",[null])]}} />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("No data");
  });
  it("closes a hovered preview after the pointer leaves, even while another cell keeps focus", () => {
    vi.useFakeTimers();
    try {
      const result = { series: [series("api", [1]), series("worker", [0]), series("cron", [1]), series("db", [0])] };
      const { container } = render(<StatusGrid widget={widget} result={result} />);
      const buttons = [...container.querySelectorAll<HTMLButtonElement>("[data-status-index]")];
      // Keyboard focus stays on the first cell while the pointer visits another one.
      act(() => buttons[0].focus());
      expect(buttons[0]).toHaveFocus();
      fireEvent.pointerEnter(buttons[3], { pointerType: "mouse" });
      expect(screen.getByRole("tooltip")).toHaveTextContent("db");
      fireEvent.pointerLeave(buttons[3]);
      act(() => { vi.advanceTimersByTime(200); });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      expect(buttons[0]).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps a pinned monitor open on the same monitor when a refresh changes its value or order", () => {
    const first = [series("api", [1]), series("worker", [0])];
    const { container, rerender } = render(<StatusGrid widget={widget} result={{ series: first }} />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-status-index="1"]')!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Unhealthy");
    // Same monitor, new value and a new order: the pin follows the monitor, not the old index.
    rerender(<StatusGrid widget={widget} result={{ series: [series("worker", [1]), series("api", [1])] }} />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Healthy");
    expect(container.querySelector('[data-status-index="0"]')).toHaveAttribute("aria-pressed", "true");
  });
  it("closes the preview and releases the pin when its monitor leaves the result", () => {
    const { container, rerender } = render(<StatusGrid widget={widget} result={{ series: [series("api", [1]), series("worker", [0])] }} />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-status-index="1"]')!);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    rerender(<StatusGrid widget={widget} result={{ series: [series("api", [1])] }} />);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  it("renders empty and embedded states without active controls", () => {
    const { rerender } = render(<StatusGrid widget={widget} result={{series:[]}} />);
    expect(screen.getByText(/No data/i)).toBeInTheDocument();
    rerender(<StatusGrid widget={widget} result={{series:[series("api",[1])]}} embedded />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("img",{name:/api: 1 · Healthy/})).toBeInTheDocument();
  });
});
