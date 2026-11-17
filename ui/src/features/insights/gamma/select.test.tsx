import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GammaSelect } from "./select";
import { GammaButton } from "./button";
import { GammaInput, GammaTextarea } from "./input";
import { GammaActionMenu } from "./action-menu";

const options = [
  { value: "line", label: "Line", description: "Trends over time" },
  { value: "disabled", label: "Unavailable", disabled: true },
  { value: "bar", label: "Bar" },
  { value: "table", label: "Table" },
];
afterEach(() => vi.restoreAllMocks());

describe("Gamma select and action adapters", () => {
  it("opens in a portal, retains focus, skips disabled options, and commits to the form", () => {
    function Form() {
      const [value, setValue] = useState("line");
      return (
        <form aria-label="Widget">
          <GammaSelect
            aria-label="Visualization"
            name="visualization"
            value={value}
            onValueChange={setValue}
            options={options}
          />
        </form>
      );
    }
    const { container } = render(<Form />);
    const trigger = screen.getByRole("combobox", { name: "Visualization" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(container).not.toContainElement(screen.getByRole("listbox"));
    expect(screen.getByRole("option", { name: /Line/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Bar" }).id,
    );
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger).toHaveTextContent("Bar");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(
      new FormData(screen.getByRole("form") as HTMLFormElement).get(
        "visualization",
      ),
    ).toBe("bar");
  });
  it("uses typeahead and Home/End without changing a selection dismissed by Escape", () => {
    const changed = vi.fn();
    render(
      <GammaSelect
        aria-label="Visualization"
        value="line"
        options={options}
        onValueChange={changed}
      />,
    );
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "t" });
    expect(trigger).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Table" }).id,
    );
    fireEvent.keyDown(trigger, { key: "Home" });
    expect(trigger).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: /Line/ }).id,
    );
    fireEvent.keyDown(trigger, { key: "End" });
    expect(trigger).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Table" }).id,
    );
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(changed).not.toHaveBeenCalled();
    expect(trigger).toHaveTextContent("Line");
    expect(trigger).toHaveFocus();
  });
  it("filters the whole option set while bounding searchable DOM results", () => {
    const changed = vi.fn();
    render(
      <GammaSelect
        aria-label="Metric"
        searchable
        value=""
        onValueChange={changed}
        options={Array.from({ length: 2000 }, (_, index) => ({
          value: `metric_${index}`,
          label: `Metric ${index}`,
        }))}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Metric" }));
    const search = screen.getByRole("combobox", { name: "Search metric" });
    expect(search).toHaveFocus();
    expect(screen.getAllByRole("option")).toHaveLength(100);
    fireEvent.change(search, { target: { value: "Metric 1999" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(changed).toHaveBeenCalledWith("metric_1999");
    expect(screen.getByRole("combobox", { name: "Metric" })).toHaveFocus();
  });
  it("dismisses on outside pointer/focus and cannot choose disabled options", () => {
    const changed = vi.fn();
    const { rerender } = render(
      <>
        <GammaSelect
          aria-label="Visualization"
          value="line"
          options={options}
          onValueChange={changed}
        />
        <button>Elsewhere</button>
      </>,
    );
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Unavailable" }));
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.focusIn(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    rerender(
      <GammaSelect
        aria-label="Visualization"
        disabled
        value="line"
        options={options}
        onValueChange={changed}
      />,
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeDisabled();
  });
  it("flips and clamps a dropdown near the viewport edge", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 280,
      y: 260,
      left: 280,
      top: 260,
      right: 320,
      bottom: 298,
      width: 40,
      height: 38,
      toJSON: () => ({}),
    });
    vi.stubGlobal("innerWidth", 320);
    vi.stubGlobal("innerHeight", 300);
    const { unmount } = render(
      <GammaSelect
        aria-label="Visualization"
        value="line"
        options={options}
        onValueChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("combobox"));
    const panel = screen.getByRole("listbox").parentElement!;
    expect(panel).toHaveAttribute("data-side", "above");
    expect(
      parseFloat(panel.style.left) + parseFloat(panel.style.width),
    ).toBeLessThanOrEqual(312);
    expect(parseFloat(panel.style.top)).toBeGreaterThanOrEqual(8);
    unmount();
    expect(
      document.querySelector("[data-gamma-portal]"),
    ).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
  it("does not commit a portaled choice after its enclosing fieldset becomes disabled", () => {
    const changed = vi.fn();
    const field = (disabled: boolean) => (
      <fieldset disabled={disabled}>
        <GammaSelect
          aria-label="Provider"
          value="line"
          options={options}
          onValueChange={changed}
        />
      </fieldset>
    );
    const { rerender } = render(field(false));
    fireEvent.click(screen.getByRole("combobox", { name: "Provider" }));
    rerender(field(true));
    fireEvent.click(screen.getByRole("option", { name: "Bar" }));
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
  it("moves menu focus through enabled actions and restores its trigger on Escape", () => {
    const onSelect = vi.fn();
    render(
      <GammaActionMenu
        label="Related dashboards"
        items={[
          { id: "first", label: "Overview", onSelect },
          { id: "disabled", label: "Hidden", disabled: true, onSelect },
          { id: "last", label: "Service details", onSelect },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Related dashboards" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Overview" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(
      screen.getByRole("menuitem", { name: "Service details" }),
    ).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Service details" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });
  it("preserves native refs/validation and blocks repeat busy actions", () => {
    const button = createRef<HTMLButtonElement>();
    const input = createRef<HTMLInputElement>();
    const textarea = createRef<HTMLTextAreaElement>();
    const click = vi.fn();
    render(
      <>
        <GammaButton ref={button} loading onClick={click}>
          Save
        </GammaButton>
        <GammaInput ref={input} aria-label="Name" required />
        <GammaTextarea ref={textarea} aria-label="Notes" />
        <GammaInput aria-label="Upload" type="file" />
        <GammaInput name="token" type="hidden" value="value" />
      </>,
    );
    expect(button.current).toHaveAttribute("type", "button");
    expect(button.current).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button.current!);
    expect(click).not.toHaveBeenCalled();
    expect(input.current).toBeRequired();
    expect(textarea.current).toBe(
      screen.getByRole("textbox", { name: "Notes" }),
    );
    expect(screen.getByLabelText("Upload")).toHaveAttribute("class", "");
  });
});
