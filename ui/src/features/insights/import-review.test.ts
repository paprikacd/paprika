import { describe, expect, it } from "vitest";
import {
  canKeepSavedQuery,
  diffImportDocuments,
  MAX_IMPORT_DIFF_CHANGES,
  remapImportBundle,
  requiredImportProviders,
  reviewDashboard,
  reviewSavedQuery,
  savedQueryCompatibility,
} from "./import-review";
import {
  buildDashboardBundle,
  savedQueryFingerprint,
  selectBundleDashboards,
} from "./workspace-transfer";
import type {
  Dashboard,
  Provider,
  SavedQuery,
  SavedQueryEntry,
} from "./schema";

const query: SavedQuery = {
  schemaVersion: 1,
  id: "requests",
  name: "Requests by service",
  providerId: "prom",
  kind: "metrics",
  query: "rate(requests{service={{service}}}[5m]) > {{minimum}}",
  parameters: [
    {
      name: "service",
      type: "string",
      defaultValue: 'api"west\\blue\n{{text}}',
    },
    { name: "minimum", type: "number", defaultValue: 0 },
  ],
};
const dashboard: Dashboard = {
  schemaVersion: 1,
  id: "overview",
  title: "Overview",
  folder: "Production/Services",
  timeRange: "1h",
  refreshInterval: 0,
  variables: [{ name: "service", defaultValue: "api" }],
  widgets: [
    {
      id: "health",
      title: "Health",
      type: "heatmap",
      providerId: "dormant-source",
      query: "retained_custom_query",
      unit: "req/s",
      layout: { x: 0, y: 0, w: 6, h: 4 },
      queryRef: {
        id: query.id,
        bindings: [
          { parameter: "service", source: "variable", variable: "service" },
          { parameter: "minimum", source: "constant", value: 0 },
        ],
      },
      options: {
        tooltipView: {
          type: "stat",
          source: {
            type: "saved",
            ref: {
              id: query.id,
              bindings: [
                { parameter: "service", source: "label", label: "service" },
                { parameter: "minimum", source: "field", field: "value" },
              ],
            },
          },
        },
      },
    },
  ],
};
const providers: Provider[] = [
  {
    id: "prom",
    name: "Metrics",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  {
    id: "other",
    name: "Other metrics",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  { id: "tempo", name: "Traces", type: "tempo", capabilities: ["traces"] },
];

describe("import review snapshots", () => {
  it("compares canonical documents and captures only the reviewed revision and complete fingerprint", () => {
    const reordered = Object.fromEntries(
      Object.entries(dashboard).reverse(),
    ) as Dashboard;
    const review = reviewDashboard(reordered, {
      document: dashboard,
      etag: '"v1"',
    });
    expect(review.status).toBe("identical");
    expect(review.diff).toEqual({
      changes: [],
      totalChanges: 0,
      truncated: false,
    });
    expect(review.canReplace).toBe(true);
    expect(review.baseline?.etag).toBe('"v1"');
    expect(JSON.parse(review.baseline!.fingerprint)).toEqual(dashboard);
    const entry: SavedQueryEntry = { ...query, etag: '"transport-only"' };
    const queryReview = reviewSavedQuery(entry, {
      document: entry,
      etag: '"reviewed"',
    });
    expect(queryReview.status).toBe("identical");
    expect(queryReview.baseline).toEqual({
      fingerprint: savedQueryFingerprint(query),
      etag: '"reviewed"',
    });
    expect(queryReview.diff.changes).toEqual([]);
    expect(queryReview.baseline!.fingerprint).not.toContain("etag");
    expect(entry.etag).toBe('"transport-only"');
  });
  it("requires a reviewed ETag for replacement and refuses mismatched identities", () => {
    expect(reviewDashboard(dashboard)).toMatchObject({
      status: "new",
      canReplace: false,
    });
    expect(reviewDashboard(dashboard)).not.toHaveProperty("baseline");
    expect(reviewDashboard(dashboard, { document: dashboard })).toMatchObject({
      status: "identical",
      canReplace: false,
      replaceBlockedReason: expect.stringMatching(/revision/),
    });
    expect(
      reviewSavedQuery(query, { document: query, etag: "" }).canReplace,
    ).toBe(false);
    expect(() =>
      reviewDashboard(dashboard, {
        document: { ...dashboard, id: "different" },
        etag: '"v1"',
      }),
    ).toThrow(/same ID/);
    expect(() =>
      reviewSavedQuery(query, {
        document: { ...query, id: "different" },
        etag: '"v1"',
      }),
    ).toThrow(/same ID/);
  });
  it("reports immutable query provider/kind changes while retaining a meaningful diff", () => {
    const changed = { ...query, providerId: "other" };
    expect(
      reviewSavedQuery(changed, { document: query, etag: '"v1"' }),
    ).toMatchObject({
      status: "conflict",
      canReplace: false,
      replaceBlockedReason: expect.stringMatching(/data source and kind/),
    });
    expect(
      reviewSavedQuery(changed, { document: query, etag: '"v1"' }).diff.changes,
    ).toContainEqual({
      path: "providerId",
      kind: "change",
      before: "prom",
      after: "other",
    });
    expect(
      reviewSavedQuery(
        { ...query, kind: "traces" },
        { document: query, etag: '"v1"' },
      ).canReplace,
    ).toBe(false);
    expect(
      reviewSavedQuery(
        { ...query, name: "New name", query: "sum(requests)" },
        { document: query, etag: '"v1"' },
      ).canReplace,
    ).toBe(true);
  });
  it("validates strict schema and template grammar instead of silently discarding non-transport fields", () => {
    expect(() =>
      reviewSavedQuery({ ...query, secret: "hidden" } as SavedQuery),
    ).toThrow();
    expect(() =>
      reviewSavedQuery({ ...query, query: 'requests{service="{{service}}"}' }),
    ).toThrow(/quotes/);
    expect(() =>
      reviewDashboard({ ...dashboard, unexpected: true } as Dashboard),
    ).toThrow();
  });
});

describe("readable structural changes", () => {
  it("uses widget, parameter and binding identities while preserving additions, removals and reordering", () => {
    const old: Dashboard = {
      ...dashboard,
      widgets: [
        ...dashboard.widgets,
        { ...dashboard.widgets[0], id: "remove", title: "Remove" },
        { ...dashboard.widgets[0], id: "second", title: "Second" },
      ],
    };
    const changed = structuredClone(old);
    changed.title = "Changed overview";
    delete changed.folder;
    changed.widgets = [
      changed.widgets[2],
      changed.widgets[0],
      { ...changed.widgets[1], id: "add", title: "Add" },
    ];
    changed.widgets[1].layout.w = 12;
    changed.widgets[1].queryRef!.bindings![0] = {
      parameter: "service",
      source: "constant",
      value: "other",
    };
    const result = reviewDashboard(changed, { document: old, etag: '"v1"' });
    expect(result.status).toBe("conflict");
    expect(result.diff.changes).toEqual(
      expect.arrayContaining([
        {
          path: "title",
          kind: "change",
          before: "Overview",
          after: "Changed overview",
        },
        { path: "folder", kind: "remove", before: "Production/Services" },
        {
          path: "widgets",
          kind: "reorder",
          before: ["health", "remove", "second"],
          after: ["second", "health", "add"],
        },
        {
          path: "widgets[id=health].layout.w",
          kind: "change",
          before: 6,
          after: 12,
        },
        {
          path: "widgets[id=health].queryRef.bindings[parameter=service].source",
          kind: "change",
          before: "variable",
          after: "constant",
        },
        {
          path: "widgets[id=health].queryRef.bindings[parameter=service].variable",
          kind: "remove",
          before: "service",
        },
        {
          path: "widgets[id=health].queryRef.bindings[parameter=service].value",
          kind: "add",
          after: "other",
        },
        { path: "widgets[id=remove]", kind: "remove", before: old.widgets[1] },
        { path: "widgets[id=add]", kind: "add", after: changed.widgets[2] },
      ]),
    );
    const defaults = reviewSavedQuery(
      {
        ...query,
        parameters: [
          { ...query.parameters![1], defaultValue: -7.25 },
          query.parameters![0],
        ],
      },
      { document: query, etag: '"v1"' },
    ).diff;
    expect(defaults.changes).toEqual([
      {
        path: "parameters",
        kind: "reorder",
        before: ["service", "minimum"],
        after: ["minimum", "service"],
      },
      {
        path: "parameters[name=minimum].defaultValue",
        kind: "change",
        before: 0,
        after: -7.25,
      },
    ]);
  });
  it("does not report insertion as a reorder or convert primitive values to lossy strings", () => {
    const result = diffImportDocuments(
      { widgets: [{ id: "a", enabled: false, value: 0, nullable: null }] },
      {
        widgets: [
          { id: "b" },
          { id: "a", enabled: true, value: -1, added: null },
        ],
      },
    );
    expect(result.changes).toEqual(
      expect.arrayContaining([
        { path: "widgets[id=b]", kind: "add", after: { id: "b" } },
        {
          path: "widgets[id=a].enabled",
          kind: "change",
          before: false,
          after: true,
        },
        { path: "widgets[id=a].value", kind: "change", before: 0, after: -1 },
        { path: "widgets[id=a].nullable", kind: "remove", before: null },
        { path: "widgets[id=a].added", kind: "add", after: null },
      ]),
    );
    expect(result.changes.some((change) => change.kind === "reorder")).toBe(
      false,
    );
    expect(
      diffImportDocuments(
        { "label.with.dot": "old" },
        { "label.with.dot": "new" },
      ).changes[0].path,
    ).toBe('["label.with.dot"]');
  });
  it("bounds rendered changes while reporting the full count and keeps exact query text", () => {
    const previous = Object.fromEntries(
      Array.from({ length: 275 }, (_, i) => [`field${i}`, 0]),
    );
    const next = Object.fromEntries(
      Array.from({ length: 275 }, (_, i) => [`field${i}`, 1]),
    );
    const result = diffImportDocuments(previous, next);
    expect(result.totalChanges).toBe(275);
    expect(result.changes).toHaveLength(MAX_IMPORT_DIFF_CHANGES);
    expect(result.truncated).toBe(true);
    const source = `up{label="${"a".repeat(7000)}"}`;
    expect(
      reviewSavedQuery(
        { ...query, query: source },
        { document: query, etag: '"v1"' },
      ).diff.changes,
    ).toContainEqual({
      path: "query",
      kind: "change",
      before: query.query,
      after: source,
    });
  });
  it("treats JSON keys that shadow object methods as ordinary added or removed fields", () => {
    const value = JSON.parse('{"toString":false,"hasOwnProperty":0}');
    expect(diffImportDocuments({}, value).changes).toEqual([
      { path: "hasOwnProperty", kind: "add", after: 0 },
      { path: "toString", kind: "add", after: false },
    ]);
    expect(diffImportDocuments(value, {}).changes).toEqual([
      { path: "hasOwnProperty", kind: "remove", before: 0 },
      { path: "toString", kind: "remove", before: false },
    ]);
  });
});

describe("saved query binding compatibility", () => {
  it("checks both widget and tooltip references, names affected dashboards and ignores unrelated definitions", () => {
    const valid = savedQueryCompatibility(query, [dashboard]);
    expect(valid).toEqual({
      compatible: true,
      issues: [],
      affectedDashboardIds: [dashboard.id],
    });
    const unrelated = {
      ...dashboard,
      id: "unrelated",
      widgets: dashboard.widgets.map((widget) => ({
        ...widget,
        queryRef: {
          id: "unrelated",
          bindings: [
            { parameter: "missing", source: "constant" as const, value: 1 },
          ],
        },
        options: undefined,
      })),
    };
    const withoutService = {
      ...query,
      query: "up > {{minimum}}",
      parameters: [query.parameters![1]],
    };
    const broken = savedQueryCompatibility(withoutService, [
      dashboard,
      unrelated,
    ]);
    expect(broken.compatible).toBe(false);
    expect(broken.affectedDashboardIds).toEqual([dashboard.id]);
    expect(broken.issues).toHaveLength(2);
    expect(broken.issues.map((issue) => issue.location)).toEqual([
      "widget",
      "tooltip",
    ]);
    expect(broken.reason).toContain("Overview / health (widget)");
    expect(
      broken.issues.every((issue) => issue.reason.includes("service")),
    ).toBe(true);
  });
  it("rejects incomplete Keep contracts and undeclared variables without evaluating view values", () => {
    const bundle = buildDashboardBundle([dashboard], [query]);
    expect(
      canKeepSavedQuery(bundle, query.id, { ...query, query: "changed_body" })
        .compatible,
    ).toBe(true);
    expect(
      canKeepSavedQuery(bundle, query.id, {
        ...query,
        parameters: [
          ...query.parameters!,
          { name: "required", type: "number" },
        ],
      }).reason,
    ).toMatch(/required.*no binding or default/);
    expect(
      savedQueryCompatibility(query, [{ ...dashboard, variables: [] }]).reason,
    ).toMatch(/variable.*not declared/);
    expect(() => canKeepSavedQuery(bundle, "other", query)).toThrow(/same ID/);
    const numericVariables = structuredClone(dashboard);
    numericVariables.variables!.push({
      name: "minimum",
      defaultValue: "set this later",
    });
    numericVariables.widgets[0].queryRef!.bindings![1] = {
      parameter: "minimum",
      source: "variable",
      variable: "minimum",
    };
    expect(savedQueryCompatibility(query, [numericVariables]).compatible).toBe(
      true,
    );
  });
  it("reports newly broken constants and exact observation fields on replacement", () => {
    const changed: SavedQuery = {
      ...query,
      parameters: [
        query.parameters![0],
        { name: "minimum", type: "string", defaultValue: "0" },
      ],
    };
    const result = savedQueryCompatibility(changed, [dashboard], query);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].reason).toMatch(/needs text/);
    expect(result.issues[1].reason).toMatch(/Observation value/);
    const missing = {
      ...query,
      parameters: [
        ...query.parameters!,
        { name: "window", type: "number" as const },
      ],
    };
    expect(
      savedQueryCompatibility(missing, [dashboard], query).issues,
    ).toHaveLength(2);
  });
  it("blocks dynamic variable/label parameter type changes, even when a default is supplied", () => {
    const changed: SavedQuery = {
      ...query,
      parameters: [
        { name: "service", type: "number", defaultValue: 1 },
        query.parameters![1],
      ],
    };
    const result = savedQueryCompatibility(changed, [dashboard], query);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.map((issue) => issue.reason).join(" ")).toMatch(
      /dashboard-variable.*observation-label/,
    );
    const defaultsOnly: Dashboard = {
      ...dashboard,
      widgets: [
        {
          ...dashboard.widgets[0],
          queryRef: { id: query.id },
          options: undefined,
        },
      ],
    };
    expect(
      savedQueryCompatibility(changed, [defaultsOnly], query).compatible,
    ).toBe(true);
  });
  it("allows harmless edits despite pre-existing broken references but rejects new problems", () => {
    const broken = structuredClone(dashboard);
    broken.variables = [];
    broken.widgets[0].queryRef!.bindings!.push({
      parameter: "old-missing",
      source: "constant",
      value: 1,
    });
    // Variable/parameter identifiers cannot contain hyphens.
    broken.widgets[0].queryRef!.bindings!.at(-1)!.parameter = "old_missing";
    broken.widgets[0].queryRef!.bindings![1] = {
      parameter: "minimum",
      source: "constant",
      value: "not a number",
    };
    expect(savedQueryCompatibility(query, [broken]).compatible).toBe(false);
    expect(
      savedQueryCompatibility(
        { ...query, name: "Renamed", query: "sum(up)" },
        [broken],
        query,
      ).compatible,
    ).toBe(true);
    const required: SavedQuery = {
      ...query,
      parameters: [
        ...query.parameters!,
        { name: "new_required", type: "string" },
      ],
    };
    const issues = savedQueryCompatibility(required, [broken], query).issues;
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.reason.includes("new_required"))).toBe(
      true,
    );
  });
  it("checks unsaved draft references without validating unrelated incomplete authoring fields", () => {
    const draft = { ...dashboard, title: "" };
    expect(savedQueryCompatibility({ ...query, name: "Renamed" }, [draft], query).compatible).toBe(true);
    const incompatible: SavedQuery = { ...query, parameters: [{ name: "service", type: "number", defaultValue: 1 }, query.parameters![1]] };
    expect(savedQueryCompatibility(incompatible, [draft], query).issues).toHaveLength(2);
    expect(() => reviewDashboard(draft)).toThrow();
  });
  it("distinguishes removed unbound defaults from defaults that explicit bindings already supply", () => {
    const noMinimumDefault: SavedQuery = {
      ...query,
      parameters: [query.parameters![0], { name: "minimum", type: "number" }],
    };
    expect(
      savedQueryCompatibility(noMinimumDefault, [dashboard], query).compatible,
    ).toBe(true);
    const defaultsOnly: Dashboard = {
      ...dashboard,
      widgets: [
        {
          ...dashboard.widgets[0],
          queryRef: { id: query.id },
          options: undefined,
        },
      ],
    };
    expect(
      savedQueryCompatibility(noMinimumDefault, [defaultsOnly], query).reason,
    ).toMatch(/minimum.*no binding or default/);
    expect(
      savedQueryCompatibility(
        {
          ...query,
          query: "up > {{minimum}}",
          parameters: [query.parameters![1]],
        },
        [defaultsOnly],
        query,
      ).compatible,
    ).toBe(true);
  });
});

describe("effective import sources", () => {
  it("compares after mapping and keeps destination definitions without requiring their incoming source", () => {
    const incoming: SavedQuery = { ...query, providerId: "foreign" };
    const bundle = buildDashboardBundle([dashboard], [incoming]);
    const mapped = remapImportBundle(
      bundle,
      { foreign: "prom" },
      providers,
      new Map(),
    );
    expect(
      reviewSavedQuery(mapped.savedQueries![0], {
        document: query,
        etag: '"v1"',
      }).status,
    ).toBe("identical");
    expect(
      [...requiredImportProviders(bundle, new Set())].map(([id, kinds]) => [
        id,
        [...kinds],
      ]),
    ).toEqual([["foreign", ["metrics"]]]);
    expect(requiredImportProviders(bundle, new Set([query.id])).size).toBe(0);
    const retained: SavedQueryEntry = {
      ...query,
      query: "kept_destination_body",
      etag: '"v2"',
    };
    const kept = remapImportBundle(
      bundle,
      {},
      providers,
      new Map([[query.id, retained]]),
    );
    expect(kept.savedQueries).toEqual([
      { ...query, query: "kept_destination_body" },
    ]);
    expect(kept.dashboards[0].widgets[0].providerId).toBe("dormant-source");
    expect(bundle.savedQueries?.[0].providerId).toBe("foreign");
    expect(() => remapImportBundle(bundle, {}, providers, new Map())).toThrow(
      /compatible data source/,
    );
    expect(() =>
      remapImportBundle(bundle, { foreign: "tempo" }, providers, new Map()),
    ).toThrow(/compatible data source/);
    expect(() =>
      remapImportBundle(
        bundle,
        {},
        providers,
        new Map([
          [
            query.id,
            {
              ...query,
              parameters: [
                ...query.parameters!,
                { name: "required", type: "number" },
              ],
            },
          ],
        ]),
      ),
    ).toThrow(/Bind required parameter/);
  });
  it("retains custom provider requirements and excludes dependencies of dashboards selected Keep", () => {
    const custom: Dashboard = {
      ...dashboard,
      id: "custom",
      widgets: [
        {
          ...dashboard.widgets[0],
          queryRef: undefined,
          providerId: "foreign",
          options: {
            tooltipView: {
              type: "stat",
              source: {
                type: "query",
                providerId: "tooltip-foreign",
                query: "up",
              },
            },
          },
        },
      ],
    };
    const bundle = buildDashboardBundle(
      [dashboard, custom],
      [{ ...query, providerId: "unused-when-dashboard-kept" }],
    );
    const active = selectBundleDashboards(bundle, ["custom"]);
    expect(
      [...requiredImportProviders(active, new Set())].map(([id]) => id),
    ).toEqual(["foreign", "tooltip-foreign"]);
    const mapped = remapImportBundle(
      active,
      { foreign: "prom", "tooltip-foreign": "other" },
      providers,
      new Map(),
    );
    expect(mapped.savedQueries).toEqual([]);
    expect(mapped.dashboards[0].widgets[0].providerId).toBe("prom");
    expect(
      mapped.dashboards[0].widgets[0].options?.tooltipView?.source,
    ).toMatchObject({ providerId: "other" });
    expect(
      remapImportBundle({ dashboards: [dashboard] }, {}, providers, new Map()),
    ).not.toHaveProperty("savedQueries");
  });
});
