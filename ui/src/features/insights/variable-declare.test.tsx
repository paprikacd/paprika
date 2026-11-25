import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import VariableQuickCreate from "./variable-quick-create";
import { SavedQueryLibraryProvider } from "./saved-query-context";
import { SelectionEditor } from "./selection-editor";
import { SavedQueryBindingEditor } from "./saved-query-controls";
import { DrilldownEditor } from "./drilldown-editor";
import type { Dashboard, SavedQuery, Widget } from "./schema";

const layout = { x: 0, y: 0, w: 6, h: 4 };
const table: Widget = { id: "table", title: "Table", type: "table", providerId: "metrics", query: "up", unit: "", layout };

describe("VariableQuickCreate", () => {
  it("creates a variable with its label, default and choices", () => {
    const onCreate = vi.fn();
    render(<VariableQuickCreate existing={["region"]} onCreate={onCreate} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "env" } });
    fireEvent.change(screen.getByLabelText("New variable choices"), { target: { value: "prod, staging" } });
    fireEvent.click(screen.getByRole("button", { name: "Create variable" }));
    expect(onCreate).toHaveBeenCalledWith({ name: "env", options: ["prod", "staging"] });
  });

  it("refuses a name that already exists", () => {
    const onCreate = vi.fn();
    render(<VariableQuickCreate existing={["region"]} onCreate={onCreate} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "region" } });
    fireEvent.click(screen.getByRole("button", { name: "Create variable" }));
    expect(screen.getByRole("alert")).toHaveTextContent("A variable named region already exists.");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("refuses a 21st variable", () => {
    const existing = Array.from({ length: 20 }, (_, index) => `v${index}`);
    render(<VariableQuickCreate existing={existing} onCreate={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "extra" } });
    fireEvent.click(screen.getByRole("button", { name: "Create variable" }));
    expect(screen.getByRole("alert")).toHaveTextContent("A dashboard supports up to 20 variables.");
  });

  it("shows the reason when the declaration throws", () => {
    render(<VariableQuickCreate existing={[]} onCreate={() => { throw new Error("The dashboard is saving."); }} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "env" } });
    fireEvent.click(screen.getByRole("button", { name: "Create variable" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The dashboard is saving.");
  });
});

describe("declaring from a selection", () => {
  it("creates a variable and binds the selection to it", async () => {
    const onDeclare = vi.fn();
    const onChange = vi.fn();
    render(
      <SavedQueryLibraryProvider queries={[]} variables={[]} values={{}} onDeclareVariable={onDeclare} dashboardId="service">
        <SelectionEditor widget={{ ...table, selectionBindings: [] }} onChange={onChange} />
      </SavedQueryLibraryProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "New variable…" }));
    fireEvent.change(await screen.findByLabelText("New variable name"), { target: { value: "env" } });
    fireEvent.click(screen.getByRole("button", { name: "Create variable" }));
    expect(onDeclare).toHaveBeenCalledWith({ name: "env" });
    expect(onChange.mock.lastCall![0].selectionBindings).toEqual([{ variable: "env", source: "label", value: "env" }]);
  });
});

describe("declaring from a saved query binding", () => {
  it("offers to declare an unavailable variable, prefilled with its name", async () => {
    const query: SavedQuery = { schemaVersion: 1, id: "q", name: "Q", providerId: "metrics", kind: "metrics", query: "up{env=$env}", parameters: [{ name: "env", type: "string" }] };
    render(
      <SavedQueryLibraryProvider queries={[query]} variables={[]} values={{}} onDeclareVariable={vi.fn()} dashboardId="service">
        <SavedQueryBindingEditor query={query} bindings={[{ parameter: "env", source: "variable", variable: "env" }]} onChange={vi.fn()} />
      </SavedQueryLibraryProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Declare {{env}}" }));
    expect(await screen.findByLabelText("New variable name")).toHaveValue("env");
    expect(screen.getByText(/Manage dashboards/)).toBeInTheDocument();
  });
});

describe("declaring from a link", () => {
  const link = { id: "l", title: "Open", dashboardId: "service", bindings: [{ variable: "env", source: "label" as const, value: "env" }] };
  const self = { id: "service", title: "Service", schemaVersion: 1, timeRange: "1h", refreshInterval: 30, widgets: [], variables: [] } as unknown as Dashboard;
  const other = { ...self, id: "other" };

  it("offers New variable only for a link back to this dashboard", () => {
    const widget = { ...table, drilldowns: [link] } as Widget;
    render(
      <SavedQueryLibraryProvider queries={[]} variables={[]} values={{}} onDeclareVariable={vi.fn()} dashboardId="service">
        <DrilldownEditor widget={widget} dashboards={[self]} onChange={vi.fn()} />
      </SavedQueryLibraryProvider>,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Link 1 binding 1 variable" }));
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: "New variable…" })).toBeVisible();
  });

  it("keeps the binding's value source and label key when it declares the target", async () => {
    const keyed = { ...link, bindings: [{ variable: "env", source: "label" as const, value: "deployment_env" }] };
    const onChange = vi.fn();
    const onDeclareVariable = vi.fn();
    render(
      <SavedQueryLibraryProvider queries={[]} variables={[]} values={{}} onDeclareVariable={onDeclareVariable} dashboardId="service">
        <DrilldownEditor widget={{ ...table, drilldowns: [keyed] } as Widget} dashboards={[self]} onChange={onChange} />
      </SavedQueryLibraryProvider>,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Link 1 binding 1 variable" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "New variable…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create variable" }, { timeout: 5000 }));
    expect(onDeclareVariable).toHaveBeenCalledWith({ name: "env" });
    expect(onChange.mock.lastCall![0].drilldowns[0].bindings).toEqual([{ variable: "env", source: "label", value: "deployment_env" }]);
  });

  it("lets a link back to a dashboard without variables declare one and bind it", async () => {
    const onChange = vi.fn();
    const onDeclareVariable = vi.fn();
    render(
      <SavedQueryLibraryProvider queries={[]} variables={[]} values={{}} onDeclareVariable={onDeclareVariable} dashboardId="service">
        <DrilldownEditor widget={{ ...table, drilldowns: [{ ...link, bindings: [] }] } as Widget} dashboards={[self]} onChange={onChange} />
      </SavedQueryLibraryProvider>,
    );
    expect(screen.getByText("This dashboard has no variables yet. Declare one to pass context.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "New variable…" }));
    fireEvent.change(await screen.findByLabelText("New variable name", undefined, { timeout: 5000 }), { target: { value: "service" } });
    fireEvent.click(screen.getByRole("button", { name: "Create variable" }));
    expect(onDeclareVariable).toHaveBeenCalledWith({ name: "service" });
    expect(onChange.mock.lastCall![0].drilldowns[0].bindings).toEqual([{ variable: "service", source: "label", value: "service" }]);
  });

  it("does not offer it for another dashboard", () => {
    const widget = { ...table, drilldowns: [{ ...link, dashboardId: "other" }] } as Widget;
    render(
      <SavedQueryLibraryProvider queries={[]} variables={[]} values={{}} onDeclareVariable={vi.fn()} dashboardId="service">
        <DrilldownEditor widget={widget} dashboards={[other]} onChange={vi.fn()} />
      </SavedQueryLibraryProvider>,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Link 1 binding 1 variable" }));
    expect(screen.queryByRole("option", { name: "New variable…" })).toBeNull();
  });
});
