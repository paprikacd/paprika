import { act, cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef } from "react";
import { AttentionStoreProvider, useAttentionPublisher, type WidgetAttentionPublication } from "./attention-store";
import { AttentionStrip, announcementFor, formatAge, summarizeAttention } from "./attention-strip";
import type { AttentionFacts } from "./widget-attention";

afterEach(() => { cleanup(); vi.useRealTimers(); });

type Fixture = { cases: { name: string; widgets: ({ id: string } & AttentionFacts)[]; expected: { widgets: number; checked: number; critical: number; warning: number; failed: number; stale: number; attention: Record<string, string> } }[] };
// The strip counts with the same rule and the same shared cases the Go reducer runs (docs/design/insights/conformance).
const fixture: Fixture = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/design/insights/conformance/attention.json"), "utf8"));

const ok: AttentionFacts = { failure: "none", signal: "ok", threshold: null, breaches: null, freshness: "no_threshold" };
const critical: AttentionFacts = { ...ok, threshold: { state: "matched", status: "critical" } };
const warning: AttentionFacts = { ...ok, threshold: { state: "matched", status: "warning" } };
const failed: AttentionFacts = { failure: "provider", signal: "error", threshold: null, breaches: null, freshness: null };

describe("strip counting follows the shared attention cases", () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const ids = testCase.widgets.map((widget) => widget.id);
      const entries = testCase.widgets.map(({ id, ...facts }) => ({ widgetId: id, title: id, facts, mounted: true }));
      const summary = summarizeAttention(ids, entries);
      expect({ widgets: summary.widgets, checked: summary.checked, ...summary.counts }).toEqual({
        widgets: testCase.expected.widgets, checked: testCase.expected.checked, critical: testCase.expected.critical,
        warning: testCase.expected.warning, failed: testCase.expected.failed, stale: testCase.expected.stale,
      });
      for (const [id, reason] of Object.entries(testCase.expected.attention)) expect(summary.listed[reason as "critical"]).toContain(id);
    });
  }

  it("counts a listed widget with no published facts as unchecked, and ignores entries the dashboard does not list", () => {
    const summary = summarizeAttention(["a", "b"], [
      { widgetId: "a", title: "A", facts: ok, mounted: true },
      { widgetId: "gone", title: "Gone", facts: critical, mounted: true },
    ]);
    expect(summary).toMatchObject({ widgets: 2, checked: 1, counts: { critical: 0, warning: 0, failed: 0, stale: 0 } });
  });

  it("lists each reason's widgets in dashboard order and reports the newest settle time", () => {
    const summary = summarizeAttention(["x", "y", "z"], [
      { widgetId: "z", title: "Z", facts: critical, completedAt: 100, mounted: true },
      { widgetId: "x", title: "X", facts: critical, completedAt: 300, mounted: true },
      { widgetId: "y", title: "Y", facts: failed, completedAt: 200, mounted: false },
    ]);
    expect(summary.listed.critical).toEqual(["x", "z"]);
    expect(summary.listed.failed).toEqual(["y"]);
    expect(summary.completedAt).toBe(300);
    expect(summary.lastKnown).toBe(1);
  });
});

describe("plain-word helpers", () => {
  it("ages in seconds, minutes, hours and days", () => {
    expect([0, 999, 12_000, 59_999, 60_000, 11 * 60_000, 3 * 3_600_000, 3 * 86_400_000].map(formatAge)).toEqual(
      ["just now", "just now", "12 s ago", "59 s ago", "1 min ago", "11 min ago", "3 h ago", "3 d ago"],
    );
  });

  it("announces only the problem counts, and says so when none", () => {
    expect(announcementFor({ critical: 2, warning: 0, failed: 1, stale: 0 })).toBe("2 critical, 1 failed.");
    expect(announcementFor({ critical: 0, warning: 0, failed: 0, stale: 0 })).toBe("No attention needed.");
  });
});

/** Publishes what a test scripts, so the strip can be exercised without a canvas. */
function Publisher({ onReady }: { onReady: (publish: (entry: WidgetAttentionPublication) => void) => void }) {
  const store = useAttentionPublisher();
  const ready = useRef(false);
  useEffect(() => { if (!ready.current) { ready.current = true; onReady((entry) => store.publish(entry)); } }, [store, onReady]);
  return null;
}

function renderStrip(ids: string[] = ["a", "b"]) {
  const publish: { current?: (entry: WidgetAttentionPublication) => void } = {};
  const scope = { current: null };
  const view = render(
    <AttentionStoreProvider>
      <Publisher onReady={(next) => { publish.current = next; }} />
      <AttentionStrip widgets={ids.map((id) => ({ id }))} scopeRef={scope} autoRefresh={{ mode: "off" }} />
    </AttentionStoreProvider>,
  );
  const live = () => view.container.querySelector<HTMLElement>('[aria-live="polite"]')!;
  return { view, live, publish: (entry: WidgetAttentionPublication) => act(() => publish.current!(entry)) };
}

describe("live region", () => {
  it("announces a settled change once, after a short delay, and never the refresh ticks", () => {
    vi.useFakeTimers();
    const { live, publish, view } = renderStrip();
    expect(live().textContent).toBe("");
    publish({ widgetId: "a", title: "A", facts: critical, completedAt: Date.now() });
    expect(live().textContent).toBe("");
    act(() => vi.advanceTimersByTime(1000));
    expect(live().textContent).toBe("1 critical.");
    // A refresh that keeps the same verdict moves the age, not the announcement.
    publish({ widgetId: "a", title: "A", facts: critical, completedAt: Date.now() + 5000 });
    act(() => vi.advanceTimersByTime(20_000));
    expect(live().textContent).toBe("1 critical.");
    expect(view.container.querySelector("[data-attention-strip]")).toBeTruthy();
  });

  it("does not announce a flicker that settles back before the delay", () => {
    vi.useFakeTimers();
    const { live, publish } = renderStrip();
    publish({ widgetId: "a", title: "A", facts: critical });
    act(() => vi.advanceTimersByTime(1000));
    expect(live().textContent).toBe("1 critical.");
    publish({ widgetId: "a", title: "A", facts: warning });
    act(() => vi.advanceTimersByTime(500));
    publish({ widgetId: "a", title: "A", facts: critical });
    act(() => vi.advanceTimersByTime(1500));
    expect(live().textContent).toBe("1 critical.");
  });

  it("speaks a new state once its counts have held for the delay", () => {
    vi.useFakeTimers();
    const { live, publish } = renderStrip();
    publish({ widgetId: "a", title: "A", facts: warning });
    publish({ widgetId: "b", title: "B", facts: failed });
    act(() => vi.advanceTimersByTime(500));
    expect(live().textContent).toBe("");
    act(() => vi.advanceTimersByTime(600));
    expect(live().textContent).toBe("1 warning, 1 failed.");
  });
});

describe("strip anatomy", () => {
  it("keeps one region and one reserved element through state changes", () => {
    const { view, publish } = renderStrip();
    const strip = view.container.querySelector("[data-attention-strip]");
    expect(screen.getByRole("region", { name: "Dashboard attention" })).toBe(strip);
    publish({ widgetId: "a", title: "A", facts: critical });
    publish({ widgetId: "b", title: "B", facts: ok });
    expect(view.container.querySelector("[data-attention-strip]")).toBe(strip);
    expect(within(strip as HTMLElement).getByRole("button", { name: /1 critical/ })).toBeInTheDocument();
    // A matched critical band still has an ok signal, so the widget is checked (the shared rule).
    expect(screen.getByText("2/2 checked")).toBeInTheDocument();
  });

  it("names the ready state in plain words, and waits for a first result before any age", () => {
    const { publish } = renderStrip();
    expect(screen.getByText("No attention needed")).toBeInTheDocument();
    expect(screen.getByText("Waiting for first results")).toBeInTheDocument();
    publish({ widgetId: "a", title: "A", facts: ok, completedAt: Date.now() });
    publish({ widgetId: "b", title: "B", facts: ok, completedAt: Date.now() });
    expect(screen.getByText("Updated just now")).toBeInTheDocument();
    expect(screen.getByText("2/2 checked")).toBeInTheDocument();
  });

  it("uses the status glyph and words, never colour alone, and never says health", () => {
    const { view, publish } = renderStrip();
    publish({ widgetId: "a", title: "A", facts: critical });
    publish({ widgetId: "b", title: "B", facts: failed });
    expect(view.container.querySelector('[data-reason="critical"] [data-status="critical"]')).toHaveTextContent("1 critical");
    expect(view.container.querySelector('[data-reason="failed"] [data-status="unknown"]')).toHaveTextContent("1 failed");
    expect(view.container.textContent?.toLowerCase()).not.toContain("health");
  });
});
