import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveFieldBinding,
  getWidgetDefinition,
  registerWidgetPlugin,
  widgetDefinitions,
  widgetInputIssues,
  type WidgetDefinition,
  type WidgetPlugin,
} from "./widget-registry";
import type { QueryResult } from "./schema";

const Renderer = () => null;
const base = { label: "Contract plugin", description: "Checks the registry contract", dataKind: "records" as const, render: Renderer };
const unregister: (() => void)[] = [];
afterEach(() => {
  while (unregister.length) unregister.pop()!();
});
function register(id: string, extra: Partial<WidgetPlugin> = {}) {
  unregister.push(registerWidgetPlugin({ ...base, id, ...extra }));
  return getWidgetDefinition("plugin", id)!;
}

describe("widget registry contracts", () => {
  it("leaves every built-in registration unchanged", () => {
    expect(widgetDefinitions.map((entry) => entry.id)).toEqual(["timeseries", "stat", "bar", "heatmap", "table", "traces"]);
    expect(widgetDefinitions.every((entry) => entry.validateInput === undefined && entry.sizing === undefined)).toBe(true);
  });

  it("accepts validateInput and sizing on a plugin, and keeps them on the registered definition", () => {
    const definition = register("contract-sized", {
      validateInput: () => [],
      sizing: { mode: "fill", minWidth: 240, minHeight: 0 },
    });
    expect(definition.sizing).toEqual({ mode: "fill", minWidth: 240, minHeight: 0 });
    expect(typeof definition.validateInput).toBe("function");
  });

  it("refuses sizing that the host cannot honour", () => {
    expect(() => register("contract-mode", { sizing: { mode: "auto" as unknown as "fill" } })).toThrow("sizing mode must be intrinsic or fill");
    expect(() => register("contract-width", { sizing: { mode: "intrinsic", minWidth: -1 } })).toThrow("sizing minWidth must be a finite, nonnegative number");
    expect(() => register("contract-height", { sizing: { mode: "fill", minHeight: Number.NaN } })).toThrow("sizing minHeight must be a finite, nonnegative number");
    expect(getWidgetDefinition("plugin", "contract-mode")).toBeUndefined();
  });

  it("refuses a validateInput that is not a function", () => {
    expect(() => register("contract-validate", { validateInput: "check" as unknown as () => [] })).toThrow("validateInput must be a function");
  });

  it("refuses bindings without a known type, and accepted units that list nothing", () => {
    const field = (binding: object) => ({ key: "value", label: "Value", kind: "text" as const, binding: binding as never });
    expect(() => register("contract-empty-types", { configFields: [field({ types: [] })] })).toThrow("needs binding types");
    expect(() => register("contract-bad-type", { configFields: [field({ types: ["date"] })] })).toThrow("needs binding types");
    expect(() => register("contract-units", { configFields: [field({ types: ["number"], acceptedUnits: [] })] })).toThrow("needs at least one accepted unit");
  });

  it("accepts the full binding vocabulary on a field", () => {
    const definition = register("contract-binding", {
      configFields: [{
        key: "latency",
        label: "Latency",
        kind: "text",
        binding: { types: ["number"], unit: "ms", acceptedUnits: ["ms", "s"], role: "Request latency", optional: true },
      }],
    });
    expect(definition.configFields?.[0].binding).toMatchObject({ types: ["number"], unit: "ms", optional: true });
  });
});

describe("field binding aliases", () => {
  it("treats an explicit binding as authoritative", () => {
    const binding = { types: ["timestamp"] as const, role: "Observed at" };
    expect(effectiveFieldBinding({ key: "at", label: "At", kind: "text", binding, recordColumn: "number" })).toBe(binding);
  });

  it("reads recordColumn as the equivalent binding", () => {
    expect(effectiveFieldBinding({ key: "value", label: "Value", kind: "text", recordColumn: "number" })).toEqual({ types: ["number"] });
    expect(effectiveFieldBinding({ key: "label", label: "Label", kind: "text", recordColumn: "any" })?.types).toEqual(["string", "number", "boolean", "timestamp"]);
    expect(effectiveFieldBinding({ key: "plain", label: "Plain", kind: "text" })).toBeUndefined();
  });
});

describe("validateInput", () => {
  const result: QueryResult = { records: { columns: [{ key: "forecast", type: "number" }], rows: [[1]] } };
  const definition = (validateInput?: WidgetDefinition["validateInput"]) => ({ validateInput } as Pick<WidgetDefinition, "validateInput"> as WidgetDefinition);

  it("reports nothing for a renderer without a data check", () => {
    expect(widgetInputIssues(definition(), result, {})).toEqual([]);
    expect(widgetInputIssues(undefined, result, {})).toEqual([]);
  });

  it("passes the loaded result and configuration to the check and returns its issues", () => {
    const seen: unknown[] = [];
    const issues = widgetInputIssues(definition((input, config) => {
      seen.push(input, config);
      return [{ field: "capacity", message: "The capacity field is missing." }];
    }), result, { capacity: "limit" });
    expect(issues).toEqual([{ field: "capacity", message: "The capacity field is missing." }]);
    expect(seen).toEqual([result, { capacity: "limit" }]);
  });

  it("reports a check that throws as an issue rather than accepting the data", () => {
    const issues = widgetInputIssues(definition(() => { throw new Error("boom"); }), result, {});
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe("The loaded result could not be checked for this widget.");
  });
});
