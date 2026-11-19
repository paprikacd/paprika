import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardVariablesEditor, VariableBar } from "./dashboard-variables";
import type { Dashboard } from "./schema";
import { sessionVariableValueCache } from "./variable-options";

const dashboard: Dashboard = {
  schemaVersion: 1,
  id: "service",
  title: "Service detail",
  timeRange: "1h",
  refreshInterval: 30,
  widgets: [],
  variables: [
    { name: "service", label: "Service", defaultValue: "api" },
    { name: "region", label: "Region" },
  ],
};

describe("dashboard variable declarations", () => {
  it("authors reusable dropdown choices without changing the default or applying while typing", () => {
    const onApply = vi.fn();
    render(<DashboardVariablesEditor dashboard={{ ...dashboard, variables: [dashboard.variables![0]] }} onApply={onApply} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Variable 1 values from" }));
    fireEvent.click(screen.getByRole("option", { name: "Typed list" }));
    expect(screen.getByLabelText("Variable 1 option 1")).toHaveValue("api");
    fireEvent.click(screen.getByRole("button", { name: "Add choice" }));
    fireEvent.change(screen.getByLabelText("Variable 1 option 2"), { target: { value: "worker" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Variable 1 values from" }));
    fireEvent.click(screen.getByRole("option", { name: "Typed list" }));
    expect(screen.getByLabelText("Variable 1 option 2")).toHaveValue("worker");
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply variables" }));
    expect(onApply.mock.lastCall?.[0].variables).toEqual([{ name: "service", label: "Service", defaultValue: "api", options: ["api", "worker"] }]);
  });
  it("stages declarations, validates unique names and preserves unset versus empty defaults", () => {
    const onApply = vi.fn();
    render(
      <DashboardVariablesEditor dashboard={dashboard} onApply={onApply} />,
    );
    fireEvent.change(screen.getByLabelText("Variable 2 name"), {
      target: { value: "service" },
    });
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply variables" }));
    expect(screen.getByRole("alert")).toHaveTextContent("unique");
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Variable 2 name"), {
      target: { value: "region" },
    });
    const switches = screen.getAllByRole("switch", {
      name: /^Use a default value/,
    });
    fireEvent.click(switches[0]);
    fireEvent.click(switches[1]);
    fireEvent.click(screen.getByRole("button", { name: "Apply variables" }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: [
          { name: "service", label: "Service" },
          { name: "region", label: "Region", defaultValue: "" },
        ],
      }),
    );
  });

  it("rejects unsafe names and blocks stale declaration edits while preserving other dashboard changes", () => {
    const onApply = vi.fn();
    const { rerender } = render(
      <DashboardVariablesEditor dashboard={dashboard} onApply={onApply} />,
    );
    fireEvent.change(screen.getByLabelText("Variable 1 name"), {
      target: { value: "__proto__" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variables" }));
    expect(screen.getByRole("alert")).toHaveTextContent("reserved");
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Variable 1 name"), {
      target: { value: "deployment" },
    });
    rerender(
      <DashboardVariablesEditor
        dashboard={{ ...dashboard, title: "Renamed elsewhere" }}
        onApply={onApply}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply variables" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Renamed elsewhere",
        variables: expect.arrayContaining([
          expect.objectContaining({ name: "deployment" }),
        ]),
      }),
    );
    const external = { ...dashboard, variables: [{ name: "environment" }] };
    rerender(
      <DashboardVariablesEditor dashboard={external} onApply={onApply} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("changed elsewhere");
    expect(
      screen.getByRole("button", { name: "Apply variables" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Variable 1 name")).toHaveValue("deployment");
    fireEvent.click(screen.getByRole("button", { name: "Reload variables" }));
    expect(screen.getByLabelText("Variable 1 name")).toHaveValue("environment");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("adopts applied declarations and allows a later edit without incorrectly reporting a conflict", () => {
    const applied = vi.fn();
    function Harness() {
      const [draft, setDraft] = useState(dashboard);
      return (
        <DashboardVariablesEditor
          dashboard={draft}
          onApply={(value) => {
            setDraft(value);
            applied(value);
          }}
        />
      );
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Variable 1 display label"), {
      target: { value: "Selected service" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply variables" }));
    expect(
      screen.getByRole("button", { name: "Apply variables" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Variable 1 default value"), {
      target: { value: "worker" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply variables" }));
    expect(applied).toHaveBeenCalledTimes(2);
    expect(applied.mock.lastCall?.[0].variables[0].defaultValue).toBe("worker");
  });

  it("limits declarations to twenty and starts a fresh draft when switching dashboards", () => {
    const onApply = vi.fn();
    const full = {
      ...dashboard,
      variables: Array.from({ length: 20 }, (_, index) => ({
        name: `variable_${index + 1}`,
      })),
    };
    const { rerender } = render(
      <DashboardVariablesEditor dashboard={full} onApply={onApply} />,
    );
    expect(screen.getByRole("button", { name: "Add variable" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove variable 20" }));
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    expect(screen.getByLabelText("Variable 20 name")).toHaveValue(
      "variable_20",
    );
    rerender(
      <DashboardVariablesEditor
        dashboard={{ ...dashboard, id: "another" }}
        onApply={onApply}
      />,
    );
    expect(screen.getByLabelText("Variable 1 name")).toHaveValue("service");
    expect(screen.getAllByRole("switch")).toHaveLength(2);
  });
});

describe("dashboard variable value bar", () => {
  it("applies only the selected dropdown while preserving staged text for Apply values", () => {
    const onApply = vi.fn();
    function Harness() {
      const [values, setValues] = useState({ service: "api", region: "east" });
      return <VariableBar dashboard={{ ...dashboard, variables: [{ name: "service", label: "Service", options: ["api", "worker"] }, { name: "region", label: "Region" }] }}
        values={values} onApply={(next) => { onApply(next); setValues(next as typeof values); }} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "west" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Service" }));
    fireEvent.click(screen.getByRole("option", { name: "worker" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ service: "worker", region: "east" });
    expect(screen.getByLabelText("Region")).toHaveValue("west");
    fireEvent.click(screen.getByRole("button", { name: "Apply values" }));
    expect(onApply).toHaveBeenLastCalledWith({ service: "worker", region: "west" });
  });
  it("applies dropdown selections immediately, preserving focus and exact values", () => {
    const choices = ["api", 'worker"\\{{literal}}', ""];
    const onApply = vi.fn();
    function Harness() {
      const [values, setValues] = useState({ service: "api" });
      return <VariableBar dashboard={{ ...dashboard, variables: [{ name: "service", label: "Service", defaultValue: "api", options: choices }] }}
        values={values} onApply={(next) => { onApply(next); setValues(next as typeof values); }} />;
    }
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Service" });
    expect(screen.queryByRole("button", { name: "Apply values" })).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: choices[1] }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ service: choices[1] });
    expect(screen.getByRole("combobox", { name: "Service" })).toBe(trigger);
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Empty value" }));
    expect(onApply).toHaveBeenLastCalledWith({ service: "" });
  });

  it("retains values from links and an unset value without silently choosing an option", () => {
    const onApply = vi.fn();
    const withChoices = { ...dashboard, variables: [{ name: "service", label: "Service", options: ["api", "worker", ""] }] };
    const { rerender } = render(<VariableBar dashboard={withChoices} values={{ service: "custom-service" }} onApply={onApply} />);
    expect(screen.getByRole("combobox", { name: "Service" })).toHaveTextContent("custom-service");
    fireEvent.click(screen.getByRole("combobox", { name: "Service" }));
    expect(screen.getByRole("option", { name: /^custom-service/ })).toHaveTextContent("Value from dashboard link");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Service" }), { key: "Escape" });
    rerender(<VariableBar dashboard={withChoices} values={{}} onApply={onApply} />);
    expect(screen.getByRole("combobox", { name: "Service" })).toHaveTextContent("Choose a value");
    expect(onApply).not.toHaveBeenCalled();
    expect(withChoices.variables[0].options).toEqual(["api", "worker", ""]);
  });

  it("never applies while typing and submits raw strings once, with defaults and intentionally empty values", () => {
    const onApply = vi.fn();
    render(<VariableBar dashboard={dashboard} values={{}} onApply={onApply} />);
    expect(screen.getByLabelText("Service")).toHaveValue("api");
    expect(screen.getByRole("button", { name: "Apply values" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Service"), {
      target: { value: 'api" or 1 == 1' },
    });
    fireEvent.change(screen.getByLabelText("Region"), {
      target: { value: "east" },
    });
    fireEvent.change(screen.getByLabelText("Region"), {
      target: { value: "" },
    });
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByRole("form", { name: "Dashboard variables" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith({
      service: 'api" or 1 == 1',
      region: "",
    });
  });

  it("preserves a draft during unrelated updates and resets it for a new navigation", () => {
    const onApply = vi.fn();
    const { rerender } = render(
      <VariableBar
        dashboard={dashboard}
        values={{ service: "api", region: "east" }}
        onApply={onApply}
      />,
    );
    fireEvent.change(screen.getByLabelText("Service"), {
      target: { value: "pending" },
    });
    rerender(
      <VariableBar
        dashboard={{ ...dashboard, title: "New title" }}
        values={{ region: "east", service: "api" }}
        onApply={onApply}
      />,
    );
    expect(screen.getByLabelText("Service")).toHaveValue("pending");
    fireEvent.click(screen.getByRole("button", { name: "Reset values" }));
    expect(screen.getByLabelText("Service")).toHaveValue("api");
    fireEvent.change(screen.getByLabelText("Service"), {
      target: { value: "pending" },
    });
    rerender(
      <VariableBar
        dashboard={dashboard}
        values={{ service: "worker", region: "west" }}
        onApply={onApply}
      />,
    );
    expect(screen.getByLabelText("Service")).toHaveValue("worker");
    expect(screen.getByLabelText("Region")).toHaveValue("west");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("starts a fresh draft for another dashboard even when its declarations and values match", () => {
    const onApply = vi.fn();
    const values = { service: "api", region: "east" };
    const { rerender } = render(<VariableBar dashboard={dashboard} values={values} onApply={onApply} />);
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "pending" } });
    rerender(<VariableBar dashboard={{ ...dashboard, id: "other" }} values={values} onApply={onApply} />);
    expect(screen.getByLabelText("Service")).toHaveValue("api");
    expect(screen.getByRole("button", { name: "Apply values" })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("does not invent empty values for unset declarations, and hides for dashboards without variables", () => {
    const onApply = vi.fn();
    const { rerender } = render(
      <VariableBar dashboard={dashboard} values={{}} onApply={onApply} />,
    );
    fireEvent.change(screen.getByLabelText("Service"), {
      target: { value: "worker" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply values" }));
    expect(onApply).toHaveBeenCalledWith({ service: "worker" });
    rerender(
      <VariableBar
        dashboard={{ ...dashboard, variables: [] }}
        values={{}}
        onApply={onApply}
      />,
    );
    expect(screen.queryByRole("form")).toBeNull();
  });
});

describe("dashboard variable value sources", () => {
  const range = { start: 1_000_000, end: 1_003_600 };
  // The session cache is shared by every bar in the page; each case starts from an empty one.
  beforeEach(() => sessionVariableValueCache.clear());
  const sourced: Dashboard = {
    ...dashboard,
    variables: [
      { name: "cluster", label: "Cluster", defaultValue: "omega", source: { type: "labelValues", providerId: "prom", label: "cluster" } },
      { name: "service", label: "Service", source: { type: "labelValues", providerId: "prom", label: "service", selector: "up{cluster={{cluster}}}" } },
    ],
  };
  function loaderFor(values: Record<string, string[] | Error>) {
    return {
      scope: "live",
      metadata: vi.fn(async (request: { label: string }) => {
        const answer = values[request.label] ?? [];
        if (answer instanceof Error) throw answer;
        return { values: answer };
      }),
      query: vi.fn(),
    };
  }
  function Harness({ loaders, variables = sourced.variables }: { loaders?: unknown; variables?: Dashboard["variables"] }) {
    const [values, setValues] = useState<Record<string, string>>({ cluster: "omega" });
    return <VariableBar dashboard={{ ...sourced, variables }} values={values} range={range} loaders={loaders as never}
      onApply={(next) => setValues(next as Record<string, string>)} />;
  }

  it("loads a dropdown source on open and lists its values", async () => {
    const loaders = loaderFor({ cluster: ["omega", "delta"] });
    render(<Harness loaders={loaders} />);
    const input = screen.getByRole("combobox", { name: "Cluster" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "delta" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "omega" })).toBeInTheDocument();
    expect(loaders.metadata).toHaveBeenCalledWith(expect.objectContaining({ label: "cluster" }), expect.any(AbortSignal));
  });

  it("marks a current value that the loaded list does not contain as not current", async () => {
    const loaders = loaderFor({ cluster: ["omega", "delta"] });
    render(<VariableBar dashboard={{ ...dashboard, variables: [sourced.variables![0]] }} values={{ cluster: "prod" }} range={range} loaders={loaders} onApply={() => {}} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Cluster" }), { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "delta" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /prod/ })).toHaveTextContent("Not in current values");
  });

  it("asks for the parent before a dependent source can load", () => {
    const loaders = loaderFor({});
    const unset = { name: "cluster", label: "Cluster", source: { type: "labelValues" as const, providerId: "prom", label: "cluster" } };
    render(<VariableBar dashboard={{ ...sourced, variables: [unset, sourced.variables![1]] }} values={{}} range={range} loaders={loaders} onApply={() => {}} />);
    expect(screen.getByText("Set Cluster to load values")).toBeInTheDocument();
    expect(loaders.metadata).not.toHaveBeenCalled();
  });

  it("keeps a free-text source's typed value until Apply values and marks an unknown value", async () => {
    const onApply = vi.fn();
    const loaders = loaderFor({ service: ["api"] });
    function Typed() {
      const [values, setValues] = useState<Record<string, string>>({ cluster: "omega" });
      return <VariableBar dashboard={{ ...sourced, variables: [sourced.variables![0], { name: "service", label: "Service", source: { type: "labelValues", providerId: "prom", label: "service" } }] }}
        values={values} range={range} loaders={loaders} onApply={(next) => { onApply(next); setValues(next as Record<string, string>) }} />;
    }
    render(<Typed />);
    fireEvent.change(screen.getByRole("combobox", { name: "Service" }), { target: { value: "checkout" } });
    expect(onApply).not.toHaveBeenCalled();
    const typed = await screen.findByRole("option", { name: /^checkout/ });
    expect(typed).toHaveTextContent("Not in current values");
    fireEvent.click(typed);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply values" }));
    expect(onApply).toHaveBeenLastCalledWith({ cluster: "omega", service: "checkout" });
  });

  it("applies a loaded value as soon as it is picked", async () => {
    const onApply = vi.fn();
    const loaders = loaderFor({ cluster: ["omega", "delta"] });
    render(<VariableBar dashboard={{ ...dashboard, variables: [sourced.variables![0]] }} values={{ cluster: "omega" }} range={range} loaders={loaders} onApply={onApply} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Cluster" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "delta" }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ cluster: "delta" }));
  });

  it("accepts a typed value next to a saved fallback list and stages it until Apply values", async () => {
    const onApply = vi.fn();
    const loaders = loaderFor({ cluster: new Error("provider down") });
    render(<VariableBar dashboard={{ ...dashboard, variables: [{ ...sourced.variables![0], options: ["omega", "delta"] }] }} values={{ cluster: "omega" }} range={range} loaders={loaders} onApply={onApply} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Cluster" }), { target: { value: "prod" } });
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply values" }));
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ cluster: "prod" }));
  });

  it("shows saved choices and a retry when the source fails", async () => {
    const loaders = loaderFor({ cluster: new Error("provider down") });
    render(<Harness loaders={loaders} variables={[{ ...sourced.variables![0], options: ["omega", "delta"] }]} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Cluster" }), { key: "ArrowDown" });
    expect(await screen.findByText("Could not load values: provider down")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^delta/ })).toHaveTextContent("Saved choice");
    loaders.metadata.mockResolvedValueOnce({ values: ["omega", "gamma"] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("option", { name: "gamma" })).toBeInTheDocument();
  });

  it("explains an invalid source once, with no retry that cannot succeed", () => {
    const loaders = loaderFor({ cluster: ["omega"] });
    const broken = { name: "service", label: "Service", source: { type: "labelValues" as const, providerId: "prom", label: "service", selector: 'up{cluster="{{cluster}}"}' } };
    render(<VariableBar dashboard={{ ...dashboard, variables: [sourced.variables![0], broken] }} values={{ cluster: "omega" }} range={range} loaders={loaders} onApply={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load values:");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("names truncation on a free-text source", async () => {
    const loaders = { scope: "live", metadata: vi.fn(async () => ({ values: ["a", "b"], truncated: true })), query: vi.fn() } as never;
    render(<Harness loaders={loaders} variables={[{ name: "cluster", label: "Cluster", source: { type: "labelValues", providerId: "prom", label: "cluster" } }]} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Cluster" }), { key: "ArrowDown" });
    expect(await screen.findByText("First 2 values; type to enter another")).toBeInTheDocument();
  });
});
