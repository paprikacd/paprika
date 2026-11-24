import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GammaMultiSelect } from "./multi-select";

afterEach(() => cleanup());

const options = [
  { value: "omega", label: "omega" },
  { value: "delta", label: "delta" },
  { value: "eu", label: "eu" },
];

function Harness({ initial = [] as string[], allowAll = false, onCommit }: {
  initial?: string[]; allowAll?: boolean; onCommit: (values: string[]) => void;
}) {
  const [values, setValues] = useState(initial);
  return <>
    <button type="button">Outside</button>
    <GammaMultiSelect
      aria-label="Cluster"
      values={values}
      options={options}
      allowAll={allowAll}
      onValuesChange={(next) => { onCommit(next); setValues(next); }}
    />
  </>;
}

function openPanel() {
  fireEvent.click(screen.getByRole("combobox", { name: "Cluster" }));
  return screen.getByRole("listbox");
}

describe("GammaMultiSelect", () => {
  it("commits the picks once, in option order, when the panel closes", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const list = openPanel();
    expect(list).toHaveAttribute("aria-multiselectable", "true");
    fireEvent.click(within(list).getByRole("option", { name: "eu" }));
    fireEvent.click(within(list).getByRole("option", { name: "omega" }));
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Cluster" }), { key: "Escape" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(["omega", "eu"]);
  });

  it("does not commit when nothing changed", () => {
    const onCommit = vi.fn();
    render(<Harness initial={["delta"]} onCommit={onCommit} />);
    openPanel();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Cluster" }), { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("gives All when Include All is on and the last value is unchecked", () => {
    const onCommit = vi.fn();
    render(<Harness initial={["delta"]} allowAll onCommit={onCommit} />);
    const list = openPanel();
    fireEvent.click(within(list).getByRole("option", { name: "delta" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Cluster" }), { key: "Escape" });
    expect(onCommit).toHaveBeenCalledWith([]);
  });

  it("keeps the last value checked when Include All is off", () => {
    const onCommit = vi.fn();
    render(<Harness initial={["delta"]} onCommit={onCommit} />);
    const list = openPanel();
    fireEvent.click(within(list).getByRole("option", { name: "delta" }));
    expect(within(list).getByRole("option", { name: "delta" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Cluster" }), { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("clears the list when All is chosen", () => {
    const onCommit = vi.fn();
    render(<Harness initial={["omega", "delta"]} allowAll onCommit={onCommit} />);
    const list = openPanel();
    fireEvent.click(within(list).getByRole("option", { name: "All" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Cluster" }), { key: "Escape" });
    expect(onCommit).toHaveBeenCalledWith([]);
  });

  it("shows a summary of the committed values on the trigger", () => {
    render(<Harness initial={["omega", "delta"]} onCommit={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Cluster" })).toHaveTextContent("omega, delta");
  });

  it("summarises a long pick as a count and keeps the full text as a title", () => {
    const long = [
      { value: "omega-east-1", label: "omega-east-1" },
      { value: "delta-west-2", label: "delta-west-2" },
      { value: "eu-central-3", label: "eu-central-3" },
    ];
    render(<GammaMultiSelect aria-label="Cluster" values={long.map((item) => item.value)} options={long} onValuesChange={vi.fn()} />);
    const trigger = screen.getByRole("combobox", { name: "Cluster" });
    expect(trigger).toHaveTextContent("3 selected");
    expect(within(trigger).getByText("3 selected")).toHaveAttribute("title", "omega-east-1, delta-west-2, eu-central-3");
  });

  it("toggles rows from the keyboard, keeps the panel open, and commits on Tab", () => {
    const onCommit = vi.fn();
    render(<Harness allowAll onCommit={onCommit} />);
    const trigger = screen.getByRole("combobox", { name: "Cluster" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const list = screen.getByRole("listbox");
    // All is first and active; move to omega and toggle it with Space, then delta with Enter.
    expect(trigger).toHaveAttribute("aria-activedescendant", within(list).getByRole("option", { name: "All" }).id);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: " " });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(within(list).getByRole("option", { name: "omega" })).toHaveAttribute("aria-selected", "true");
    expect(within(list).getByRole("option", { name: "All" })).toHaveAttribute("aria-selected", "false");
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(["omega", "delta"]);
  });

  it("commits once on an outside click", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const list = openPanel();
    fireEvent.click(within(list).getByRole("option", { name: "delta" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(["delta"]);
  });

  it("keeps one row for a value whose list finishes loading while the panel is open", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<GammaMultiSelect aria-label="Cluster" values={["delta"]} options={[]} onValuesChange={onCommit} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Cluster" }));
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
    rerender(<GammaMultiSelect aria-label="Cluster" values={["delta"]} options={options} onValuesChange={onCommit} />);
    const list = screen.getByRole("listbox");
    expect(within(list).getAllByRole("option").map((row) => row.textContent)).toEqual(["omega", "delta", "eu"]);
    fireEvent.click(within(list).getByRole("option", { name: "eu" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Cluster" }), { key: "Escape" });
    expect(onCommit).toHaveBeenCalledWith(["delta", "eu"]);
  });
});
