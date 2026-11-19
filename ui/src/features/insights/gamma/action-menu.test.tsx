import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GammaActionMenu, type GammaActionMenuItem } from "./action-menu";

const items = (onSelect = vi.fn()): GammaActionMenuItem[] => [
  { id: "edit", group: "Dashboard", label: "Edit dashboard", onSelect },
  { id: "code", group: "Dashboard", label: "Dashboard as code", onSelect },
  { id: "manage", group: "Workspace", label: "Manage dashboards", onSelect },
  { id: "loose", label: "Ungrouped", onSelect },
  { id: "refresh", group: "Auto refresh", label: "Every 15 s", selected: false, onSelect },
];

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Actions" }));
  return screen.getByRole("menu", { name: "Actions" });
}

describe("GammaActionMenu groups", () => {
  it("renders consecutive items sharing a group under one named group with a visible heading", () => {
    render(<GammaActionMenu label="Actions" items={items()} />);
    const menu = openMenu();
    const dashboard = within(menu).getByRole("group", { name: "Dashboard" });
    expect(within(dashboard).getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Edit dashboard", "Dashboard as code"]);
    expect(within(dashboard).getByText("Dashboard")).toBeVisible();
    // The heading is for sighted users; the group takes its name from it, so assistive tech does not read it as stray text.
    expect(within(dashboard).getByText("Dashboard")).toHaveAttribute("aria-hidden", "true");
    expect(within(menu).getByRole("group", { name: "Workspace" })).toContainElement(screen.getByRole("menuitem", { name: "Manage dashboards" }));
    expect(within(menu).getByRole("menuitemradio", { name: "Every 15 s" }).closest("[role=group]")).toHaveAccessibleName("Auto refresh");
    expect(screen.getByRole("menuitem", { name: "Ungrouped" }).closest("[role=group]")).toBeNull();
  });

  it("keeps items in their declared order across group boundaries", () => {
    render(<GammaActionMenu label="Actions" items={items()} />);
    const names = [...openMenu().querySelectorAll("[role^='menuitem']")].map(item => item.getAttribute("data-label"));
    expect(names).toEqual(["Edit dashboard", "Dashboard as code", "Manage dashboards", "Ungrouped", "Every 15 s"]);
  });

  it("moves through items across groups with arrow keys and Home and End", () => {
    render(<GammaActionMenu label="Actions" items={items()} />);
    const menu = openMenu();
    expect(screen.getByRole("menuitem", { name: "Edit dashboard" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Manage dashboards" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(screen.getByRole("menuitemradio", { name: "Every 15 s" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(screen.getByRole("menuitem", { name: "Edit dashboard" })).toHaveFocus();
  });

  it("types ahead into an item that sits in a later group", () => {
    render(<GammaActionMenu label="Actions" items={items()} />);
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: "m" });
    expect(screen.getByRole("menuitem", { name: "Manage dashboards" })).toHaveFocus();
  });

  it("selects an item in a group and closes the menu", () => {
    const onSelect = vi.fn();
    render(<GammaActionMenu label="Actions" items={items(onSelect)} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage dashboards" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("GammaActionMenu opener", () => {
  it("names the trigger as the opener of builder panels only when openerName is given", () => {
    const { rerender } = render(<GammaActionMenu label="Actions" items={items()} openerName="dashboard-actions" />);
    expect(screen.getByRole("button", { name: "Actions" })).toHaveAttribute("data-panel-opener", "dashboard-actions");
    rerender(<GammaActionMenu label="Actions" items={items()} />);
    expect(screen.getByRole("button", { name: "Actions" })).not.toHaveAttribute("data-panel-opener");
  });
});
