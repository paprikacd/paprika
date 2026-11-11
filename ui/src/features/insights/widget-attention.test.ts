import { describe, expect, it } from "vitest";
import { evaluateWidgetAttention, widgetAttention } from "./widget-attention";
import type { QueryResult, Widget } from "./schema";

const stat = (options?: Widget["options"]) => ({ type: "stat", options }) as Pick<Widget, "type" | "options">;
const sample = (points: { timestamp: number; value: number | null }[]): QueryResult => ({ series: [{ name: "api", labels: {}, points }] });
const thresholds = [
  { value: 0, status: "ok", label: "Healthy" },
  { value: 5, status: "warning", label: "Elevated" },
  { value: 10, status: "critical", label: "Breached" },
] as const;

describe("evaluateWidgetAttention", () => {
  it("reports a warning or critical band from its author-declared status", () => {
    expect(evaluateWidgetAttention(stat({ thresholds: [...thresholds] }), sample([{ timestamp: 1, value: 6 }]), undefined, 2000)).toBe("warning");
    expect(evaluateWidgetAttention(stat({ thresholds: [...thresholds] }), sample([{ timestamp: 1, value: 10 }]), undefined, 2000)).toBe("critical");
  });

  it("names the matched band on the boundary, where the threshold value itself matches", () => {
    const widget = stat({ thresholds: [{ value: 0.1, status: "critical", label: "Over" }] });
    expect(evaluateWidgetAttention(widget, sample([{ timestamp: 1, value: 0.1 }]), undefined, 2000)).toBe("critical");
  });

  it("uses the latest valid sample, not an older breach, and not a missing latest sample", () => {
    const widget = stat({ thresholds: [...thresholds] });
    expect(evaluateWidgetAttention(widget, sample([{ timestamp: 1, value: 12 }, { timestamp: 2, value: 1 }]), undefined, 3000)).toBe("ok");
    expect(evaluateWidgetAttention(widget, sample([{ timestamp: 1, value: 1 }, { timestamp: 2, value: 12 }, { timestamp: 3, value: null }]), undefined, 3000)).toBe("critical");
  });

  it("never raises attention from a colour-only threshold", () => {
    const widget = stat({ thresholds: [{ value: 0, color: "#008866" }, { value: 40, color: "#dd8800", label: "Hot" }] });
    const outcome = widgetAttention(widget, sample([{ timestamp: 1, value: 42 }]), undefined, 2000);
    expect(outcome.state).toBe("ok");
    // The band still comes back, so the renderer can show its dot and label.
    expect(outcome.band).toEqual({ value: 40, color: "#dd8800", label: "Hot" });
  });

  it("never reports an informational or unknown status as attention", () => {
    const widget = stat({ thresholds: [{ value: 0, status: "info" }, { value: 5, status: "unknown" }] });
    expect(evaluateWidgetAttention(widget, sample([{ timestamp: 1, value: 9 }]), undefined, 2000)).toBe("ok");
  });

  it("reports a failed query, and a pending one before its first result", () => {
    expect(evaluateWidgetAttention(stat(), undefined, new Error("boom"), 2000)).toBe("failed");
    expect(evaluateWidgetAttention(stat(), undefined, undefined, 2000)).toBe("pending");
  });

  it("keeps a breach on the last valid sample when a later refresh fails", () => {
    const widget = stat({ thresholds: [...thresholds] });
    expect(evaluateWidgetAttention(widget, sample([{ timestamp: 1, value: 11 }]), "timeout", 2000)).toBe("critical");
  });

  it("reports stale only after the author's staleAfterSeconds, and never without one", () => {
    const aged = sample([{ timestamp: 1_000_000, value: 1 }]);
    expect(evaluateWidgetAttention(stat({ staleAfterSeconds: 300 }), aged, undefined, 1_400_000)).toBe("stale");
    expect(evaluateWidgetAttention(stat({ staleAfterSeconds: 300 }), aged, undefined, 1_300_000)).toBe("ok");
    // No default: an old sample without a declared bound is not stale.
    expect(evaluateWidgetAttention(stat(), aged, undefined, 9_000_000_000)).toBe("ok");
    // Without a range end the age cannot be measured.
    expect(evaluateWidgetAttention(stat({ staleAfterSeconds: 1 }), aged, undefined, undefined)).toBe("ok");
  });

  it("ranks stale below a band breach and above a truncated result", () => {
    const aged = sample([{ timestamp: 1_000_000, value: 11 }]);
    expect(evaluateWidgetAttention(stat({ staleAfterSeconds: 60, thresholds: [...thresholds] }), aged, undefined, 1_400_000)).toBe("critical");
    expect(evaluateWidgetAttention(stat({ staleAfterSeconds: 60 }), { ...aged, truncated: true }, undefined, 1_400_000)).toBe("stale");
  });

  it("reports a truncated result as partial for any widget", () => {
    const widget = { type: "timeseries", options: undefined } as Pick<Widget, "type" | "options">;
    expect(evaluateWidgetAttention(widget, { series: [], truncated: true }, undefined, 2000)).toBe("partial");
    expect(evaluateWidgetAttention(widget, { series: [] }, undefined, 2000)).toBe("ok");
  });

  it("does not band a non-stat widget, whose status belongs to its own renderer", () => {
    const widget = { type: "timeseries", options: { thresholds: [{ value: 0, status: "critical" }] } } as Pick<Widget, "type" | "options">;
    expect(widgetAttention(widget, sample([{ timestamp: 1, value: 5 }]), undefined, 2000)).toMatchObject({ state: "ok", band: undefined });
  });
});
