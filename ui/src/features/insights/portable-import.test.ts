import { describe, expect, it } from "vitest";
import {
  buildDashboardBundle,
  parseDashboardBundle,
  parseDashboardLibrary,
  serializeDashboardBundle,
  serializeDashboardLibrary,
  requiredBundleProviders,
  remapBundleProviders,
  remapBundleQueryReferences,
  selectBundleDashboards,
  queryImportStatus,
  savedQueryFingerprint,
  MAX_LIBRARY_BYTES,
  type DashboardBundle,
} from "./workspace-transfer";
import type {
  Dashboard,
  Provider,
  SavedQuery,
  SavedQueryEntry,
} from "./schema";

const shared: SavedQuery = {
  schemaVersion: 1,
  id: "availability",
  name: "Availability",
  description: "Availability of production services",
  imageUrl: "https://images.example.com/availability.png",
  tags: ["production", "availability"],
  metadata: { team: "platform", runbook: "https://docs.example.com/availability" },
  providerId: "old-prom",
  kind: "metrics",
  query: "up{service={{service}}} > {{minimum}}",
  parameters: [
    {
      name: "service",
      type: "string",
      defaultValue: 'checkout"blue\\west\n{{text}}',
    },
    { name: "minimum", type: "number", defaultValue: -7.25 },
  ],
};
const child: SavedQuery = {
  ...shared,
  id: "traces",
  name: "Service traces",
  providerId: "old-tempo",
  kind: "traces",
  query: "{ resource.service.name = {{service}} }",
  parameters: [{ name: "service", type: "string" }],
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
      providerId: "dormant-prom",
      query: "retained_custom_query",
      unit: "",
      layout: { x: 0, y: 0, w: 6, h: 4 },
      queryRef: {
        id: shared.id,
        bindings: [
          { parameter: "service", source: "variable", variable: "service" },
        ],
      },
      options: {
        tooltipView: {
          type: "traces",
          source: {
            type: "saved",
            ref: {
              id: child.id,
              bindings: [
                { parameter: "service", source: "label", label: "service" },
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
  { id: "tempo", name: "Traces", type: "tempo", capabilities: ["traces"] },
];
const envelope = (bundle: DashboardBundle) =>
  JSON.stringify({
    kind: "PaprikaDashboardLibrary",
    schemaVersion: 1,
    ...bundle,
  });

describe("portable dashboard bundle dependencies", () => {
  it.each(["json", "yaml"] as const)(
    "exports and reloads exact referenced definitions once through %s, without revision metadata or mutation",
    (format) => {
      const duplicateUse: Dashboard = {
        ...dashboard,
        id: "detail",
        widgets: [
          {
            ...dashboard.widgets[0],
            options: {
              tooltipView: {
                type: "stat",
                source: { type: "saved", ref: { id: shared.id } },
              },
            },
          },
        ],
      };
      const library: SavedQueryEntry[] = [
        { ...shared, etag: '"v1"' },
        { ...child, etag: '"v2"' },
        { ...shared, id: "unrelated", etag: '"v3"' },
      ];
      const original = structuredClone({
        documents: [dashboard, duplicateUse],
        library,
      });
      const source = serializeDashboardLibrary(
        [dashboard, duplicateUse],
        format,
        library,
      );
      const bundle = parseDashboardBundle(source, format);
      expect(bundle).toEqual({
        dashboards: [dashboard, duplicateUse],
        savedQueries: [shared, child],
      });
      expect(source).not.toContain("etag");
      expect(source).not.toContain("unrelated");
      expect({ documents: [dashboard, duplicateUse], library }).toEqual(
        original,
      );
      expect(parseDashboardLibrary(source, format)).toEqual([
        dashboard,
        duplicateUse,
      ]);
    },
  );
  it("preserves legacy reference-only inputs and treats explicit empty definitions as a complete bundle", () => {
    expect(parseDashboardBundle(JSON.stringify(dashboard), "json")).toEqual({
      dashboards: [dashboard],
    });
    expect(
      parseDashboardBundle(envelope({ dashboards: [dashboard] }), "json"),
    ).toEqual({ dashboards: [dashboard] });
    expect(() =>
      parseDashboardBundle(
        envelope({ dashboards: [dashboard], savedQueries: [] }),
        "json",
      ),
    ).toThrow(/missing from the bundle/);
    const empty: Dashboard = { ...dashboard, widgets: [] };
    expect(
      parseDashboardBundle(serializeDashboardLibrary([empty], "json"), "json"),
    ).toEqual({ dashboards: [empty], savedQueries: [] });
  });
  it("blocks incomplete exports and duplicate workspace IDs instead of silently embedding a different definition", () => {
    expect(() => buildDashboardBundle([dashboard], [shared])).toThrow(
      /traces.*unavailable/,
    );
    expect(() =>
      buildDashboardBundle([dashboard], [shared, shared, child]),
    ).toThrow(/Duplicate saved query ID/);
    expect(() => buildDashboardBundle([dashboard], [])).toThrow(/unavailable/);
  });
  it("rejects missing, duplicate, unused and unknown embedded definitions, including ETags", () => {
    for (const savedQueries of [
      [shared],
      [shared, child, shared],
      [shared, child, { ...shared, id: "unused" }],
      [{ ...shared, etag: '"v1"' }, child],
      [{ ...shared, unknown: true }, child],
    ])
      expect(() =>
        parseDashboardBundle(
          envelope({
            dashboards: [dashboard],
            savedQueries,
          } as DashboardBundle),
          "json",
        ),
      ).toThrow();
    expect(() =>
      parseDashboardBundle(
        JSON.stringify({
          kind: "PaprikaDashboardLibrary",
          schemaVersion: 1,
          dashboards: [dashboard],
          savedQueries: [shared, child],
          providers: [],
        }),
        "json",
      ),
    ).toThrow(/Invalid dashboard library/);
    expect(() =>
      parseDashboardBundle(
        JSON.stringify({
          kind: "PaprikaDashboardLibrary",
          schemaVersion: 2,
          dashboards: [dashboard],
          savedQueries: [shared, child],
        }),
        "json",
      ),
    ).toThrow(/Invalid dashboard library/);
  });
  it("rejects unsafe templates, wrong kinds and broken parameter contracts before import", () => {
    expect(() =>
      buildDashboardBundle(
        [dashboard],
        [{ ...shared, query: 'up{service="{{service}}"}' }, child],
      ),
    ).toThrow(/quotes/);
    expect(() =>
      buildDashboardBundle([dashboard], [{ ...shared, kind: "traces" }, child]),
    ).toThrow(/does not provide metrics/);
    expect(() =>
      buildDashboardBundle(
        [dashboard],
        [
          {
            ...shared,
            query: "up > {{minimum}}",
            parameters: [{ name: "minimum", type: "number", defaultValue: 0 }],
          },
          child,
        ],
      ),
    ).toThrow(/no parameter.*service/);
    const wrongConstant: Dashboard = {
      ...dashboard,
      widgets: [
        {
          ...dashboard.widgets[0],
          queryRef: {
            id: shared.id,
            bindings: [
              { parameter: "minimum", source: "constant", value: "1 or up" },
            ],
          },
        },
      ],
    };
    expect(() =>
      buildDashboardBundle([wrongConstant], [shared, child]),
    ).toThrow(/finite number/);
    const wrongField: Dashboard = {
      ...dashboard,
      widgets: [
        {
          ...dashboard.widgets[0],
          options: {
            tooltipView: {
              type: "stat",
              source: {
                type: "saved",
                ref: {
                  id: shared.id,
                  bindings: [
                    { parameter: "minimum", source: "field", field: "series" },
                  ],
                },
              },
            },
          },
        },
      ],
    };
    expect(() => buildDashboardBundle([wrongField], [shared])).toThrow(
      /incompatible/,
    );
  });
  it("requires declared dashboard variables and complete required parameter mappings, but defers runtime variable values", () => {
    expect(() =>
      buildDashboardBundle([{ ...dashboard, variables: [] }], [shared, child]),
    ).toThrow(/does not declare variable/);
    const unbound: Dashboard = {
      ...dashboard,
      widgets: [
        {
          ...dashboard.widgets[0],
          options: {
            tooltipView: {
              type: "traces",
              source: { type: "saved", ref: { id: child.id } },
            },
          },
        },
      ],
    };
    expect(() => buildDashboardBundle([unbound], [shared, child])).toThrow(
      /Bind required parameter.*service/,
    );
    const numeric: Dashboard = {
      ...dashboard,
      variables: [
        { name: "service" },
        { name: "minimum", defaultValue: "set-at-runtime" },
      ],
      widgets: [
        {
          ...dashboard.widgets[0],
          queryRef: {
            id: shared.id,
            bindings: [
              ...dashboard.widgets[0].queryRef!.bindings!,
              { parameter: "minimum", source: "variable", variable: "minimum" },
            ],
          },
        },
      ],
    };
    expect(() =>
      buildDashboardBundle([numeric], [shared, child]),
    ).not.toThrow();
  });
  it("rejects YAML aliases, merge keys and duplicate keys", () => {
    expect(() =>
      parseDashboardBundle(
        "kind: PaprikaDashboardLibrary\nschemaVersion: 1\ndashboards: &docs []\nsavedQueries: *docs",
        "yaml",
      ),
    ).toThrow();
    expect(() =>
      parseDashboardBundle(
        "kind: PaprikaDashboardLibrary\nschemaVersion: 1\nschemaVersion: 1\ndashboards: []",
        "yaml",
      ),
    ).toThrow();
    expect(() =>
      parseDashboardBundle(
        "kind: PaprikaDashboardLibrary\nschemaVersion: 1\n<<: {}\ndashboards: []",
        "yaml",
      ),
    ).toThrow();
  });
});

describe("bundle bounds and strict serialization", () => {
  it("enforces source, dashboard, saved-query and count limits", () => {
    expect(() =>
      parseDashboardBundle(" ".repeat(MAX_LIBRARY_BYTES + 1), "json"),
    ).toThrow(/4 MiB/);
    const tooLarge: Dashboard = {
      ...dashboard,
      widgets: Array.from({ length: 48 }, (_, index) => ({
        ...dashboard.widgets[0],
        id: `widget-${index}`,
        query: "x".repeat(8192),
      })),
    };
    expect(() => buildDashboardBundle([tooLarge], [shared, child])).toThrow(
      /256 KiB/,
    );
    const largeQuery: SavedQuery = {
      ...shared,
      query: `up{label="${"界".repeat(7000)}"}`,
      parameters: Array.from({ length: 20 }, (_, index) => ({
        name: `p${index}`,
        type: "string",
        defaultValue: "x".repeat(1024),
      })),
    };
    expect(() =>
      parseDashboardBundle(
        envelope({
          dashboards: [dashboard],
          savedQueries: [largeQuery, child],
        }),
        "json",
      ),
    ).toThrow(/32 KiB/);
    expect(() =>
      parseDashboardBundle(
        envelope({
          dashboards: [dashboard],
          savedQueries: Array.from({ length: 257 }, (_, index) => ({
            ...shared,
            id: `query-${index}`,
          })),
        }),
        "json",
      ),
    ).toThrow(/256 saved queries/);
    expect(() =>
      parseDashboardBundle(
        envelope({
          dashboards: Array.from({ length: 101 }, (_, index) => ({
            ...dashboard,
            id: `dashboard-${index}`,
          })),
        }),
        "json",
      ),
    ).toThrow(/100 dashboards/);
    expect(() =>
      serializeDashboardBundle({ dashboards: [dashboard, dashboard] }, "json"),
    ).toThrow(/Duplicate dashboard ID/);
  });
  it("checks serialized output size as well as imported source size", () => {
    const base: Dashboard = {
      ...dashboard,
      widgets: Array.from({ length: 24 }, (_, index) => ({
        ...dashboard.widgets[0],
        id: `widget-${index}`,
        query: "x".repeat(6000),
        queryRef: undefined,
        options: undefined,
      })),
    };
    const docs = Array.from({ length: 30 }, (_, index) => ({
      ...base,
      id: `dashboard-${index}`,
    }));
    expect(() =>
      serializeDashboardBundle({ dashboards: docs }, "json"),
    ).toThrow(/4 MiB/);
  });
});

describe("bundle import planning", () => {
  it("reviews every active source and maps bundled definitions/custom sources, preserving dormant drafts", () => {
    const custom: Dashboard = {
      ...dashboard,
      id: "custom",
      widgets: [
        {
          ...dashboard.widgets[0],
          queryRef: undefined,
          providerId: "custom-prom",
          options: {
            tooltipView: {
              type: "traces",
              source: {
                type: "query",
                providerId: "custom-tempo",
                query: "{}",
              },
            },
          },
        },
      ],
    };
    const bundle = buildDashboardBundle([dashboard, custom], [shared, child]);
    expect(
      [...requiredBundleProviders(bundle)].map(([id, kinds]) => [
        id,
        [...kinds],
      ]),
    ).toEqual([
      ["custom-prom", ["metrics"]],
      ["custom-tempo", ["traces"]],
      ["old-prom", ["metrics"]],
      ["old-tempo", ["traces"]],
    ]);
    expect(() =>
      remapBundleProviders(bundle, { "old-prom": "tempo" }, providers),
    ).toThrow(/compatible/);
    const mapped = remapBundleProviders(
      bundle,
      {
        "old-prom": "prom",
        "old-tempo": "tempo",
        "custom-prom": "prom",
        "custom-tempo": "tempo",
        "dormant-prom": "prom",
      },
      providers,
    );
    expect(mapped.savedQueries?.map((query) => query.providerId)).toEqual([
      "prom",
      "tempo",
    ]);
    expect(mapped.dashboards[0].widgets[0]).toMatchObject({
      providerId: "dormant-prom",
      query: "retained_custom_query",
      queryRef: dashboard.widgets[0].queryRef,
    });
    expect(
      mapped.dashboards[1].widgets[0].options?.tooltipView?.source,
    ).toMatchObject({ providerId: "tempo" });
    expect(bundle.savedQueries?.[0].providerId).toBe("old-prom");
  });
  it("classifies same-ID definitions without considering ETags or key order, but detects real changes", () => {
    const entry: SavedQueryEntry = { ...shared, etag: '"revision"' };
    const reordered = JSON.parse(
      JSON.stringify(shared, Object.keys(shared).reverse()),
    ) as SavedQuery;
    // Nested parameter key order is independently canonicalized.
    reordered.parameters = shared.parameters!.map(
      (parameter) =>
        Object.fromEntries(
          Object.entries(parameter).reverse(),
        ) as typeof parameter,
    );
    reordered.metadata = Object.fromEntries(Object.entries(shared.metadata!).reverse());
    expect(savedQueryFingerprint(reordered)).toBe(savedQueryFingerprint(entry));
    expect(queryImportStatus(shared, [])).toBe("new");
    expect(queryImportStatus(shared, [entry])).toBe("identical");
    for (const changed of [
      { ...shared, providerId: "prom" },
      { ...shared, query: "sum(up)" },
      {
        ...shared,
        parameters: [
          { name: "service", type: "string" as const, defaultValue: "other" },
          shared.parameters![1],
        ],
      },
      { ...shared, name: "Changed name" },
    ])
      expect(queryImportStatus(shared, [changed])).toBe("conflict");
    expect(queryImportStatus(shared, [{ ...shared, id: "another-id" }])).toBe(
      "new",
    );
    expect(() => queryImportStatus(shared, [shared, entry])).toThrow(
      /Duplicate/,
    );
  });
  it("rewrites copied definition IDs and both reference locations while retaining exact bindings", () => {
    const bundle = buildDashboardBundle([dashboard], [shared, child]);
    const mapped = remapBundleQueryReferences(bundle, {
      availability: "availability-copy",
      traces: "traces-copy",
    });
    expect(mapped.savedQueries?.map((query) => query.id)).toEqual([
      "availability-copy",
      "traces-copy",
    ]);
    expect(mapped.dashboards[0].widgets[0].queryRef).toEqual({
      ...dashboard.widgets[0].queryRef,
      id: "availability-copy",
    });
    expect(
      mapped.dashboards[0].widgets[0].options?.tooltipView?.source,
    ).toEqual({
      type: "saved",
      ref: {
        id: "traces-copy",
        bindings: [{ parameter: "service", source: "label", label: "service" }],
      },
    });
    expect(bundle).toEqual(buildDashboardBundle([dashboard], [shared, child]));
    expect(() =>
      remapBundleQueryReferences(bundle, {
        availability: "same",
        traces: "same",
      }),
    ).toThrow(/Duplicate saved query/);
    expect(() =>
      remapBundleQueryReferences(bundle, { availability: "../unsafe" }),
    ).toThrow();
    expect(
      remapBundleQueryReferences(
        { dashboards: [dashboard] },
        { availability: "availability-copy" },
      ),
    ).not.toHaveProperty("savedQueries");
  });
  it("keeps exactly the selected dashboards' dependency closure for partial retries", () => {
    const another: Dashboard = {
      ...dashboard,
      id: "other",
      widgets: [{ ...dashboard.widgets[0], options: undefined }],
    };
    const bundle = buildDashboardBundle([dashboard, another], [shared, child]);
    expect(selectBundleDashboards(bundle, ["other"])).toEqual({
      dashboards: [another],
      savedQueries: [shared],
    });
    expect(
      selectBundleDashboards(bundle, ["other", "overview"]).dashboards,
    ).toEqual([dashboard, another]);
    expect(
      selectBundleDashboards({ dashboards: [dashboard] }, [dashboard.id]),
    ).not.toHaveProperty("savedQueries");
    expect(() => selectBundleDashboards(bundle, ["missing"])).toThrow(
      /not in this bundle/,
    );
    expect(() => selectBundleDashboards(bundle, ["other", "other"])).toThrow(
      /once/,
    );
    expect(() => selectBundleDashboards(bundle, [])).toThrow(/1 and 100/);
  });
});
