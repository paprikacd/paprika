import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VariableBar } from "./dashboard-variables";
import type { Dashboard } from "./schema";

const dashboard: Dashboard = {
  schemaVersion: 1,
  id: "service",
  title: "Service detail",
  timeRange: "1h",
  refreshInterval: 30,
  widgets: [],
  variables: [
    { name: "env", label: "Environment", defaultValue: "prod", options: ["prod", "staging"] },
  ],
};
const textDashboard: Dashboard = {
  ...dashboard,
  variables: [{ name: "service", label: "Service", defaultValue: "api" }],
};

describe("filtered view on the variable bar", () => {
  it("shows Filtered and Reset filters only when the view differs from the defaults", () => {
    const onApply = vi.fn();
    const { rerender } = render(<VariableBar dashboard={dashboard} values={{ env: "prod" }} onApply={onApply} />);
    expect(screen.queryByText("Filtered")).toBeNull();
    rerender(<VariableBar dashboard={dashboard} values={{ env: "staging" }} onApply={onApply} />);
    expect(screen.getByText("Filtered")).toHaveAttribute("role", "status");
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(onApply).toHaveBeenLastCalledWith({ env: "prod" });
  });

  it("keeps the Filtered status for a dropdown-only dashboard, which has no Update view", () => {
    render(<VariableBar dashboard={dashboard} values={{ env: "staging" }} onApply={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Update view" })).toBeNull();
    expect(screen.getByText("Filtered")).toBeVisible();
  });
});

describe("Update view emphasis", () => {
  it("is quiet until the text draft changes, then primary", () => {
    render(<VariableBar dashboard={textDashboard} values={{}} onApply={vi.fn()} />);
    const update = screen.getByRole("button", { name: "Update view" });
    expect(update).toBeDisabled();
    expect(update).toHaveAttribute("data-variant", "quiet");
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "web" } });
    expect(screen.getByRole("button", { name: "Update view" })).toHaveAttribute("data-variant", "primary");
  });
});

describe("Filter action in edit mode", () => {
  it("is absent without a declaration callback", () => {
    render(<VariableBar dashboard={dashboard} values={{}} onApply={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Filter" })).toBeNull();
  });

  it("opens the declaration form inline when a callback is given, even with no variables", async () => {
    const onDeclare = vi.fn();
    render(<VariableBar dashboard={{ ...dashboard, variables: [] }} values={{}} onApply={vi.fn()} onDeclareVariable={onDeclare} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.change(await screen.findByLabelText("New variable name"), { target: { value: "region" } });
    fireEvent.click(screen.getByRole("button", { name: "Create variable" }));
    expect(onDeclare).toHaveBeenCalledWith({ name: "region" });
  });
});
