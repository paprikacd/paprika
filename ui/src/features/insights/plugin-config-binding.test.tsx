import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginConfigEditor } from "./plugin-config-editor";
import type { QueryResult } from "./schema";
import type { QueryFields } from "./query-connections";
import type { WidgetConfigField, WidgetDefinition, WidgetInputIssue } from "./widget-registry";

afterEach(cleanup);

const Renderer = () => null;
function definition(configFields: WidgetConfigField[], extra: Partial<WidgetDefinition> = {}): WidgetDefinition {
  return { id: "binding-test", type: "plugin", label: "Binding test", description: "Field mapping", dataKind: "records", render: Renderer, configFields, ...extra } as WidgetDefinition;
}

const loaded: QueryResult = {
  records: {
    columns: [
      { key: "service", type: "string" },
      { key: "latency", type: "number", unit: "s" },
      { key: "requests", type: "number", unit: "ms" },
    ],
    rows: [["checkout", 1.2, 40]],
  },
};
const snapshot: QueryFields = {
  seriesCount: 0,
  labels: [],
  partial: false,
  recordColumns: [{ name: "service", type: "string" }, { name: "requests", type: "number" }],
};

function editor(def: WidgetDefinition, value: unknown, props: Partial<Parameters<typeof PluginConfigEditor>[0]> = {}) {
  return render(<PluginConfigEditor definition={def} value={JSON.stringify(value)} onChange={() => {}} {...props} />);
}

describe("record column mappings", () => {
  it("keeps the legacy numeric-field wording for a recordColumn number field", () => {
    const def = definition([{ key: "value", label: "Value field", kind: "text", recordColumn: "number" }]);
    editor(def, { value: "service" }, { queryFields: snapshot });
    expect(screen.getByText("“service” is string; choose a numeric field.")).toBeInTheDocument();
  });

  it("lists only columns of the bound types as suggestions", () => {
    const def = definition([{ key: "value", label: "Value field", kind: "text", binding: { types: ["number"] } }]);
    const { container } = editor(def, { value: "requests" }, { result: loaded });
    const suggestions = Array.from(container.querySelectorAll("datalist option")).map((option) => option.getAttribute("value"));
    expect(suggestions).toEqual(["latency", "requests"]);
  });

  it("keeps every column as a suggestion for a recordColumn any field", () => {
    const def = definition([{ key: "label", label: "Label field", kind: "text", recordColumn: "any" }]);
    const { container } = editor(def, { label: "service" }, { queryFields: snapshot });
    expect(Array.from(container.querySelectorAll("datalist option")).map((option) => option.getAttribute("value"))).toEqual(["service", "requests"]);
  });
});

describe("explicit field bindings", () => {
  it("states the required type and unit beside the field", () => {
    const def = definition([{ key: "latency", label: "Latency", kind: "text", binding: { types: ["number"], unit: "ms", role: "Request latency" } }]);
    editor(def, { latency: "latency" }, { result: loaded });
    expect(screen.getByText("Requires a numeric field in ms.")).toBeInTheDocument();
  });

  it("asks for a source field when the mapping is empty and required, but not when it is optional", () => {
    const required = definition([{ key: "value", label: "Value", kind: "text", binding: { types: ["number"] } }]);
    const { unmount } = editor(required, { value: "" }, { result: loaded });
    expect(screen.getByText("Choose a source field.")).toBeInTheDocument();
    unmount();
    const optional = definition([{ key: "value", label: "Value", kind: "text", binding: { types: ["number"], optional: true } }]);
    editor(optional, { value: "" }, { result: loaded });
    expect(screen.queryByText("Choose a source field.")).not.toBeInTheDocument();
  });

  it("reports a mapped column that the loaded result does not have", () => {
    const def = definition([{ key: "value", label: "Value", kind: "text", binding: { types: ["number"] } }]);
    editor(def, { value: "latencyMs" }, { result: loaded });
    expect(screen.getByText("The current result has no “latencyMs” field.")).toBeInTheDocument();
  });

  it("reports a column of the wrong type, naming the type it declares", () => {
    const def = definition([{ key: "value", label: "Value", kind: "text", binding: { types: ["number"] } }]);
    editor(def, { value: "service" }, { result: loaded });
    expect(screen.getByText("“service” is string; choose a numeric field.")).toBeInTheDocument();
  });

  it("reports a column whose unit the binding does not accept, when the loaded result declares units", () => {
    const def = definition([{ key: "latency", label: "Latency", kind: "text", binding: { types: ["number"], unit: "ms" } }]);
    editor(def, { latency: "latency" }, { result: loaded });
    expect(screen.getByText("“latency” uses s; choose a field in ms.")).toBeInTheDocument();
  });

  it("accepts any of several accepted units", () => {
    const def = definition([{ key: "latency", label: "Latency", kind: "text", binding: { types: ["number"], acceptedUnits: ["s", "ms"] } }]);
    editor(def, { latency: "latency" }, { result: loaded });
    expect(screen.queryByText(/uses /)).not.toBeInTheDocument();
    expect(screen.getByText("Requires a numeric field in s or ms.")).toBeInTheDocument();
  });

  it("does not guess at units from a query snapshot that carries none", () => {
    const def = definition([{ key: "latency", label: "Latency", kind: "text", binding: { types: ["number"], unit: "ms" } }]);
    editor(def, { latency: "requests" }, { queryFields: snapshot });
    expect(screen.queryByText(/uses /)).not.toBeInTheDocument();
  });
});

describe("renderer data checks", () => {
  const capacityDefinition = (validateInput: NonNullable<WidgetDefinition["validateInput"]>) =>
    definition([{ key: "capacity", label: "Capacity", kind: "text" }], { validateInput });

  it("runs the renderer's check against the loaded result and configuration", () => {
    const validateInput = vi.fn((): WidgetInputIssue[] => []);
    editor(capacityDefinition(validateInput), { capacity: "limit" }, { result: loaded });
    expect(validateInput).toHaveBeenCalledWith(loaded, { capacity: "limit" });
    expect(screen.queryByRole("list", { name: "Configuration issues" })).not.toBeInTheDocument();
  });

  it("lists each issue the renderer reports", () => {
    const issues: WidgetInputIssue[] = [{ field: "capacity", message: "The capacity field is missing." }, { message: "Forecast rows are empty." }];
    editor(capacityDefinition(() => issues), { capacity: "limit" }, { result: loaded });
    const list = screen.getByRole("list", { name: "Configuration issues" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["The capacity field is missing.", "Forecast rows are empty."]);
  });

  it("does not run the check without a loaded result", () => {
    const validateInput = vi.fn((): WidgetInputIssue[] => [{ message: "unused" }]);
    editor(capacityDefinition(validateInput), { capacity: "limit" }, { queryFields: snapshot });
    expect(validateInput).not.toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: "Configuration issues" })).not.toBeInTheDocument();
  });

  it("reports a check that throws as an issue instead of accepting the data", () => {
    editor(capacityDefinition(() => { throw new Error("boom"); }), { capacity: "limit" }, { result: loaded });
    expect(screen.getByText("The loaded result could not be checked for this widget.")).toBeInTheDocument();
  });
});
