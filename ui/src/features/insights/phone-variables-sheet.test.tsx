import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneVariables } from "./dashboard-variables";
import type { Dashboard } from "./schema";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

const dashboard: Dashboard = {
  schemaVersion: 1,
  id: "edge",
  title: "Edge Watch",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [],
  variables: [
    { name: "cluster", label: "Cluster", options: ["omega", "alpha"] },
    { name: "location", label: "Location" },
  ],
};

function Harness({ onApply = vi.fn() }: { onApply?: (values: Record<string, string>) => void }) {
  const [values, setValues] = useState<Record<string, string>>({ cluster: "omega", location: "Melbourne" });
  return (
    <PhoneVariables
      dashboard={dashboard}
      values={values}
      onApply={next => { onApply(next); setValues(next); }}
    />
  );
}

function chip() {
  return screen.getByRole("button", { name: /^Dashboard variables:/ });
}

function openSheet() {
  fireEvent.click(chip());
  return screen.getByRole("dialog", { name: "Dashboard variables" });
}

describe("phone variables chip and sheet", () => {
  it("shows the values in use on the chip and opens the sheet from it", () => {
    render(<Harness />);
    expect(chip()).toHaveTextContent("omega · Melbourne");
    expect(chip()).toHaveAccessibleName("Dashboard variables: Cluster omega, Location Melbourne");
    expect(chip()).toHaveAttribute("aria-haspopup", "dialog");
    expect(chip()).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("dialog")).not.toHaveAttribute("open");
    const sheet = openSheet();
    expect(sheet).toHaveAttribute("open");
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    expect(within(sheet).getByRole("combobox", { name: "Cluster" })).toBeInTheDocument();
    expect(within(sheet).getByLabelText("Location")).toHaveValue("Melbourne");
  });

  it("locks body scroll while open and restores it on Done", () => {
    render(<Harness />);
    openSheet();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(document.querySelector("dialog")).not.toHaveAttribute("open");
    expect(document.body.style.overflow).toBe("");
    expect(chip()).toHaveFocus();
  });

  it("focuses the first field when it opens", () => {
    render(<Harness />);
    const sheet = openSheet();
    expect(within(sheet).getByRole("combobox", { name: "Cluster" })).toHaveFocus();
  });

  it("applies a dropdown change at once and keeps the sheet open", () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    const sheet = openSheet();
    fireEvent.click(within(sheet).getByRole("combobox", { name: "Cluster" }));
    fireEvent.click(screen.getByRole("option", { name: "alpha" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ cluster: "alpha", location: "Melbourne" });
    expect(document.querySelector("dialog")).toHaveAttribute("open");
    expect(chip()).toHaveTextContent("alpha · Melbourne");
  });

  it("keeps an unapplied text draft through close and reopen, and says so on the chip", () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    let sheet = openSheet();
    fireEvent.change(within(sheet).getByLabelText("Location"), { target: { value: "Sydney" } });
    expect(chip()).toHaveAccessibleName("Dashboard variables: Cluster omega, Location Melbourne, unapplied changes");
    // jsdom has no native Escape handling: the browser sends a cancelable cancel event for Escape.
    fireEvent(sheet, new Event("cancel", { cancelable: true }));
    expect(document.querySelector("dialog")).not.toHaveAttribute("open");
    expect(chip()).toHaveFocus();
    expect(onApply).not.toHaveBeenCalled();
    sheet = openSheet();
    expect(within(sheet).getByLabelText("Location")).toHaveValue("Sydney");
    fireEvent.click(within(sheet).getByRole("button", { name: "Update view" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ cluster: "omega", location: "Sydney" });
    expect(chip()).toHaveAccessibleName("Dashboard variables: Cluster omega, Location Sydney");
  });

  it("closes on a backdrop click but not on a click inside the sheet", () => {
    render(<Harness />);
    const sheet = openSheet();
    fireEvent.click(within(sheet).getByLabelText("Location"));
    expect(sheet).toHaveAttribute("open");
    fireEvent.click(sheet);
    expect(sheet).not.toHaveAttribute("open");
    expect(chip()).toHaveFocus();
  });

  it("stays out of the accessibility name duplicate: the form is not named a second time", () => {
    render(<Harness />);
    const sheet = openSheet();
    expect(within(sheet).queryByRole("form", { name: "Dashboard variables" })).not.toBeInTheDocument();
  });

  it("renders nothing without variables", () => {
    const { container } = render(<PhoneVariables dashboard={{ ...dashboard, variables: undefined }} values={{}} onApply={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
