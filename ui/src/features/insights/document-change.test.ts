import { describe, expect, it } from "vitest";
import { documentChangeSummary, documentChangeText } from "./document-change";
import type { Dashboard } from "./schema";

const widget = (id: string, title = id): Dashboard["widgets"][number] => ({
  id,
  title,
  type: "stat",
  providerId: "metrics",
  query: "up",
  unit: "",
  layout: { x: 0, y: 0, w: 4, h: 2 },
});
const dashboard = (widgets: Dashboard["widgets"]): Dashboard => ({
  schemaVersion: 1,
  id: "a",
  title: "A",
  timeRange: "1h",
  refreshInterval: 0,
  widgets,
});

describe("documentChangeSummary", () => {
  it("counts added, changed and removed widgets by id", () => {
    const before = dashboard([widget("a"), widget("b"), widget("c")]);
    const after = dashboard([widget("a", "Renamed"), widget("c"), widget("d")]);
    expect(documentChangeSummary(before, after)).toEqual({ added: 1, changed: 1, removed: 1 });
  });

  it("reports nothing for identical documents and ignores order", () => {
    const before = dashboard([widget("a"), widget("b")]);
    expect(documentChangeSummary(before, dashboard([widget("a"), widget("b")]))).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
    });
    expect(documentChangeSummary(before, dashboard([widget("b"), widget("a")]))).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
    });
  });

  it("does not count document-level edits as widget changes", () => {
    const before = dashboard([widget("a")]);
    expect(documentChangeSummary(before, { ...before, title: "Other" })).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
    });
  });

  it("matches a duplicated id against its first occurrence", () => {
    const before = dashboard([widget("a", "First"), widget("a", "Second")]);
    const after = dashboard([widget("a", "Second")]);
    expect(documentChangeSummary(before, after)).toEqual({ added: 0, changed: 1, removed: 0 });
  });
});

describe("documentChangeText", () => {
  it("formats the counts in the order the panels show them", () => {
    expect(documentChangeText({ added: 2, changed: 0, removed: 1 })).toBe(
      "2 added · 0 changed · 1 removed",
    );
  });
});
