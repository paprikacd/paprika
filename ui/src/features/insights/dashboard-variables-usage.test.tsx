import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardVariablesEditor } from "./dashboard-variables-editor";
import type { Dashboard, Widget } from "./schema";

const requests: Widget = {
  id: "requests", title: "Requests", type: "timeseries", providerId: "metrics", query: 'up{job="{{service}}"}', unit: "",
  layout: { x: 0, y: 0, w: 6, h: 4 },
};
function dashboardWith(variables: Dashboard["variables"], widgets: Widget[] = [requests]): Dashboard {
  return { schemaVersion: 1, id: "service", title: "Service", timeRange: "1h", refreshInterval: 30, widgets, variables } as Dashboard;
}

describe("variable usage on the declarations", () => {
  it("says which widgets read a variable, and that an unused one is not used", () => {
    render(<DashboardVariablesEditor dashboard={dashboardWith([{ name: "service" }, { name: "region" }])} onApply={vi.fn()} />);
    expect(screen.getByText("Used by 1 widget: Requests")).toBeVisible();
    expect(screen.getByText("Not used yet")).toBeVisible();
  });

  it("renames the references on this dashboard when the rename switch is on", () => {
    const onApply = vi.fn();
    render(<DashboardVariablesEditor dashboard={dashboardWith([{ name: "service" }])} onApply={onApply} />);
    fireEvent.change(screen.getByLabelText("Variable 1 name"), { target: { value: "app" } });
    expect(screen.getByRole("switch", { name: /^Rename references too/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Update variables" }));
    expect(onApply.mock.lastCall![0].widgets[0].query).toBe('up{job="{{app}}"}');
  });

  it("keeps the old references when the rename switch is off", () => {
    const onApply = vi.fn();
    render(<DashboardVariablesEditor dashboard={dashboardWith([{ name: "service" }])} onApply={onApply} />);
    fireEvent.change(screen.getByLabelText("Variable 1 name"), { target: { value: "app" } });
    fireEvent.click(screen.getByRole("switch", { name: /^Rename references too/ }));
    fireEvent.click(screen.getByRole("button", { name: "Update variables" }));
    expect(onApply.mock.lastCall![0].widgets[0].query).toBe('up{job="{{service}}"}');
  });

  it("keeps the inputs below a removed card where they were", () => {
    render(<DashboardVariablesEditor dashboard={dashboardWith([{ name: "a" }, { name: "b" }, { name: "c" }], [])} onApply={vi.fn()} />);
    const third = screen.getByLabelText("Variable 3 name");
    fireEvent.click(screen.getByRole("button", { name: "Remove variable 2" }));
    expect(screen.getByLabelText("Variable 2 name")).toBe(third);
    expect(screen.getByLabelText("Variable 2 name")).toHaveValue("c");
  });

  it("asks before removing a variable that a widget reads", () => {
    const onApply = vi.fn();
    render(<DashboardVariablesEditor dashboard={dashboardWith([{ name: "service" }, { name: "region" }])} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove variable 1" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Removing service leaves {{service}} in one widget. Remove it anyway?");
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByLabelText("Variable 1 name")).toHaveValue("service");
    fireEvent.click(screen.getByRole("button", { name: "Remove variable 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove variable" }));
    expect(screen.queryByLabelText("Variable 2 name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Update variables" }));
    expect(onApply.mock.lastCall![0].variables).toEqual([{ name: "region" }]);
  });
});
