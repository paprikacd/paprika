import { describe, expect, it } from "vitest";
import { compactSeriesLabels } from "./series-display";
import type { Series } from "./chart-data";

function prometheus(labels: Record<string, string>): Series {
  const fields = Object.entries(labels).filter(([key]) => key !== "__name__").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { name: (labels.__name__ ?? "") + (fields.length ? `{${fields.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")}}` : ""), labels, points: [] };
}

describe("compact visual series labels", () => {
  it("exposes the differentiating namespace instead of the repeated label-set prefix", () => {
    const series = ["paprika", "telesis", "shorted"].map(namespace => prometheus({ cluster: "omega", namespace }));
    expect(compactSeriesLabels(series)).toEqual(["paprika", "telesis", "shorted"]);
    expect(series[0].name).toBe('{cluster="omega", namespace="paprika"}');
  });
  it("adds a second label when pod alone cannot distinguish containers", () => {
    const series = [
      prometheus({ cluster: "omega", pod: "api-17", container: "app" }),
      prometheus({ cluster: "omega", pod: "api-17", container: "proxy" }),
      prometheus({ cluster: "omega", pod: "worker-8", container: "app" }),
    ];
    expect(compactSeriesLabels(series)).toEqual(["pod=api-17 · container=app", "pod=api-17 · container=proxy", "pod=worker-8 · container=app"]);
  });
  it("chooses a shorter equally distinguishing label for narrow cards", () => {
    const series = [1, 2].map(n => prometheus({ cluster: "omega", node: `node-0${n}`, pod: `sample-worker-node-0${n}` }));
    expect(compactSeriesLabels(series)).toEqual(["node-01", "node-02"]);
  });
  it("retains authored names and avoids collisions with them", () => {
    const raw = prometheus({ pod: "api" });
    const authored: Series = { name: "api", labels: { pod: "other" }, points: [] };
    expect(compactSeriesLabels([raw, authored])).toEqual([raw.name, "api"]);
    expect(compactSeriesLabels([{ ...raw, name: "Checkout" }])).toEqual(["Checkout"]);
    expect(compactSeriesLabels([prometheus({ service: "payments", status: "200", region: "au" })])).toEqual(['{region="au", service="payments", status="200"}']);
  });
  it("retains the varying metric identity and handles missing or duplicate labels honestly", () => {
    const cpu = prometheus({ __name__: "cpu", node: "a" }), memory = prometheus({ __name__: "memory", node: "b" });
    expect(compactSeriesLabels([cpu, memory])).toEqual(["cpu · a", "memory · b"]);
    const missing = prometheus({ namespace: "prod" }), present = prometheus({ namespace: "prod", pod: "api" });
    expect(compactSeriesLabels([missing, present])).toEqual([missing.name, "api"]);
    expect(compactSeriesLabels([cpu, cpu])).toEqual([cpu.name, cpu.name]);
  });
});
