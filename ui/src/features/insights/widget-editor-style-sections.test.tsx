import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetEditor } from "./widget-editor";
import { registerWidgetPlugin } from "./widget-registry";
import type { Widget } from "./schema";
import { editorProps, widget } from "./widget-editor.test-utils";

afterEach(cleanup);

const STYLE_TITLES = ["Highlight", "Value", "Color", "Lines", "Axes", "Value details", "Cells", "Legend and grid"];

/** The Style tab's section headings, in the order they appear. */
function styleSectionTitles(subject: Widget) {
  render(<WidgetEditor {...editorProps({ widget: subject })} widget={subject} />);
  fireEvent.click(screen.getByRole("tab", { name: "Style" }));
  return screen
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent ?? "")
    .filter((title) => STYLE_TITLES.includes(title));
}

describe("grouped Style tab", () => {
  it("lists Highlight first, then the time series sections", () => {
    expect(styleSectionTitles({ ...widget, type: "timeseries" })).toEqual(["Highlight", "Value", "Color", "Lines", "Axes", "Legend and grid"]);
  });

  it("shows the single value sections for a stat", () => {
    expect(styleSectionTitles({ ...widget, type: "stat", title: "Single", options: {} })).toEqual(["Highlight", "Value", "Color", "Value details"]);
  });

  it("keeps a plugin's own style controls when it declares no sections", () => {
    const unregister = registerWidgetPlugin({
      id: "sections-plugin-controls",
      label: "Sections plugin",
      description: "Keeps its controls without metadata",
      dataKind: "metrics",
      render: () => null,
      styleControls: ["unit", "decimals", "color", "legend"],
    });
    try {
      const pluginWidget: Widget = { ...widget, type: "plugin", pluginId: "sections-plugin-controls", dataKind: "metrics", title: "Plugin", options: {} } as Widget;
      render(<WidgetEditor {...editorProps({ widget: pluginWidget })} widget={pluginWidget} />);
      fireEvent.click(screen.getByRole("tab", { name: "Style" }));
      expect(screen.getByLabelText("Unit")).toBeVisible();
      expect(screen.getByLabelText("Decimal places")).toBeVisible();
      const legend = screen.getByRole("heading", { level: 3, name: "Legend and grid" }).closest("section");
      expect(within(legend!).getByRole("switch", { name: "Show legend" })).toBeVisible();
    } finally {
      unregister();
    }
  });
});
