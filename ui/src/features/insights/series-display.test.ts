import { describe, expect, it } from "vitest";
import { compactSeriesLabels, displaySeriesNames } from "./series-display";
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

function plain(name: string, labels: Record<string, string> = {}): Series {
  return { name, labels, points: [] };
}

describe("display series names", () => {
  it("names a lone fallback series after the widget's authored title", () => {
    expect(displaySeriesNames([plain("Value")], "Error budget burn rate")).toEqual(["Error budget burn rate"]);
    expect(displaySeriesNames([plain("Series 3")], "Queue depth")).toEqual(["Queue depth"]);
    expect(displaySeriesNames([prometheus({ cluster: "omega", node: "node-0" })], "Selected node · CPU")).toEqual(["Selected node · CPU"]);
  });
  it("keeps a real lone name, and a fallback when the title is blank", () => {
    expect(displaySeriesNames([plain("Checkout")], "Latency")).toEqual(["Checkout"]);
    expect(displaySeriesNames([plain("Value")], "  ")).toEqual(["Value"]);
    expect(displaySeriesNames([plain("Value")])).toEqual(["Value"]);
    expect(displaySeriesNames([plain("Technology · short_interest")], "Market Lens")).toEqual(["Technology · short_interest"]);
  });
  it("does not rename several fallback series with their numbers", () => {
    expect(displaySeriesNames([plain("Series 1"), plain("Series 2")], "Queue")).toEqual(["Series 1", "Series 2"]);
  });
  it("strips a shared suffix from every name", () => {
    const series = ["Technology · short_interest", "Energy · short_interest", "Materials · short_interest"].map(name => plain(name));
    expect(displaySeriesNames(series, "Market Lens")).toEqual(["Technology", "Energy", "Materials"]);
  });
  it("strips a shared prefix only at a separator", () => {
    expect(displaySeriesNames([plain("cpu_usage"), plain("cpu_load")], "")).toEqual(["usage", "load"]);
    expect(displaySeriesNames([plain("sales_interest"), plain("rates_interest")], "")).toEqual(["sales", "rates"]);
    expect(displaySeriesNames([plain("Alpha"), plain("Alpine")], "")).toEqual(["Alpha", "Alpine"]);
  });
  it("leaves names alone when a partial overlap leaves no shared affix", () => {
    expect(displaySeriesNames([plain("cpu_usage"), plain("cpu_load"), plain("mem")], "")).toEqual(["cpu_usage", "cpu_load", "mem"]);
  });
  it("leaves names alone when stripping would make them identical", () => {
    expect(displaySeriesNames([plain("Bank · high"), plain("Bank · high ")], "")).toEqual(["Bank · high", "Bank · high "]);
  });
  it("leaves names alone when stripping would leave an empty name", () => {
    expect(displaySeriesNames([plain("a · s"), plain("b · s"), plain(" · s")], "")).toEqual(["a · s", "b · s", " · s"]);
  });
  it("keeps compacted label fields rather than stripping their shared key", () => {
    const series = [
      prometheus({ cluster: "omega", pod: "api-17", container: "app" }),
      prometheus({ cluster: "omega", pod: "api-17", container: "proxy" }),
      prometheus({ cluster: "omega", pod: "worker-8", container: "app" }),
    ];
    expect(displaySeriesNames(series, "Pods")).toEqual(["pod=api-17 · container=app", "pod=api-17 · container=proxy", "pod=worker-8 · container=app"]);
  });
  it("never mutates the full series names", () => {
    const series = [plain("Technology · short_interest"), plain("Energy · short_interest")];
    displaySeriesNames(series, "Market Lens");
    expect(series.map(entry => entry.name)).toEqual(["Technology · short_interest", "Energy · short_interest"]);
  });
});
