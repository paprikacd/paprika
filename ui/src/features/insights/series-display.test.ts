import { describe, expect, it } from "vitest";
import { EXPLORER_PREVIEW_WIDGET_ID, compactSeriesLabels, displaySeriesNames, fallbackIdentityTitle } from "./series-display";
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
const names = (values: string[]) => values.map(value => plain(value));
const widget = (title: string, id = "dashboard-widget") => ({ id, title });

describe("fallback identity for a lone series", () => {
  it("names a lone generic series after the authored dashboard title", () => {
    expect(fallbackIdentityTitle(widget("Error budget burn rate · 1h"), names(["Value"]))).toBe("Error budget burn rate · 1h");
    expect(fallbackIdentityTitle(widget("Queue depth"), names(["Series 3"]))).toBe("Queue depth");
    expect(fallbackIdentityTitle(widget("Selected node · CPU"), [prometheus({ cluster: "omega", node: "node-0" })])).toBe("Selected node · CPU");
  });
  it("keeps real names, blank titles and several series unidentified", () => {
    expect(fallbackIdentityTitle(widget("Latency"), names(["Checkout"]))).toBeUndefined();
    expect(fallbackIdentityTitle(widget("  "), names(["Value"]))).toBeUndefined();
    expect(fallbackIdentityTitle(widget("Latency"), names(["Value", "Value 2"]))).toBeUndefined();
    expect(fallbackIdentityTitle(widget("Queue"), names(["Series 1", "Series 2"]))).toBeUndefined();
  });
  it("never applies to explorer previews, which are identified by their selector", () => {
    const selector = [prometheus({ __name__: "up", instance: "api-1:9090", job: "api" })];
    expect(fallbackIdentityTitle({ id: EXPLORER_PREVIEW_WIDGET_ID, title: "Query results" }, selector)).toBeUndefined();
    expect(fallbackIdentityTitle({ id: EXPLORER_PREVIEW_WIDGET_ID, title: "Query results" }, names(["Value"]))).toBeUndefined();
  });
});

describe("display series names", () => {
  it("keeps a lone series name as written", () => {
    expect(displaySeriesNames(names(["Value"]))).toEqual(["Value"]);
    expect(displaySeriesNames(names(["Technology · short_interest"]))).toEqual(["Technology · short_interest"]);
  });
  it("does not rename several fallback series with their numbers", () => {
    expect(displaySeriesNames(names(["Series 1", "Series 2"]))).toEqual(["Series 1", "Series 2"]);
  });
  it("drops a trailing segment every name shares (Market Lens)", () => {
    expect(displaySeriesNames(names(["Technology · short_interest", "Energy · short_interest", "Materials · short_interest"])))
      .toEqual(["Technology", "Energy", "Materials"]);
  });
  it("drops a leading segment every name shares, and keeps the rest of each name", () => {
    expect(displaySeriesNames(names(["Sales · Technology · 2026", "Sales · Energy · 2026"]))).toEqual(["Technology", "Energy"]);
    expect(displaySeriesNames(names(["Bank · high", "Bank · low"]))).toEqual(["high", "low"]);
    expect(displaySeriesNames(names(["0.5 · latency", "0.9 · latency", "0.99 · latency"]))).toEqual(["0.5", "0.9", "0.99"]);
    expect(displaySeriesNames(names(["🇦🇺 · revenue", "🇳🇿 · revenue"]))).toEqual(["🇦🇺", "🇳🇿"]);
  });
  it("never cuts inside a segment: decimals, addresses, signs, hostnames, versions", () => {
    expect(displaySeriesNames(names(["0.5", "0.9", "0.99"]))).toEqual(["0.5", "0.9", "0.99"]);
    expect(displaySeriesNames(names(["10.0.0.1", "10.0.0.2"]))).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(displaySeriesNames(names(["10.0.0.1/.2", "10.0.0.1/.3"]))).toEqual(["10.0.0.1/.2", "10.0.0.1/.3"]);
    expect(displaySeriesNames(names(["-1d", "-7d"]))).toEqual(["-1d", "-7d"]);
    expect(displaySeriesNames(names(["+5", "-5"]))).toEqual(["+5", "-5"]);
    expect(displaySeriesNames(names(["web-1.example.com", "web-2.example.com"]))).toEqual(["web-1.example.com", "web-2.example.com"]);
    expect(displaySeriesNames(names(["v1.2.3", "v1.2.4"]))).toEqual(["v1.2.3", "v1.2.4"]);
    expect(displaySeriesNames(names(["web-1/2/3", "web-1/2/4"]))).toEqual(["web-1/2/3", "web-1/2/4"]);
  });
  it("leaves emoji, flags and combining marks intact", () => {
    expect(displaySeriesNames(names(["🟢 healthy", "🔴 down"]))).toEqual(["🟢 healthy", "🔴 down"]);
    expect(displaySeriesNames(names(["🇦🇺", "🇳🇿"]))).toEqual(["🇦🇺", "🇳🇿"]);
    expect(displaySeriesNames(names(["cafe\u0301", "the\u0301"]))).toEqual(["cafe\u0301", "the\u0301"]);
  });
  it("leaves the shipped Household buying power names unchanged", () => {
    expect(displaySeriesNames(names(["debt_to_income", "price_to_income"]))).toEqual(["debt_to_income", "price_to_income"]);
  });
  it("leaves names alone when no segment is shared", () => {
    expect(displaySeriesNames(names(["cpu · a", "mem · b"]))).toEqual(["cpu · a", "mem · b"]);
  });
  it("leaves names alone when a cut would make them identical", () => {
    expect(displaySeriesNames(names(["Bank · high", "Bank · high "]))).toEqual(["Bank · high", "Bank · high "]);
  });
  it("leaves names alone when a cut would leave an empty name", () => {
    expect(displaySeriesNames(names(["a · s", "b · s", " · s"]))).toEqual(["a · s", "b · s", " · s"]);
  });
  it("keeps compacted label fields rather than stripping their shared key", () => {
    const series = [
      prometheus({ cluster: "omega", pod: "api-17", container: "app" }),
      prometheus({ cluster: "omega", pod: "api-17", container: "proxy" }),
      prometheus({ cluster: "omega", pod: "worker-8", container: "app" }),
    ];
    expect(displaySeriesNames(series)).toEqual(["pod=api-17 · container=app", "pod=api-17 · container=proxy", "pod=worker-8 · container=app"]);
  });
  it("never mutates the full series names", () => {
    const series = names(["Technology · short_interest", "Energy · short_interest"]);
    displaySeriesNames(series);
    expect(series.map(entry => entry.name)).toEqual(["Technology · short_interest", "Energy · short_interest"]);
  });
});
