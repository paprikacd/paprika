import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardVariablesEditor } from "./dashboard-variables-editor";
import type { Dashboard, Provider, SavedQuery } from "./schema";
import type { VariableSourceCatalog } from "./variable-source-editor";

const baseDashboard: Dashboard = {
  schemaVersion: 1,
  id: "edge",
  title: "Edge watch",
  timeRange: "1h",
  refreshInterval: 30,
  widgets: [],
  variables: [{ name: "service", label: "Service", options: ["api", "worker"], defaultValue: "api" }],
};

function catalogFor(overrides: Partial<VariableSourceCatalog["loaders"]> = {}): VariableSourceCatalog {
  const providers = [
    { id: "metrics", name: "Metrics", type: "prometheus" },
    { id: "traces", name: "Traces", type: "tempo" },
  ] as Provider[];
  const savedQueries = [
    { id: "edge-services", name: "Edge services", kind: "records", query: "", providerId: "metrics" },
  ] as SavedQuery[];
  return {
    loaders: {
      scope: "live",
      metadata: vi.fn(async () => ({ values: ["omega", "delta"] })),
      query: vi.fn(async () => { throw new Error("no rows") }),
      ...overrides,
    },
    providers,
    savedQueries,
    labels: vi.fn(async () => ["cluster", "service"]),
  };
}

function chooseValuesFrom(option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Variable 1 values from" }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("variable value sources in the editor", () => {
  it("offers provider label values with a live preview and keeps the typed choices as fallback", async () => {
    const catalog = catalogFor();
    const onApply = vi.fn();
    render(<DashboardVariablesEditor dashboard={baseDashboard} onApply={onApply} catalog={catalog} />);
    chooseValuesFrom("Provider label values");
    fireEvent.click(screen.getByRole("combobox", { name: "Variable 1 provider" }));
    fireEvent.click(screen.getByRole("option", { name: new RegExp("^Metrics") }));
    const labelInput = await screen.findByRole("combobox", { name: "Variable 1 label name" });
    fireEvent.change(labelInput, { target: { value: "cluster" } });
    expect(await screen.findByText(/2 values in the last 24 hours/)).toBeInTheDocument();
    expect(screen.getByText(/omega, delta/)).toBeInTheDocument();
    expect(catalog.loaders.metadata).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "metrics", label: "cluster" }),
      expect.anything(),
    );
    expect(screen.getByText("Fallback choices")).toBeInTheDocument();
    expect(screen.getByLabelText("Variable 1 option 1")).toHaveValue("api");
    fireEvent.click(screen.getByRole("button", { name: "Update variables" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.lastCall?.[0].variables).toEqual([
      {
        name: "service",
        label: "Service",
        options: ["api", "worker"],
        defaultValue: "api",
        source: { type: "labelValues", providerId: "metrics", label: "cluster" },
      },
    ]);
  });

  it("warns that a selector on a non-Prometheus provider will not load values, and does not query it", async () => {
    const catalog = catalogFor();
    render(<DashboardVariablesEditor dashboard={baseDashboard} onApply={vi.fn()} catalog={catalog} />);
    chooseValuesFrom("Provider label values");
    fireEvent.click(screen.getByRole("combobox", { name: "Variable 1 provider" }));
    fireEvent.click(screen.getByRole("option", { name: new RegExp("^Traces") }));
    fireEvent.change(screen.getByRole("textbox", { name: "Variable 1 selector" }), { target: { value: 'up{cluster="omega"}' } });
    expect(screen.getByRole("alert")).toHaveTextContent("the save warns and this selector will not load values");
    fireEvent.change(await screen.findByRole("combobox", { name: "Variable 1 label name" }), { target: { value: "service" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) });
    expect(catalog.loaders.metadata).not.toHaveBeenCalled();
  });

  it("previews a selector with its parent variable's default value", async () => {
    const catalog = catalogFor();
    const dashboard: Dashboard = {
      ...baseDashboard,
      variables: [
        { name: "cluster", label: "Cluster", defaultValue: "omega" },
        { name: "service", label: "Service", source: { type: "labelValues", providerId: "metrics", label: "service", selector: "up{cluster={{cluster}}}" } },
      ],
    };
    render(<DashboardVariablesEditor dashboard={dashboard} onApply={vi.fn()} catalog={catalog} />);
    expect(await screen.findByText(/2 values in the last 24 hours/, {}, { timeout: 2000 })).toBeInTheDocument();
    expect(catalog.loaders.metadata).toHaveBeenCalledWith(
      expect.objectContaining({ selector: expect.stringContaining('"omega"') }),
      expect.anything(),
    );
  });

  it("names the window the preview read: the dashboard's time range when one is set, else the last 24 hours", async () => {
    const dashboard: Dashboard = {
      ...baseDashboard,
      variables: [
        { name: "cluster", label: "Cluster", defaultValue: "omega" },
        { name: "service", label: "Service", source: { type: "labelValues", providerId: "metrics", label: "service", selector: "up{cluster={{cluster}}}" } },
      ],
    };
    const ranged = { ...catalogFor(), range: { start: 1_700_000_000, end: 1_700_003_600 } };
    const { unmount } = render(<DashboardVariablesEditor dashboard={dashboard} onApply={vi.fn()} catalog={ranged} />);
    expect(await screen.findByText(/2 values in the dashboard's time range/)).toBeInTheDocument();
    expect(screen.queryByText(/in the last 24 hours/)).not.toBeInTheDocument();
    unmount();
    render(<DashboardVariablesEditor dashboard={dashboard} onApply={vi.fn()} catalog={catalogFor()} />);
    expect(await screen.findByText(/2 values in the last 24 hours/)).toBeInTheDocument();
    expect(screen.queryByText(/dashboard's time range/)).not.toBeInTheDocument();
  });

  it("previews over the dashboard's view range when the catalog names one", async () => {
    const catalog = { ...catalogFor(), range: { start: 1_700_000_000, end: 1_700_003_600 } };
    const dashboard: Dashboard = {
      ...baseDashboard,
      variables: [
        { name: "cluster", label: "Cluster", defaultValue: "omega" },
        { name: "service", label: "Service", source: { type: "labelValues", providerId: "metrics", label: "service", selector: "up{cluster={{cluster}}}" } },
      ],
    };
    render(<DashboardVariablesEditor dashboard={dashboard} onApply={vi.fn()} catalog={catalog} />);
    await vi.waitFor(() => expect(catalog.loaders.metadata).toHaveBeenCalledWith(
      expect.objectContaining({ start: 1_700_000_000, end: 1_700_003_600 }),
      expect.anything(),
    ));
  });

  it("saves a saved-query source and shows a failed preview without losing the column", async () => {
    const catalog = catalogFor();
    const onApply = vi.fn();
    render(<DashboardVariablesEditor dashboard={baseDashboard} onApply={onApply} catalog={catalog} />);
    chooseValuesFrom("Saved query column");
    fireEvent.click(screen.getByRole("combobox", { name: "Variable 1 saved query" }));
    fireEvent.click(screen.getByRole("option", { name: new RegExp("^Edge services") }));
    fireEvent.change(screen.getByRole("textbox", { name: "Variable 1 column or label" }), { target: { value: "service" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Preview failed: no rows");
    fireEvent.click(screen.getByRole("button", { name: "Update variables" }));
    expect(onApply.mock.lastCall?.[0].variables[0].source).toEqual({ type: "savedQuery", queryRef: { id: "edge-services" }, field: "service" });
  });
});
