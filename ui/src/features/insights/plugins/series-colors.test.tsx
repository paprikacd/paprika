import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { stackedConfigSchema, directionalConfigSchema } from "./rich-metrics-data";
import { DirectionalTraffic, StackedTimeseries } from "./rich-metrics";
import { SeriesColorEditor } from "./series-color-editor";
import type { QueryResult, Widget } from "../schema";

const rules = [{ label: "direction", value: "inbound", color: "#00cee2" }, { label: "direction", value: "outbound", color: "#a879ef" }];
const widget: Widget = { id: "colors", title: "Traffic", type: "plugin", pluginId: "directional-traffic", dataKind: "metrics", providerId: "metrics", query: "rate", unit: "Mb/s", layout: { x: 0, y: 0, w: 6, h: 4 }, config: { seriesColors: rules } };
const result: QueryResult = { series: [
  { name: "Inbound", labels: { direction: "inbound" }, points: [{ timestamp: 1000, value: 3 }, { timestamp: 2000, value: 4 }] },
  { name: "Outbound", labels: { direction: "outbound" }, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 2 }] },
] };

describe("metric series color rules", () => {
  it.each([stackedConfigSchema, directionalConfigSchema])("validates bounded exact rules", schema => {
    expect(schema.parse({ seriesColors: rules }).seriesColors).toEqual(rules);
    expect(schema.safeParse({ seriesColors: [{ ...rules[0], color: "red" }] }).success).toBe(false);
    expect(schema.safeParse({ seriesColors: [rules[0], rules[0]] }).success).toBe(false);
    expect(schema.safeParse({ seriesColors: [{ ...rules[0], label: "bad label" }] }).success).toBe(false);
    expect(schema.safeParse({ seriesColors: Array(25).fill(rules[0]) }).success).toBe(false);
  });
  it.each([DirectionalTraffic, StackedTimeseries])("retains semantic colors when series reorder", Chart => {
    const { container, rerender } = render(<Chart widget={widget} result={result} />);
    const stroke = (name: string) => container.querySelector(`[data-series="${name}"] path[stroke]`)?.getAttribute("stroke");
    expect(stroke("Inbound")).toBe("#00cee2");
    expect(stroke("Outbound")).toBe("#a879ef");
    rerender(<Chart widget={widget} result={{ series: result.series!.toReversed() }} />);
    expect(stroke("Inbound")).toBe("#00cee2");
    expect(stroke("Outbound")).toBe("#a879ef");
  });
  it("edits and removes a rule in the saved configuration", () => {
    function Form() {
      const [config, setConfig] = useState<Record<string, unknown>>({});
      return <><SeriesColorEditor config={config} onChange={setConfig} /><output aria-label="Saved configuration">{JSON.stringify(config)}</output></>;
    }
    render(<Form />);
    fireEvent.click(screen.getByRole("button", { name: "Add series color" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Color rule 1 label" }), { target: { value: "direction" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Color rule 1 value" }), { target: { value: "inbound" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Color rule 1 color" }), { target: { value: "#00cee2" } });
    const saved = JSON.parse(screen.getByLabelText("Saved configuration").textContent!);
    expect(directionalConfigSchema.parse(saved).seriesColors).toEqual([rules[0]]);
    fireEvent.click(within(screen.getByRole("group", { name: "Color rule 1" })).getByRole("button", { name: "Remove color rule 1" }));
    expect(screen.getByLabelText("Saved configuration")).toHaveTextContent("{}");
  });
});
