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
});
