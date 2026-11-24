import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WidgetEditor } from "./widget-editor";
import type { Widget } from "./schema";
import { editorProps, widget } from "./widget-editor.test-utils";

function openStyle(subject: Widget) {
  const callbacks = editorProps({ widget: subject });
  render(<WidgetEditor {...callbacks} widget={subject} />);
  fireEvent.click(screen.getByRole("tab", { name: "Style" }));
  return callbacks;
}

describe("threshold preset choices in the style editor", () => {
  it("Error ratio writes three status bands in one change", () => {
    const callbacks = openStyle({ ...widget, unit: "%", options: {} });
    fireEvent.click(screen.getByRole("button", { name: "Error ratio" }));
    expect(callbacks.onApply).toHaveBeenCalledTimes(1);
    const thresholds = callbacks.onApply.mock.lastCall![0].options?.thresholds;
    expect(thresholds).toEqual([
      { value: 0, status: "ok", label: "Healthy" },
      { value: 1, status: "warning", label: "Elevated" },
      { value: 5, status: "critical", label: "High" },
    ]);
  });

  it("disables latency when the unit has no time scale", () => {
    openStyle({ ...widget, unit: "", options: {} });
    expect(screen.getByRole("button", { name: "Latency" })).toBeDisabled();
  });

  it("marks the preset that matches the current bands as pressed", () => {
    openStyle({ ...widget, unit: "%", options: { thresholds: [
      { value: 0, status: "ok", label: "Healthy" },
      { value: 1, status: "warning", label: "Elevated" },
      { value: 5, status: "critical", label: "High" },
    ] } });
    expect(screen.getByRole("button", { name: "Error ratio" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Saturation" })).toHaveAttribute("aria-pressed", "false");
  });
});
