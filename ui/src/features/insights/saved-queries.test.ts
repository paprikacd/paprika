import { describe, expect, it } from "vitest";
import {
  dashboardUsesSavedQuery,
  resolveSavedQueryReference,
  resolveSavedQueryTemplate,
  savedQueryParameterValue,
  validateSavedQueryTemplate,
} from "./saved-queries";
import type {
  Dashboard,
  SavedQuery,
  SavedQueryReference,
  SavedQueryEntry,
} from "./schema";

const saved: SavedQuery = {
  schemaVersion: 1,
  id: "requests",
  name: "Requests",
  providerId: "prom",
  kind: "metrics",
  query: "requests{service={{service}}} > {{minimum}}",
  parameters: [
    { name: "service", type: "string" },
    { name: "minimum", type: "number", defaultValue: 0 },
  ],
};
const ref: SavedQueryReference = {
  id: saved.id,
  bindings: [
    { parameter: "service", source: "variable", variable: "application" },
  ],
};

describe("typed saved-query parameters", () => {
  it("resolves required values, typed defaults, empty strings and explicit zero without changing the document", () => {
    const original = structuredClone(saved);
    expect(resolveSavedQueryTemplate(saved, { service: "api" })).toBe(
      'requests{service="api"} > 0',
    );
    expect(
      resolveSavedQueryTemplate(saved, { service: "", minimum: "-7.25e2" }),
    ).toBe('requests{service=""} > -725');
    expect(
      resolveSavedQueryTemplate(
        {
          ...saved,
          parameters: [
            { name: "service", type: "string", defaultValue: "default" },
            { name: "minimum", type: "number", defaultValue: 9 },
          ],
        },
        { service: "", minimum: 0 },
      ),
    ).toBe('requests{service=""} > 0');
    expect(saved).toEqual(original);
    expect(() => resolveSavedQueryTemplate(saved, {})).toThrow(/service/);
    expect(() =>
      resolveSavedQueryTemplate(saved, { service: "api", unknown: 1 }),
    ).toThrow(/no parameter.*unknown/);
  });

  it.each([
    "",
    " ",
    "+1",
    "01",
    "0x10",
    "1_000",
    "1 or vector(1)",
    "1; up",
    "1e999",
    "Infinity",
    "NaN",
    "1ms",
    "{{injection}}",
    "1\n",
    Infinity,
    NaN,
    null,
    false,
    {},
  ])("rejects nonnumeric input instead of coercing it: %j", (value) => {
    expect(() =>
      savedQueryParameterValue(
        { name: "minimum", type: "number" },
        value as string | number,
      ),
    ).toThrow(/finite number/);
  });
  it("keeps string and number parameter types distinct and bounded", () => {
    expect(() =>
      savedQueryParameterValue({ name: "service", type: "string" }, 7),
    ).toThrow(/text/);
    expect(
      savedQueryParameterValue({ name: "service", type: "string" }, "7"),
    ).toBe("7");
    expect(() =>
      resolveSavedQueryTemplate(saved, { service: "x".repeat(1025) }),
    ).toThrow(/1,024/);
    expect(() =>
      resolveSavedQueryTemplate(
        {
          ...saved,
          parameters: [{ name: "service", type: "string", defaultValue: 3 }],
        },
        {},
      ),
    ).toThrow();
  });
  it.each([
    'requests{service="{{service}}"}',
    "metric_{{service}}",
    "# {{service}}\nup",
    "/* {{service}} */ up",
    "requests{service={{missing}}}",
    "requests{service={{service}",
  ])("rejects unsafe or incomplete template placement: %s", (query) => {
    expect(() => validateSavedQueryTemplate({ ...saved, query })).toThrow();
  });
  it("validates a legal 8192-character template without dummy-value expansion, but bounds actual resolved text", () => {
    const prefix = "metric{label=";
    const suffix = "} #";
    const template =
      prefix +
      "{{x}}" +
      suffix +
      "a".repeat(8192 - prefix.length - 5 - suffix.length);
    const query: SavedQuery = {
      ...saved,
      query: template,
      parameters: [{ name: "x", type: "string" }],
    };
    expect(query.query).toHaveLength(8192);
    expect(() => validateSavedQueryTemplate(query)).not.toThrow();
    expect(
      resolveSavedQueryTemplate(query, { x: "" }).length,
    ).toBeLessThanOrEqual(8192);
    expect(() => resolveSavedQueryTemplate(query, { x: "long-value" })).toThrow(
      /exceeds 8192/,
    );
  });

  it("validates templates without requiring runtime values and rejects duplicate parameter declarations", () => {
    expect(() => validateSavedQueryTemplate(saved)).not.toThrow();
    expect(() =>
      validateSavedQueryTemplate({
        ...saved,
        parameters: [...saved.parameters!, saved.parameters![0]],
      }),
    ).toThrow(/unique/);
  });
});

describe("saved references and exact observation binding", () => {
  it("accepts library ETag metadata without mutating entries or relaxing unknown document fields", () => {
    const entry: SavedQueryEntry = { ...saved, etag: '"revision-42"' };
    const original = structuredClone(entry);
    expect(
      resolveSavedQueryReference(
        ref,
        [entry],
        { application: "api" },
        "metrics",
      ).query,
    ).toBe('requests{service="api"} > 0');
    expect(resolveSavedQueryTemplate(entry, { service: "api" })).toBe(
      'requests{service="api"} > 0',
    );
    expect(() => validateSavedQueryTemplate(entry)).not.toThrow();
    expect(entry).toEqual(original);
    expect(() =>
      resolveSavedQueryTemplate(
        { ...entry, unknown: true } as SavedQueryEntry,
        { service: "api" },
      ),
    ).toThrow(/Unrecognized key/);
  });
  it("resolves the saved provider and query without using a custom draft", () => {
    expect(
      resolveSavedQueryReference(
        ref,
        [saved],
        { application: "api" },
        "metrics",
      ),
    ).toEqual({
      providerId: "prom",
      kind: "metrics",
      query: 'requests{service="api"} > 0',
    });
    expect(() =>
      resolveSavedQueryReference(ref, [], { application: "api" }, "metrics"),
    ).toThrow(/unavailable/);
    expect(() =>
      resolveSavedQueryReference(ref, [saved], {}, "metrics"),
    ).toThrow(/dashboard variable.*application/);
    expect(() =>
      resolveSavedQueryReference(
        ref,
        [saved],
        { application: "api" },
        "traces",
      ),
    ).toThrow(/does not provide traces/);
    expect(() =>
      resolveSavedQueryReference(
        ref,
        [saved],
        Object.create({ application: "inherited" }) as Record<string, string>,
        "metrics",
      ),
    ).toThrow(/dashboard variable/);
  });
  it("rejects duplicate and unknown bindings instead of letting order select an arbitrary value", () => {
    expect(() =>
      resolveSavedQueryReference(
        { ...ref, bindings: [...ref.bindings!, ...ref.bindings!] },
        [saved],
        { application: "api" },
        "metrics",
      ),
    ).toThrow(/once/);
    expect(() =>
      resolveSavedQueryReference(
        {
          ...ref,
          bindings: [
            ...ref.bindings!,
            { parameter: "unknown", source: "constant", value: "x" },
          ],
        },
        [saved],
        { application: "api" },
        "metrics",
      ),
    ).toThrow(/no parameter.*unknown/);
  });
  it("interpolates labels, dashboard values and constants once, preserving quotes, slashes, newlines and literal braces", () => {
    const value = 'checkout"blue\\west\n{{text}}';
    const query: SavedQuery = {
      ...saved,
      query:
        "requests{service={{service}},environment={{environment}},region={{region}}}",
      parameters: [
        { name: "service", type: "string" },
        { name: "environment", type: "string" },
        { name: "region", type: "string" },
      ],
    };
    const reference: SavedQueryReference = {
      id: saved.id,
      bindings: [
        { parameter: "service", source: "label", label: "service" },
        {
          parameter: "environment",
          source: "variable",
          variable: "environment",
        },
        { parameter: "region", source: "constant", value },
      ],
    };
    expect(
      resolveSavedQueryReference(
        reference,
        [query],
        { environment: value },
        "metrics",
        { series: { name: "api", labels: { service: value }, points: [] } },
      ).query,
    ).toBe(
      `requests{service=${JSON.stringify(value)},environment=${JSON.stringify(value)},region=${JSON.stringify(value)}}`,
    );
  });
  it("uses the exact historical value and millisecond observation time, including zero, negative values and fallback series names", () => {
    const query: SavedQuery = {
      ...saved,
      query: "requests{series={{series}}} @ {{time}} > {{value}}",
      parameters: [
        { name: "series", type: "string" },
        { name: "time", type: "number" },
        { name: "value", type: "number" },
      ],
    };
    const reference: SavedQueryReference = {
      id: saved.id,
      bindings: [
        { parameter: "series", source: "field", field: "series" },
        { parameter: "time", source: "field", field: "timestamp" },
        { parameter: "value", source: "field", field: "value" },
      ],
    };
    const series = {
      name: "",
      labels: {},
      points: [{ timestamp: 9999999, value: 999 }],
    };
    expect(
      resolveSavedQueryReference(reference, [query], {}, "metrics", {
        series,
        seriesIndex: 1,
        point: { timestamp: 1234567, value: -7.25 },
      }).query,
    ).toBe('requests{series="Series 2"} @ 1234.567 > -7.25');
    expect(
      resolveSavedQueryReference(reference, [query], {}, "metrics", {
        series,
        point: { timestamp: 0, value: 0 },
      }).query,
    ).toBe('requests{series="Series 1"} @ 0 > 0');
    expect(() =>
      resolveSavedQueryReference(reference, [query], {}, "metrics", { series }),
    ).toThrow(/timestamp/);
    expect(() =>
      resolveSavedQueryReference(reference, [query], {}, "metrics", {
        series,
        point: { timestamp: 1e100, value: 1 },
      }),
    ).toThrow(/timestamp/);
    expect(() =>
      resolveSavedQueryReference(reference, [query], {}, "metrics", {
        series,
        point: { timestamp: 1000, value: null },
      }),
    ).toThrow(/finite value/);
    expect(() =>
      resolveSavedQueryReference(reference, [query], {}, "metrics"),
    ).toThrow(/hovered observation/);
  });
  it("never substitutes a missing or inherited label with a default", () => {
    const reference: SavedQueryReference = {
      id: saved.id,
      bindings: [{ parameter: "service", source: "label", label: "service" }],
    };
    for (const labels of [
      {},
      Object.create({ service: "inherited" }) as Record<string, string>,
    ])
      expect(() =>
        resolveSavedQueryReference(reference, [saved], {}, "metrics", {
          series: { name: "api", labels, points: [] },
        }),
      ).toThrow(/no label/);
    expect(
      resolveSavedQueryReference(reference, [saved], {}, "metrics", {
        series: { name: "api", labels: { service: "" }, points: [] },
      }).query,
    ).toBe('requests{service=""} > 0');
  });
  it("detects direct and tooltip references even when tooltips are temporarily hidden", () => {
    const dashboard: Dashboard = {
      schemaVersion: 1,
      id: "overview",
      title: "Overview",
      timeRange: "1h",
      refreshInterval: 0,
      widgets: [
        {
          id: "metric",
          title: "Metric",
          type: "heatmap",
          providerId: "prom",
          query: "up",
          unit: "",
          layout: { x: 0, y: 0, w: 6, h: 4 },
          queryRef: { id: "parent" },
          options: {
            showTooltip: false,
            tooltipView: {
              type: "stat",
              source: { type: "saved", ref: { id: "child" } },
            },
          },
        },
      ],
    };
    expect(dashboardUsesSavedQuery(dashboard, "parent")).toBe(true);
    expect(dashboardUsesSavedQuery(dashboard, "child")).toBe(true);
    expect(dashboardUsesSavedQuery(dashboard, "other")).toBe(false);
  });
});
