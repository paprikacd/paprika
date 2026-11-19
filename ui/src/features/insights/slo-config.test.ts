// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { effectiveWidgetRequest } from "./query";
import { widgetSchema, type Widget } from "./schema";
import { parseSloConfig, sloSummaryConfigSchema } from "./slo-config";
import { compileSloQuery, sloStep, validateSloConfig } from "./slo";

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/design/insights/conformance/slo.json");
const fixture: { cases: { name: string; kind: string; config?: unknown; expected: { error?: string | null; query?: string } }[] } =
  JSON.parse(readFileSync(fixturePath, "utf8"));

const objective = { objective: 99.9, period: "30d", total: "http_requests_total{service={{service}}}", bad: 'http_requests_total{code="5xx"}' };

function sloWidget(config: unknown, extra: Record<string, unknown> = {}): Widget {
  return {
    id: "slo", title: "SLO", type: "plugin", pluginId: "slo-summary", dataKind: "metrics", providerId: "prometheus",
    query: "stale text", unit: "%", layout: { x: 0, y: 0, w: 6, h: 4 }, config, ...extra,
  } as Widget;
}

describe("slo-summary Zod config", () => {
  it.each(fixture.cases.filter((testCase) => testCase.kind === "compile").map((testCase) => [testCase.name, testCase] as const))(
    "accepts exactly the configs the UI validator accepts: %s",
    (_, testCase) => {
      expect(sloSummaryConfigSchema.safeParse(testCase.config).success).toBe(validateSloConfig(testCase.config) === undefined);
    },
  );

  it("requires exactly one of bad or good", () => {
    expect(sloSummaryConfigSchema.safeParse({ ...objective, good: 'up{code="2xx"}' }).success).toBe(false);
    expect(sloSummaryConfigSchema.safeParse({ objective: 99.9, period: "30d", total: "up" }).success).toBe(false);
  });

  it("parses a valid objective to its typed config", () => {
    expect(parseSloConfig(objective)).toEqual(objective);
    expect(() => parseSloConfig({ ...objective, objective: 100 })).toThrow();
  });
});

describe("slo-summary widget schema", () => {
  const base = { id: "slo", title: "SLO", type: "plugin", pluginId: "slo-summary", dataKind: "metrics", providerId: "prometheus", query: "up", unit: "%", layout: { x: 0, y: 0, w: 6, h: 4 } };

  it("requires an objective config", () => {
    expect(widgetSchema.safeParse(base).success).toBe(false);
  });

  it("accepts a valid objective and rejects an invalid one", () => {
    expect(widgetSchema.safeParse({ ...base, config: objective }).success).toBe(true);
    expect(widgetSchema.safeParse({ ...base, config: { ...objective, maxRows: 13 } }).success).toBe(false);
  });
});

describe("slo-summary effective request", () => {
  const range = { start: 1_000, end: 4_600, step: 12 };

  it("runs the query compiled from config over one step that spans the range", () => {
    const request = effectiveWidgetRequest(sloWidget(objective), range);
    expect(request.query).toBe(compileSloQuery(parseSloConfig(objective)));
    expect(request.step).toBe(sloStep(range.start, range.end));
    expect(request.step).toBe(3600);
    expect(request.kind).toBe("metrics");
  });

  it("ignores the stored query text", () => {
    expect(effectiveWidgetRequest(sloWidget(objective), range).query).not.toContain("stale text");
  });

  it("sends an empty query when the config does not compile", () => {
    expect(effectiveWidgetRequest(sloWidget({ ...objective, objective: 100 }), range).query).toBe("");
  });

  it("leaves other widgets' query and step untouched", () => {
    const plain = { ...sloWidget(undefined), type: "timeseries", pluginId: undefined, dataKind: undefined } as Widget;
    const request = effectiveWidgetRequest(plain, range);
    expect(request.query).toBe("stale text");
    expect(request.step).toBe(12);
  });
});
