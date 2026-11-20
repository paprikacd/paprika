import { describe, expect, it, vi } from "vitest";
import { dashboardActionItems, type DashboardActionHandlers } from "./dashboard-actions";

function handlers(): DashboardActionHandlers {
  return { edit: vi.fn(), togglePanel: vi.fn(), inspectQueries: vi.fn(), refresh: vi.fn(), shortcuts: vi.fn() };
}

describe("dashboardActionItems", () => {
  it("keeps the Manage and Build with AI pair outside the phone shell, with the shortcut list", () => {
    const h = handlers();
    const items = dashboardActionItems({ phoneShell: false, refreshInterval: 0, customRange: false }, h);
    expect(items.map(item => item.label)).toEqual(["Manage dashboards", "Build with AI", "Keyboard shortcuts"]);
    expect(items.every(item => item.group === undefined)).toBe(true);
    items.find(item => item.label === "Keyboard shortcuts")?.onSelect();
    expect(h.shortcuts).toHaveBeenCalledOnce();
  });

  it("lists every phone action in groups, Edit first", () => {
    const items = dashboardActionItems({ phoneShell: true, refreshInterval: 0, customRange: false }, handlers());
    expect(items.map(item => [item.label, item.group])).toEqual([
      ["Edit dashboard", "Dashboard"],
      ["Dashboard as code", "Dashboard"],
      ["Query inspector", "Dashboard"],
      ["Manage dashboards", "Workspace"],
      ["Build with AI", "Workspace"],
      ["Auto refresh off", "Auto refresh"],
      ["Every 15 s", "Auto refresh"],
      ["Every 30 s", "Auto refresh"],
      ["Every 1 min", "Auto refresh"],
    ]);
  });

  it("marks the current refresh interval and leaves the choices enabled", () => {
    const items = dashboardActionItems({ phoneShell: true, refreshInterval: 30, customRange: false }, handlers());
    const radios = items.filter(item => item.group === "Auto refresh");
    expect(radios.map(item => item.selected)).toEqual([false, false, true, false]);
    expect(radios.some(item => item.disabled)).toBe(false);
  });

  it("disables the refresh choices under a fixed custom range and explains why", () => {
    const items = dashboardActionItems({ phoneShell: true, refreshInterval: 30, customRange: true }, handlers());
    const radios = items.filter(item => item.group === "Auto refresh");
    expect(radios.every(item => item.disabled)).toBe(true);
    expect(radios.every(item => item.description === "Fixed custom range")).toBe(true);
    expect(radios.some(item => item.selected)).toBe(false);
  });

  it("routes each item to its handler", () => {
    const h = handlers();
    const items = dashboardActionItems({ phoneShell: true, refreshInterval: 0, customRange: false }, h);
    const byId = Object.fromEntries(items.map(item => [item.id, item]));
    byId.edit.onSelect();
    byId.code.onSelect();
    byId.queries.onSelect();
    byId.manage.onSelect();
    byId.ai.onSelect();
    byId["refresh-15"].onSelect();
    expect(h.edit).toHaveBeenCalledTimes(1);
    expect(h.togglePanel).toHaveBeenCalledWith("source");
    expect(h.togglePanel).toHaveBeenCalledWith("manage");
    expect(h.togglePanel).toHaveBeenCalledWith("ai");
    expect(h.inspectQueries).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledWith(15);
  });
});
