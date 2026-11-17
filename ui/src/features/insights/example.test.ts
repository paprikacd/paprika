import { describe, expect, it } from "vitest";
import { exampleQuery } from "./example";
import { resolveSavedQueryReference } from "./saved-queries";
import type { SavedQuery } from "./schema";

const saved: SavedQuery = {
  schemaVersion: 1,
  id: "service-request-rate",
  name: "Service request rate",
  providerId: "example-prometheus",
  kind: "metrics",
  query: "sum(rate(http_requests_total{service={{service}}}[5m]))",
  parameters: [{ name: "service", type: "string" }],
};
const range = { start: 1_792_500_000, end: 1_792_503_600, step: 30 };
const signal = new AbortController().signal;
function query(expression: string) {
  return exampleQuery({ providerId: "example-prometheus", kind: "metrics", query: expression, ...range }, signal);
}
function hovered(service: string) {
  const request = resolveSavedQueryReference(
    { id: saved.id, bindings: [{ parameter: "service", source: "label", label: "service" }] },
    [saved], {}, "metrics",
    { series: { name: service, labels: { service }, points: [{ timestamp: range.end * 1000, value: 1 }] } },
  );
  return exampleQuery({ ...request, ...range }, signal);
}

describe("example service selector data", () => {
  it("resolves hovered labels to the same service history shown in the traffic graph", async () => {
    const grouped = await query("sum by (service) (rate(http_requests_total[5m]))");
    for (const service of grouped.series!) {
      const scoped = await hovered(service.name!);
      expect(scoped.series).toEqual([service]);
      expect(scoped.series![0].points).toHaveLength(121);
      expect(scoped.series![0].points[0].timestamp).toBe(range.start * 1000);
      expect(scoped.series![0].points.at(-1)!.timestamp).toBe(range.end * 1000);
    }
  });

  it("gives all six heatmap services distinct, finite and positive request histories", async () => {
    const health = await query("up");
    const values: number[] = [];
    for (const service of health.series!) {
      const result = await hovered(service.labels.service);
      expect(result.series).toHaveLength(1);
      expect(result.series![0].labels.service).toBe(service.labels.service);
      expect(result.series![0].points.every(({ value }) => typeof value === "number" && Number.isFinite(value) && value > 0)).toBe(true);
      values.push(result.series![0].points.at(-1)!.value!);
    }
    expect(new Set(values).size).toBe(6);
  });

  it("preserves service availability outages when filtering up", async () => {
    const all = await query("up");
    for (const name of ["repo-server", "worker-west", "auth-service"]) {
      expect((await query(`up{service=${JSON.stringify(name)}}`)).series)
        .toEqual(all.series!.filter((series) => series.labels.service === name));
    }
    expect((await query('up{service="worker-west"}')).series![0].points.at(-1)!.value).toBe(0);
    expect((await query('up{service="repo-server"}')).series![0].points[30].value).toBe(0);
  });

  it.each(["missing-service", "", 'api-gateway"} or up{service="repo-server', "api-gateway\\prod\n{{service}}"])(
    "does not fall back to unscoped data for an unknown or escaped hovered label %j",
    async (service) => {
      expect((await hovered(service)).series).toEqual([]);
      expect((await query(`up{service=${JSON.stringify(service)}}`)).series).toEqual([]);
    },
  );

  it("decodes quoted matcher escapes and handles additional labels and spacing", async () => {
    expect((await query('sum(rate(http_requests_total{job="paprika", service = "api\\u002dgateway"}[5m]))')).series)
      .toEqual((await hovered("api-gateway")).series);
  });

  it("does not interpret another label's quoted data or a comment as a service selector", async () => {
    const text = 'prefix }, service="repo-server" { {{service}}';
    expect((await query(`sum(rate(http_requests_total{note=${JSON.stringify(text)}}[5m])) # service="missing"`)).series)
      .toEqual((await query("sum(rate(http_requests_total[5m]))")).series);
  });

  it("reports unsupported service operators instead of pretending to apply them", async () => {
    await expect(query('up{service=~"api.*"}')).rejects.toThrow(/exact matches/);
  });

  it("keeps cancellation and traces independent of the sample metric selector reader", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(exampleQuery({ providerId: "example-prometheus", kind: "metrics", query: "up", ...range }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const traces = await exampleQuery({ providerId: "example-tempo", kind: "traces", query: '{service.name="api-gateway"}', ...range }, signal);
    expect(traces.traces).toHaveLength(4);
  });
});
