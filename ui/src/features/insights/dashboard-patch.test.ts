import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyDashboardPatch,
  documentChanges,
  readDashboardPatchSource,
  validateDashboardPatch,
  type JSONObject,
} from "./dashboard-patch";

type Fixture = {
  etag: string;
  cases: { name: string; document: JSONObject; arguments: Record<string, unknown>; expect: { document: JSONObject; placements: unknown[] } | { error: string; reason: string } }[];
};

// The same cases run against the Go port (internal/observabilitygateway/insights_patch_conformance_test.go).
const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/design/insights/conformance/dashboard-patch.json");
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const base = (): JSONObject => ({
  schemaVersion: 1,
  id: "demo",
  title: "Service overview",
  timeRange: "1h",
  widgets: [
    { id: "a", title: "Rate", layout: { x: 0, y: 0, w: 6, h: 4 } },
    { id: "b", title: "Errors", layout: { x: 6, y: 0, w: 6, h: 4 } },
  ],
});

describe("dashboard patch conformance fixtures", () => {
  it.each(fixture.cases.map((testCase) => [testCase.name, testCase] as const))("%s", (_name, testCase) => {
    const input = { id: "demo", etag: fixture.etag, ...testCase.arguments };
    const result = applyDashboardPatch(structuredClone(testCase.document), input);
    if ("error" in testCase.expect) {
      expect(result.error).not.toBeNull();
      expect(result.error?.code).toBe(testCase.expect.error);
      expect(result.error?.reason).toBe(testCase.expect.reason);
      expect(result.document).toBeNull();
      return;
    }
    expect(result.error).toBeNull();
    expect(result.document).toEqual(testCase.expect.document);
    expect(result.placements).toEqual(testCase.expect.placements);
  });
});

describe("applyDashboardPatch", () => {
  it("never mutates the input document or arguments", () => {
    const document = base();
    const input = { widget_edits: [{ op: "update", id: "a", patch: { title: "Changed" } }, { op: "remove", id: "b" }] };
    const snapshot = JSON.stringify([document, input]);
    applyDashboardPatch(document, input);
    expect(JSON.stringify([document, input])).toBe(snapshot);
  });

  it("reports one error for 49 edits and names no placement", () => {
    const edits = Array.from({ length: 49 }, (_, index) => ({ op: "remove", id: `w${index}` }));
    const result = applyDashboardPatch(base(), { widget_edits: edits });
    expect(result.error?.reason).toBe("limit");
    expect(result.placements).toEqual([]);
  });

  it("names the failing edit index and widget", () => {
    const result = applyDashboardPatch(base(), { widget_edits: [{ op: "update", id: "a", patch: { title: "x" } }, { op: "remove", id: "zz" }] });
    expect(result.error).toMatchObject({ code: "not_found", editIndex: 1, widgetId: "zz" });
  });

  it("rejects an input that is not an object", () => {
    expect(validateDashboardPatch([]).error?.reason).toBe("input");
    expect(validateDashboardPatch("patch").error?.reason).toBe("input");
  });
});

describe("readDashboardPatchSource", () => {
  it("reads patch arguments, a patch_dashboard call and a bare widget_edits array", () => {
    expect(readDashboardPatchSource({ id: "demo", widget_edits: [] })).toEqual({ id: "demo", widget_edits: [] });
    expect(readDashboardPatchSource({ name: "patch_dashboard", arguments: { id: "demo", patch: { title: "x" } } })).toEqual({ id: "demo", patch: { title: "x" } });
    const bare = readDashboardPatchSource([{ op: "remove", id: "a" }]);
    expect(bare).toEqual({ widget_edits: [{ op: "remove", id: "a" }] });
  });

  it("treats a full document as no patch", () => {
    expect(readDashboardPatchSource(base())).toBeNull();
    expect(readDashboardPatchSource({ widgets: [], widget_edits: [] })).toBeNull();
  });
});

describe("documentChanges", () => {
  it("lists a moved widget as moved, with its layout fields", () => {
    const before = base();
    const after = structuredClone(before);
    const widgets = after.widgets as JSONObject[];
    widgets[1] = { ...widgets[1], layout: { x: 0, y: 4, w: 6, h: 4 } };
    const changes = documentChanges(before, after);
    expect(changes.dashboard.totalChanges).toBe(0);
    expect(changes.widgets).toHaveLength(1);
    expect(changes.widgets[0]).toMatchObject({ id: "b", kind: "moved" });
    expect(changes.widgets[0].diff.changes.map((change) => change.path)).toEqual(["layout.x", "layout.y"]);
  });

  it("omits unchanged widgets and reports removed and added widgets", () => {
    const before = base();
    const after = { ...structuredClone(before), widgets: [{ id: "c", title: "New", layout: { x: 0, y: 8, w: 6, h: 4 } }] } as JSONObject;
    const changes = documentChanges(before, after);
    expect(changes.widgets.map((widget) => [widget.id, widget.kind])).toEqual([
      ["c", "added"],
      ["a", "removed"],
      ["b", "removed"],
    ]);
  });
});
