import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SearchCombobox } from "./search-combobox";
import { GammaTabs } from "./tabs";
import { GammaSwitch } from "./switch";
import { GammaButton } from "./button";
import { Play, X } from "lucide-react";

describe("Gamma controls adapted for Insights", () => {
  it("distinguishes text with an icon from an explicitly labeled icon action", () => {
    render(
      <>
        <GammaButton><Play aria-hidden="true" /> Run query</GammaButton>
        <GammaButton iconOnly aria-label="Close query"><X aria-hidden="true" /></GammaButton>
      </>,
    );
    // SVG is the only element child in both buttons; raw text must still keep text-button spacing.
    expect(screen.getByRole("button", { name: "Run query" })).not.toHaveAttribute("data-icon-only");
    expect(screen.getByRole("button", { name: "Close query" })).toHaveAttribute("data-icon-only", "true");
  });
  it("keeps input focus while navigating options and commits the active option", () => {
    const onChange = vi.fn();
    render(
      <SearchCombobox
        label="Metric"
        options={[
          { value: "first", label: "First" },
          { value: "disabled", label: "Disabled", disabled: true },
          { value: "last", label: "Last" },
        ]}
        onValueChange={onChange}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Metric" });
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const active = screen.getByRole("option", { name: "Last" });
    expect(input).toHaveAttribute("aria-activedescendant", active.id);
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(
      "last",
      expect.objectContaining({ value: "last" }),
    );
    expect(input).toHaveAttribute("aria-expanded", "false");
  });
  it("dismisses on Escape without clearing the selected provider", () => {
    const onChange = vi.fn();
    render(
      <SearchCombobox
        label="Provider"
        value="prod"
        options={[{ value: "prod", label: "Production" }]}
        onValueChange={onChange}
      />,
    );
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("Production");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });
  it("limits DOM results while searching the complete supplied list", () => {
    render(
      <SearchCombobox
        label="Metric"
        options={Array.from({ length: 2000 }, (_, index) => ({
          value: `metric_${index}`,
          label: `metric_${index}`,
        }))}
      />,
    );
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")).toHaveLength(100);
    fireEvent.change(input, { target: { value: "metric_1999" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(
      screen.getByRole("option", { name: "metric_1999" }),
    ).toBeInTheDocument();
  });
  it("links unique tab panels and follows arrow and Home keys", () => {
    function Tabs() {
      const [value, setValue] = useState("query");
      return (
        <GammaTabs
          label="Settings"
          value={value}
          onChange={setValue}
          tabs={[
            { id: "query", title: "Query", content: "Query settings" },
            { id: "style", title: "Style", content: "Style settings" },
          ]}
        />
      );
    }
    render(<Tabs />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Query" }), {
      key: "ArrowRight",
    });
    const style = screen.getByRole("tab", { name: "Style" });
    expect(style).toHaveFocus();
    expect(style).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Style settings");
    fireEvent.keyDown(style, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Query" })).toHaveFocus();
  });
  it("uses a native labeled checkbox switch for keyboard and form semantics", () => {
    const onChange = vi.fn();
    render(<GammaSwitch label="Show legend" checked onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Show legend" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
