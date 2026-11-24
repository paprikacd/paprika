import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WidgetEditor } from "./widget-editor";
import type { QueryResult } from "./schema";
import { editorProps, widget } from "./widget-editor.test-utils";

const oneSeries: QueryResult = { series: [{ name: "up", labels: { job: "api" }, points: [{ timestamp: 1000, value: 1 }] }] };

describe("visualization suggestions and search", () => {
  it("offers a suggested visualization for the loaded result and switches to it in one change", () => {
    const callbacks = editorProps({ widget: { ...widget, type: "timeseries" }, result: oneSeries });
    render(<WidgetEditor {...callbacks} widget={{ ...widget, type: "timeseries" }} result={oneSeries} />);
    const group = screen.getByRole("group", { name: "Suggested for this data" });
    fireEvent.click(within(group).getByRole("button", { name: "Single value" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(callbacks.onApply.mock.lastCall![0]).toMatchObject({ type: "stat" });
  });

  it("shows no suggestions without a loaded result", () => {
    render(<WidgetEditor {...editorProps()} />);
    expect(screen.queryByRole("group", { name: "Suggested for this data" })).toBeNull();
  });

  it("finds the heatmap visualization by searching for heatmap", () => {
    render(<WidgetEditor {...editorProps({ widget: { ...widget, type: "timeseries" } })} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Visualization" }));
    const search = screen.getByRole("combobox", { name: "Search visualization" });
    fireEvent.change(search, { target: { value: "heatmap" } });
    expect(screen.getByRole("option", { name: /^Status grid/ })).toBeVisible();
  });
});
