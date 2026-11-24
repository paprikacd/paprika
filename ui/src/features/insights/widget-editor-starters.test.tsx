import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WidgetEditor } from "./widget-editor";
import type { Widget } from "./schema";
import { editorProps, widget } from "./widget-editor.test-utils";

function openQuery(subject: Widget) {
  const callbacks = editorProps({ widget: subject });
  render(<WidgetEditor {...callbacks} widget={subject} />);
  fireEvent.click(screen.getByRole("tab", { name: "Query" }));
  return callbacks;
}

describe("starter query chips", () => {
  it("fill the query, unit and default title in one change, and one undo restores them", () => {
    const callbacks = openQuery({ ...widget, title: "Time series", query: "up", unit: "" });
    fireEvent.click(screen.getByRole("button", { name: "Request rate by job" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(callbacks.onApply.mock.lastCall![0]).toMatchObject({
      query: "sum by (job) (rate(http_requests_total[5m]))",
      unit: "req/s",
      title: "Request rate by job",
    });

    fireEvent.click(screen.getByRole("button", { name: "Undo chart change" }));
    expect(screen.getByRole("group", { name: "Starter queries" })).toBeVisible();
  });

  it("keeps a renamed title and a custom unit", () => {
    const callbacks = openQuery({ ...widget, title: "Checkout health", query: "up", unit: "ms" });
    fireEvent.click(screen.getByRole("button", { name: "Request rate by job" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(callbacks.onApply.mock.lastCall![0]).toMatchObject({ title: "Checkout health", unit: "ms" });
  });

  it("hides the chips once the query is a custom one", () => {
    openQuery({ ...widget, query: "node_load1" });
    expect(screen.queryByRole("group", { name: "Starter queries" })).toBeNull();
  });
});
