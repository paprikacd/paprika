import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, Widget } from "../schema";
import { StatusGrid, latestStatusPoint, statusGridConfigSchema } from "./status-grid";

afterEach(cleanup);
const widget: Widget = { id:"status", title:"Current monitors", type:"plugin", pluginId:"status-grid", providerId:"metrics", query:"up", unit:"", layout:{ x:0,y:0,w:8,h:4 }, options:{ decimals:2 } };
const series = (name: string, values: (number | null)[]): NonNullable<QueryResult["series"]>[number] => ({ name, labels:{ service:name }, points:values.map((value,index) => ({ timestamp:Date.UTC(2026,0,1,0,index),value })) });

describe("monitor status grid", () => {
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
    const status = screen.getByRole("button",{name:/db: 4.126 · Warning/});
    fireEvent.click(status);
    expect(select).toHaveBeenLastCalledWith({ labels:{service:"db"}, value:4.126, series:"db" });
    expect(screen.getByRole("tooltip").querySelector('[data-metric-value="4.126"]')).toHaveTextContent("4.13");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Warning");
    fireEvent.click(screen.getByRole("button",{name:/empty: No data/}));
    expect(select).toHaveBeenLastCalledWith({ labels:{service:"empty"}, value:null, series:"empty" });
  });
  it("bounds series and reports omissions and partial provider responses", () => {
    expect(() => statusGridConfigSchema.parse({maxSeries:2049})).toThrow();
    render(<StatusGrid widget={{...widget,config:{maxSeries:2}}} result={{series:[series("one",[1]),series("two",[0]),series("three",[1])],truncated:true}} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText("Showing 2 of 3")).toBeInTheDocument();
    expect(screen.getByText("Partial source response")).toBeInTheDocument();
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
    rerender(<StatusGrid widget={widget} result={{series:[series("api",[null])]}} />);
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
