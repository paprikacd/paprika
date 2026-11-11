import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef } from "react";
import { AttentionStoreProvider, useAttentionPublisher, type WidgetAttentionPublication } from "./attention-store";
import { AttentionStrip, announcementFor, formatAge, refreshLabel, summarizeAttention } from "./attention-strip";
import type { AttentionFacts } from "./widget-attention";

afterEach(() => { cleanup(); vi.useRealTimers(); });

type Fixture = { cases: { name: string; widgets: ({ id: string } & AttentionFacts)[]; expected: { widgets: number; checked: number; critical: number; warning: number; failed: number; stale: number; attention: Record<string, string> } }[] };
// The strip counts with the same rule and the same shared cases the Go reducer runs (docs/design/insights/conformance).
const fixture: Fixture = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/design/insights/conformance/attention.json"), "utf8"));

const ok: AttentionFacts = { failure: "none", signal: "ok", threshold: null, breaches: null, freshness: "no_threshold" };
const critical: AttentionFacts = { ...ok, threshold: { state: "matched", status: "critical" } };
const warning: AttentionFacts = { ...ok, threshold: { state: "matched", status: "warning" } };
const failed: AttentionFacts = { failure: "provider", signal: "error", threshold: null, breaches: null, freshness: null };
const pending: AttentionFacts = { failure: "none", signal: "pending", threshold: null, breaches: null, freshness: null };
const empty: AttentionFacts = { failure: "none", signal: "empty", threshold: null, breaches: null, freshness: "unknown" };

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

  it("counts a listed widget with no published facts as not loaded and unchecked, and ignores entries the dashboard does not list", () => {
    const summary = summarizeAttention(["a", "b", "c"], [
      { widgetId: "a", title: "A", facts: ok, mounted: true },
      { widgetId: "gone", title: "Gone", facts: critical, mounted: true },
    ]);
    expect(summary).toMatchObject({ widgets: 3, checked: 1, notLoaded: 2, counts: { critical: 0, warning: 0, failed: 0, stale: 0 } });
  });

  it("keeps not-loaded apart from failed and empty: a pending tile is not loaded, a failed or empty one is loaded", () => {
    const summary = summarizeAttention(["p", "f", "e"], [
      { widgetId: "p", title: "P", facts: pending, mounted: true },
      { widgetId: "f", title: "F", facts: failed, mounted: true },
      { widgetId: "e", title: "E", facts: empty, mounted: true },
    ]);
    expect(summary).toMatchObject({ notLoaded: 1, checked: 0, counts: { failed: 1 } });
  });

  it("lists each reason's widgets in dashboard order, and dates the loaded results from the oldest settle and the newest sample", () => {
    const summary = summarizeAttention(["x", "y", "z"], [
      { widgetId: "z", title: "Z", facts: critical, completedAt: 100, sampleAt: 900, mounted: true },
      { widgetId: "x", title: "X", facts: critical, completedAt: 300, sampleAt: 700, mounted: true },
      { widgetId: "y", title: "Y", facts: failed, completedAt: 200, mounted: false },
    ]);
    expect(summary.listed.critical).toEqual(["x", "z"]);
    expect(summary.listed.failed).toEqual(["y"]);
    expect(summary.oldestCompletedAt).toBe(100);
    expect(summary.newestSampleAt).toBe(900);
  });
});

describe("plain-word helpers", () => {
  it("ages in seconds, minutes, hours and days", () => {
    expect([0, 999, 12_000, 59_999, 60_000, 11 * 60_000, 3 * 3_600_000, 3 * 86_400_000].map(formatAge)).toEqual(
      ["just now", "just now", "12 s ago", "59 s ago", "1 min ago", "11 min ago", "3 h ago", "3 d ago"],
    );
  });

  it("says the refresh interval the way the toolbar does", () => {
    expect(refreshLabel({ mode: "every", seconds: 15 })).toBe("Refreshes every 15 s");
    expect(refreshLabel({ mode: "every", seconds: 60 })).toBe("Refreshes every 1m");
    expect(refreshLabel({ mode: "every", seconds: 30 })).toBe("Refreshes every 30 s");
    expect(refreshLabel({ mode: "fixed" })).toBe("Paused for a fixed window");
    expect(refreshLabel({ mode: "off" })).toBe("Auto refresh off");
  });

  it("announces only the problem counts, never a calm verdict while tiles are still unloaded", () => {
    expect(announcementFor({ critical: 2, warning: 0, failed: 1, stale: 0 })).toBe("2 critical, 1 failed.");
    expect(announcementFor({ critical: 0, warning: 0, failed: 0, stale: 0 }, 3)).toBe("Nothing flagged so far.");
    expect(announcementFor({ critical: 0, warning: 0, failed: 0, stale: 0 })).toBe("Nothing flagged.");
  });
});

/** Publishes what a test scripts, so the strip can be exercised without a canvas. */
function Publisher({ onReady }: { onReady: (publish: (entry: WidgetAttentionPublication) => void) => void }) {
  const store = useAttentionPublisher();
  const ready = useRef(false);
  useEffect(() => { if (!ready.current) { ready.current = true; onReady((entry) => store.publish(entry)); } }, [store, onReady]);
  return null;
}

function renderStrip(ids: string[] = ["a", "b"], scope: { current: HTMLElement | null } = { current: null }) {
  const publish: { current?: (entry: WidgetAttentionPublication) => void } = {};
  const view = render(
    <AttentionStoreProvider>
      <Publisher onReady={(next) => { publish.current = next; }} />
      <AttentionStrip widgets={ids.map((id) => ({ id }))} scopeRef={scope} autoRefresh={{ mode: "off" }} />
    </AttentionStoreProvider>,
  );
  const live = () => view.container.querySelector<HTMLElement>('[aria-live="polite"][aria-atomic="true"]')!;
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

  it("speaks a new state once its counts have held for the delay, including a dashboard's first results", () => {
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

describe("strip anatomy and copy", () => {
  it("keeps one region and one reserved element through state changes", () => {
    const { view, publish } = renderStrip();
    const strip = view.container.querySelector("[data-attention-strip]");
    expect(screen.getByRole("region", { name: "Dashboard attention" })).toBe(strip);
    publish({ widgetId: "a", title: "A", facts: critical });
    publish({ widgets: undefined, widgetId: "b", title: "B", facts: ok } as WidgetAttentionPublication);
    expect(view.container.querySelector("[data-attention-strip]")).toBe(strip);
    expect(within(strip as HTMLElement).getByRole("button", { name: /^1 critical:/ })).toBeInTheDocument();
    // A matched critical band still has an ok signal, so the widget is checked (the shared rule).
    expect(screen.getByText(/2 of 2 checked/)).toBeInTheDocument();
  });

  it("says nothing is flagged, never that nothing needs attention, and counts what is not loaded yet", () => {
    const { publish } = renderStrip(["a", "b", "c"]);
    expect(screen.getByText("Nothing flagged so far")).toBeInTheDocument();
    expect(screen.getByText(/0 of 3 checked/)).toBeInTheDocument();
    expect(screen.getByText(/3 not loaded yet/)).toBeInTheDocument();
    expect(screen.getByText("Loading results")).toBeInTheDocument();
    expect(screen.queryByText(/No attention needed/)).toBeNull();
    publish({ widgetId: "a", title: "A", facts: ok, completedAt: Date.now() });
    publish({ widgetId: "b", title: "B", facts: ok, completedAt: Date.now() });
    publish({ widgetId: "c", title: "C", facts: ok, completedAt: Date.now() });
    expect(screen.getByText("Nothing flagged")).toBeInTheDocument();
    expect(screen.getByText("Updated just now")).toBeInTheDocument();
  });

  it("uses the status glyph and words, never colour alone, and never says health", () => {
    const { view, publish } = renderStrip();
    publish({ widgetId: "a", title: "A", facts: critical });
    publish({ widgetId: "b", title: "B", facts: failed });
    expect(view.container.querySelector('[data-reason="critical"] [data-status="critical"]')).toHaveTextContent("1 critical");
    expect(view.container.querySelector('[data-reason="failed"] [data-status="unknown"]')).toHaveTextContent("1 failed");
    expect(view.container.textContent?.toLowerCase()).not.toContain("health");
  });

  it("says the newest sample's time and zone once for the dashboard", () => {
    const { publish } = renderStrip();
    const sampleAt = Date.UTC(2026, 10, 12, 18, 51);
    publish({ widgetId: "a", title: "A", facts: ok, completedAt: Date.now(), sampleAt });
    publish({ widgetId: "b", title: "B", facts: ok, completedAt: Date.now(), sampleAt: sampleAt - 120_000 });
    expect(screen.getByText(/Newest sample \d\d:51/)).toBeInTheDocument();
  });
});

describe("chips", () => {
  it("states what a chip will show, and cycles its label as it steps through its widgets", async () => {
    vi.useRealTimers();
    const scroll = vi.fn();
    const scope = document.createElement("div");
    scope.innerHTML = '<article data-widget-id="a"></article><article data-widget-id="b"></article>';
    document.body.appendChild(scope);
    scope.querySelector<HTMLElement>('[data-widget-id="a"]')!.scrollIntoView = scroll;
    scope.querySelector<HTMLElement>('[data-widget-id="b"]')!.scrollIntoView = scroll;
    const user = userEvent.setup();
    const { publish, live } = renderStrip(["a", "b"], { current: scope });
    publish({ widgetId: "a", title: "First tile", facts: critical });
    publish({ widgetId: "b", title: "Second tile", facts: critical });
    const chip = await screen.findByRole("button", { name: /^2 critical: show first critical widget/ });
    await user.click(chip);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(chip).toHaveAccessibleName(/showing First tile, 1 of 2/);
    expect(screen.getByText("Showing First tile, 1 of 2.")).toBeInTheDocument();
    await user.click(chip);
    expect(chip).toHaveAccessibleName(/showing Second tile, 2 of 2/);
    expect(screen.getByText("Showing Second tile, 2 of 2.")).toBeInTheDocument();
    expect(live().textContent).toBe("");
    // The first tile keeps its outline until its own timer ends; the one just shown is outlined now.
    expect(scope.querySelector('[data-widget-id="b"]')).toHaveAttribute("data-attention-target");
    scope.remove();
  });

  it("moves focus to the strip when the focused chip disappears, rather than dropping it on the body", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const { publish, view } = renderStrip();
    publish({ widgetId: "a", title: "A", facts: critical });
    const chip = await screen.findByRole("button", { name: /^1 critical:/ });
    await user.tab();
    while (document.activeElement !== chip && document.activeElement !== document.body) await user.tab();
    expect(document.activeElement).toBe(chip);
    publish({ widgetId: "a", title: "A", facts: ok });
    expect(screen.queryByRole("button", { name: /^1 critical:/ })).toBeNull();
    expect(document.activeElement).toBe(view.container.querySelector("[data-attention-strip]"));
  });

  it("keeps its notice element rendered, and clears a notice for a tile that is not on screen after a timeout", async () => {
    vi.useFakeTimers();
    const { publish, view } = renderStrip(["a"], { current: null });
    publish({ widgetId: "a", title: "Hidden tile", facts: critical });
    act(() => vi.advanceTimersByTime(10));
    const notice = view.container.querySelector<HTMLElement>("[data-notice]")!;
    expect(notice).toBeTruthy();
    const chip = screen.getByRole("button", { name: /^1 critical:/ });
    act(() => { chip.click(); });
    expect(notice.textContent).toBe("Hidden tile is not on screen.");
    act(() => vi.advanceTimersByTime(4100));
    expect(notice.textContent).toBe("");
    expect(view.container.querySelector("[data-notice]")).toBeTruthy();
  });
});
