import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RecordMatrix } from "./records";
import type { Widget } from "../schema";

afterEach(cleanup);

describe("record matrix tooltip facts", () => {
  it("labels each fact with its column's label, not its raw key", () => {
    const widget: Widget = { id: "m", title: "Hosts", type: "plugin", pluginId: "record-matrix", providerId: "p", dataKind: "records", query: "hosts", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, config: { x: "node", y: "cluster", value: "cpu" } };
    render(<RecordMatrix widget={widget} result={{ records: { columns: [{ key: "cluster", label: "Cluster", type: "string" }, { key: "node", label: "Node", type: "string" }, { key: "cpu", label: "CPU", type: "number" }], rows: [["alpha", "n1", 42]] } }} />);
    fireEvent.focus(screen.getAllByRole("button")[0]);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Cluster");
    expect(tooltip).toHaveTextContent("Node");
    expect(tooltip).toHaveTextContent("CPU");
    expect(tooltip).not.toHaveTextContent(/\bcluster\b/);
  });

  it("sets the facts inside the shared detail block, titled by row and column", () => {
    const widget: Widget = { id: "m", title: "Hosts", type: "plugin", pluginId: "record-matrix", providerId: "p", dataKind: "records", query: "hosts", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, config: { x: "node", y: "cluster", value: "cpu" } };
    render(<RecordMatrix widget={widget} result={{ records: { columns: [{ key: "cluster", label: "Cluster", type: "string" }, { key: "node", label: "Node", type: "string" }, { key: "cpu", label: "CPU", type: "number" }], rows: [["alpha", "n1", 42]] } }} />);
    fireEvent.focus(screen.getAllByRole("button")[0]);
    const tooltip = screen.getByRole("tooltip");
    const heading = within(tooltip).getByText("alpha · n1");
    expect(heading.tagName).toBe("STRONG");
    // Every fact sits in the detail block's padded body, not against the panel border.
    const body = heading.closest("div")!.parentElement!;
    for (const fact of tooltip.querySelectorAll("dl")) expect(body.contains(fact)).toBe(true);
  });
});

describe("record matrix scale legend", () => {
  it("prints the value column's scale, not the raw range in 15 digits", () => {
    const widget: Widget = { id: "m", title: "Disks", type: "plugin", pluginId: "record-matrix", providerId: "p", dataKind: "records", query: "disks", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { decimals: 3 }, config: { x: "node", y: "cluster", value: "size" } };
    const { container } = render(<RecordMatrix widget={widget} result={{ records: { columns: [{ key: "cluster", type: "string" }, { key: "node", type: "string" }, { key: "size", type: "number", unit: "bytes" }], rows: [["alpha", "n1", 296303060975000], ["alpha", "n2", 1024]] } }} />);
    const legend = container.textContent ?? "";
    expect(legend).toContain("Scale 0.000 TiB–269.486 TiB");
    expect(legend).not.toContain("296303060975000");
    expect(legend).not.toContain("296,303,060,975,000");
  });
});
