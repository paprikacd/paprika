import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { queryConnectionKey, queryFields, suggestParameterConnection, tooltipMappingSuggestions } from "./query-connections";
import { SavedQueryBindingEditor } from "./saved-query-controls";
import { GraphLabelPicker } from "./query-connection-controls";
import { newWidget, type SavedQuery } from "./schema";

const fields = queryFields({ series: [
  { name: "requests", labels: { service: 'api"blue', status: "200" }, points: [] },
  { name: "requests", labels: { service: "worker" }, points: [] },
] });
const query: SavedQuery = { schemaVersion: 1, id: "connected", name: "Connected", kind: "metrics", providerId: "prom", query: "up", parameters: [
  { name: "service", type: "string" }, { name: "tenant", type: "string" },
  { name: "factor", type: "number", defaultValue: 1 }, { name: "existing", type: "number" },
] };
describe("query data connections", () => {
  it("keeps graph label connections on focus, commits discovered labels and retains typed names on blur", () => {
    const changed = vi.fn();
    function Picker() {
      const [value, setValue] = useState("service");
      return <><GraphLabelPicker label="Connected label" fields={fields} value={value} onChange={(next) => { changed(next); setValue(next); }} /><output data-testid="binding">{value}</output></>;
    }
    render(<Picker />);
    const input = screen.getByRole("combobox", { name: "Connected label" });
    fireEvent.focus(input); expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: /status/ }));
    expect(changed).toHaveBeenLastCalledWith("status");
    expect(screen.getByTestId("binding")).toHaveTextContent("status");
    fireEvent.change(input, { target: { value: "deployment" } }); fireEvent.blur(input);
    expect(screen.getByTestId("binding")).toHaveTextContent("deployment");
  });
  it("describes loaded labels, samples and partial availability without including history", () => {
    expect(fields).toEqual({ seriesCount: 2, partial: false, labels: [
      { name: "service", samples: ['api"blue', "worker"], present: 2 },
      { name: "status", samples: ["200"], present: 1 },
    ] });
    const many = queryFields({ truncated: true, series: Array.from({ length: 1001 }, (_, index) => ({ name: "up", labels: { service: String(index) }, points: [] })) });
    expect(many.seriesCount).toBe(1000); expect(many.partial).toBe(true); expect(many.labels[0].samples).toHaveLength(3);
  });
  it("connects exact graph labels only in observation-aware editors", () => {
    const parameter = { name: "service", type: "string" as const };
    expect(suggestParameterConnection(parameter, { fields })).toBeUndefined();
    expect(suggestParameterConnection(parameter, { fields, allowObservation: true })?.binding).toEqual({ parameter: "service", source: "label", label: "service" });
    expect(suggestParameterConnection({ ...parameter, name: "Service" }, { fields, allowObservation: true })).toBeUndefined();
  });
  it("reuses compatible graph connections but doesn't guess numeric labels or invalid variable values", () => {
    const variables = [{ name: "scale", defaultValue: "2.5" }];
    const parentBindings = [{ parameter: "factor", source: "variable" as const, variable: "scale" }];
    expect(suggestParameterConnection({ name: "factor", type: "number" }, { variables, parentBindings })?.binding).toEqual(parentBindings[0]);
    expect(suggestParameterConnection({ name: "scale", type: "number" }, { variables, values: { scale: "2 + 3" } })).toBeUndefined();
    expect(suggestParameterConnection({ name: "status", type: "number" }, { fields, allowObservation: true })).toBeUndefined();
  });
  it("maps exact observation field names only when their types agree", () => {
    expect(suggestParameterConnection({ name: "timestamp", type: "number" }, { allowObservation: true })?.binding).toEqual({ parameter: "timestamp", source: "field", field: "timestamp" });
    expect(suggestParameterConnection({ name: "value", type: "string" }, { allowObservation: true })).toBeUndefined();
  });
  it("finds missing provider placeholders without replacing explicit mappings or inventing labels", () => {
    const source = { type: "query" as const, providerId: "prom", query: 'up{service={{service}},status={{status}},unknown={{unknown}}} @ {{timestamp}} + {{value}}', bindings: [{ variable: "service", label: "chosen" }] };
    expect(tooltipMappingSuggestions(source, fields)).toEqual([{ variable: "status", label: "status" }, { variable: "timestamp", field: "timestamp" }, { variable: "value", field: "value" }]);
    expect(source.bindings).toEqual([{ variable: "service", label: "chosen" }]);
    expect(tooltipMappingSuggestions({ type: "query", providerId: "prom", query: "up > {{value}}" }, { ...fields, labels: [{ name: "value", samples: ["label-text"], present: 2 }] })).toEqual([]);
  });
  it("adds matching required connections together while preserving explicit values and saved defaults", () => {
    const onChange = vi.fn();
    const existing = { parameter: "existing", source: "constant" as const, value: 7 };
    render(<SavedQueryBindingEditor query={query} bindings={[existing]} variables={[{ name: "tenant", defaultValue: "prod" }, { name: "factor", defaultValue: "3" }]} fields={fields} allowObservation onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect 2 matching parameters" }));
    expect(onChange).toHaveBeenCalledWith([existing, { parameter: "service", source: "label", label: "service" }, { parameter: "tenant", source: "variable", variable: "tenant" }]);
    expect(screen.getByText(/Saved default:/)).toHaveTextContent("1");
  });
  it("invalidates field identity when a query, binding or range changes, but not appearance", () => {
    const widget = newWidget("stat", [], []); const range = { start: 1, end: 2 };
    expect(queryConnectionKey({ ...widget, title: "Different", color: "#ffffff" }, range)).toBe(queryConnectionKey(widget, range));
    expect(queryConnectionKey({ ...widget, query: "changed" }, range)).not.toBe(queryConnectionKey(widget, range));
    expect(queryConnectionKey(widget, { ...range, end: 3 })).not.toBe(queryConnectionKey(widget, range));
  });
});
