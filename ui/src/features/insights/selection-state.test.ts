import { describe, expect, it } from "vitest";
import type { Dashboard } from "./schema";
import { appliedFilterFor, selectionApplied } from "./selection-state";

const dashboard = {
  schemaVersion: 1,
  id: "overview",
  title: "Overview",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [],
  variables: [{ name: "service" }],
} as unknown as Dashboard;
const scope = (variables: Record<string, string>) => ({ dashboard, variables });
const bindings = [{ variable: "service", source: "label" as const, value: "service" }];

describe("selectionApplied", () => {
  it("is true when the context's label is the dashboard's current value", () => {
    expect(selectionApplied(scope({ service: "api" }), bindings, { labels: { service: "api" } })).toBe(true);
  });

  it("is false for another value", () => {
    expect(selectionApplied(scope({ service: "worker" }), bindings, { labels: { service: "api" } })).toBe(false);
  });

  it("is false when the context lacks the bound label, the same case a selection rejects", () => {
    expect(selectionApplied(scope({ service: "" }), bindings, { labels: { other: "api" } })).toBe(false);
  });

  it("is false when there are no bindings", () => {
    expect(appliedFilterFor(scope({ service: "api" }), undefined)({ labels: { service: "api" } })).toBe(false);
    expect(appliedFilterFor(scope({ service: "api" }), [])({ labels: { service: "api" } })).toBe(false);
  });

  it("is false with no scope, as outside a canvas", () => {
    expect(appliedFilterFor(undefined, bindings)({ labels: { service: "api" } })).toBe(false);
  });
});
