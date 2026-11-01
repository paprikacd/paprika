import { act, cleanup, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import type { ReactNode, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHART_REVEAL_MS, ChartEntranceContext, prefersReducedMotion, useChartEntrance } from "./chart-entrance";

const css = readFileSync("src/features/insights/chart-entrance.module.css", "utf8");
const theme = readFileSync("src/features/insights/gamma/gamma-theme.module.css", "utf8");
// Rules without comments, so prose in the stylesheet cannot satisfy or trip a check.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

function stubReducedMotion(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

beforeEach(() => {
  vi.useFakeTimers();
  stubReducedMotion(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("useChartEntrance", () => {
  it("is entering from mount, and clears itself once the reveal and its grace period have passed", () => {
    const { result } = renderHook(() => useChartEntrance());
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(CHART_REVEAL_MS + 99));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
  });

  it("does not restart on a data refresh: re-renders keep the mount timer, and the flag stays off afterwards", () => {
    const { result, rerender } = renderHook(({ revision }: { revision: number }) => useChartEntrance({ disabled: revision < 0 }), { initialProps: { revision: 0 } });
    act(() => vi.advanceTimersByTime(300));
    rerender({ revision: 1 });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(CHART_REVEAL_MS + 100 - 300 - 1));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
    rerender({ revision: 2 });
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(false);
  });

  it("never draws in for an embedded sub-widget, even after the embedding is removed", () => {
    const { result, rerender } = renderHook(({ disabled }: { disabled: boolean }) => useChartEntrance({ disabled }), { initialProps: { disabled: true } });
    expect(result.current).toBe(false);
    rerender({ disabled: false });
    expect(result.current).toBe(false);
  });

  it("does not draw in when the OS asks for reduced motion, so the marks are never clipped", () => {
    stubReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    const { result } = renderHook(() => useChartEntrance());
    expect(result.current).toBe(false);
  });

  it("does not draw in inside a data-motion=\"reduced\" scope, and still does where no such scope exists", () => {
    const scope = document.createElement("div");
    scope.dataset.motion = "reduced";
    const reducedPlot = document.createElement("div");
    scope.append(reducedPlot);
    document.body.append(scope);
    const reduced = renderHook(() => useChartEntrance({ anchor: { current: reducedPlot } as RefObject<Element | null> }));
    expect(reduced.result.current).toBe(false);
    reduced.unmount();

    const plot = document.createElement("div");
    document.body.append(plot);
    const plain = renderHook(() => useChartEntrance({ anchor: { current: plot } as RefObject<Element | null> }));
    expect(plain.result.current).toBe(true);
  });
});

describe("the widget's draw-in record", () => {
  // A slot as a canvas keeps one per widget: the first chart of the widget to draw in records it for the widget's life.
  function recordingSlot(alreadyEntered = false) {
    let entered = alreadyEntered;
    const slot = { entered: () => entered, markEntered: () => { entered = true; } };
    const wrapper = ({ children }: { children: ReactNode }) => <ChartEntranceContext.Provider value={slot}>{children}</ChartEntranceContext.Provider>;
    return { wrapper, recorded: () => entered };
  }

  it("draws in a widget's first chart and records that it has", () => {
    const { wrapper, recorded } = recordingSlot();
    const { result } = renderHook(() => useChartEntrance(), { wrapper });
    expect(result.current).toBe(true);
    expect(recorded()).toBe(true);
  });

  it("starts a remounted chart of an already drawn widget settled, with no reveal", () => {
    const { wrapper } = recordingSlot(true);
    const { result } = renderHook(() => useChartEntrance(), { wrapper });
    expect(result.current).toBe(false);
  });

  it("leaves the record alone for an embedded sub-widget", () => {
    const { wrapper, recorded } = recordingSlot();
    const { result } = renderHook(() => useChartEntrance({ disabled: true }), { wrapper });
    expect(result.current).toBe(false);
    expect(recorded()).toBe(false);
  });
});

describe("chart-entrance styles", () => {
  it("clips marks only while the reveal animates: no clip-path outside the keyframes, and no fill mode that would keep one", () => {
    // view-box measures every mark group against the same SVG viewport, so the wipe fronts line up across series.
    expect(rules).toMatch(/@keyframes reveal \{\s*from \{\s*clip-path: inset\(0 100% 0 0\) view-box;\s*\}\s*to \{\s*clip-path: inset\(0 0 0 0\) view-box;\s*\}\s*\}/);
    expect(rules.replace(/@keyframes reveal \{[\s\S]*?\n\}/, "")).not.toMatch(/clip-path/);
    expect(rules).not.toMatch(/fill-mode|\bforwards\b|\bboth\b/);
  });

  it("applies every rule only to a plot carrying data-chart-entering, so nothing animates on a static render", () => {
    const selectors = [...rules.replace(/@keyframes [\w-]+ \{[\s\S]*?\n\}/g, "").matchAll(/([^{}]+)\{/g)].flatMap((match) => match[1].split(",").map((selector) => selector.trim()));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector).toMatch(/^\[data-chart-entering\] /);
  });

  it("covers TanStack's line, area and bar groups, and leaves axes, grids and guides out", () => {
    for (const className of [".ts-chart__line", ".ts-chart__area", ".ts-chart__bar"]) expect(rules).toContain(`:global(${className})`);
    for (const className of [".ts-chart__tick", ".ts-chart__grid", ".ts-chart__crosshair", ".ts-chart__focus-layer", ".ts-chart__rule"]) expect(rules).not.toContain(className);
  });

  it("takes its durations and easing from Gamma tokens, not a parallel reduced-motion block", () => {
    expect(rules).toContain("var(--gamma-duration-reveal");
    expect(rules).toContain("var(--gamma-ease-emphasized");
    expect(rules).not.toMatch(/prefers-reduced-motion/);
  });

  it("keeps the reveal duration equal to the Gamma token that controls it", () => {
    expect(theme.match(/--gamma-duration-reveal: (\d+)ms;/)?.[1]).toBe(String(CHART_REVEAL_MS));
  });

  it("zeroes the reveal under the OS query and under an explicit data-motion=\"reduced\" scope", () => {
    const osBlock = theme.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\.scope \{([^}]*)\}/)?.[1] ?? "";
    expect(osBlock).toContain("--gamma-duration-reveal: 0ms;");
    const scopeBlock = theme.match(/\.scope\[data-motion="reduced"\] \{([^}]*)\}/)?.[1] ?? "";
    for (const token of ["fast", "base", "slow", "reveal"]) expect(scopeBlock).toContain(`--gamma-duration-${token}: 0ms;`);
  });
});
