import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GammaSelect } from "./select";
import { SearchCombobox } from "./search-combobox";
import { GammaActionMenu } from "./action-menu";

describe("Gamma overlays inside native modal dialogs", () => {
  it("focuses a searchable select only after mounting inside its modal", () => {
    render(
      <dialog open aria-label="Data">
        <GammaSelect
          aria-label="Series"
          searchable
          value="one"
          onValueChange={vi.fn()}
          options={[{ value: "one", label: "One" }]}
        />
      </dialog>,
    );
    const trigger = screen.getByRole("combobox", { name: "Series" });
    fireEvent.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search series" });
    expect(screen.getByRole("dialog")).toContainElement(search);
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(trigger).toHaveFocus();
  });

  it("keeps select, search and action menus in the modal's interactive top layer", () => {
    const select = vi.fn();
    const search = vi.fn();
    const action = vi.fn();
    render(
      <dialog open aria-label="Chart data">
        <GammaSelect
          aria-label="Data series"
          value="one"
          onValueChange={select}
          options={[
            { value: "one", label: "One" },
            { value: "two", label: "Two" },
          ]}
        />
        <SearchCombobox
          label="Metric"
          onValueChange={search}
          options={[{ value: "up", label: "Availability" }]}
        />
        <GammaActionMenu
          label="Actions"
          items={[{ id: "inspect", label: "Inspect", onSelect: action }]}
        />
      </dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Chart data" });
    const series = screen.getByRole("combobox", { name: "Data series" });
    fireEvent.click(series);
    expect(dialog).toContainElement(screen.getByRole("listbox"));
    expect(
      screen.getByRole("listbox").closest("[data-gamma-portal]")?.parentElement,
    ).toBe(dialog);
    fireEvent.click(screen.getByRole("option", { name: "Two" }));
    expect(select).toHaveBeenCalledWith("two");
    expect(series).toHaveFocus();

    const metric = screen.getByRole("combobox", { name: "Metric" });
    metric.focus();
    fireEvent.keyDown(metric, { key: "ArrowDown" });
    expect(dialog).toContainElement(screen.getByRole("listbox"));
    fireEvent.keyDown(metric, { key: "Enter" });
    expect(search).toHaveBeenCalledWith(
      "up",
      expect.objectContaining({ value: "up" }),
    );
    expect(metric).toHaveFocus();

    const actions = screen.getByRole("button", { name: "Actions" });
    fireEvent.click(actions);
    expect(dialog).toContainElement(screen.getByRole("menu"));
    expect(screen.getByRole("menuitem", { name: "Inspect" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Inspect" }), {
      key: "Escape",
    });
    expect(actions).toHaveFocus();
    expect(action).not.toHaveBeenCalled();
    expect(dialog).toHaveAttribute("open");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
