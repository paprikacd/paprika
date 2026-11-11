import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSIGHTS_THEME_KEY, InsightsThemeControl, useInsightsTheme } from "./insights-theme";
import { inheritGammaTheme } from "./gamma/inherit-theme";
import { readFileSync } from "node:fs";
import { contrastRatio } from "./appearance";

function Harness() {
  const { theme, resolvedTheme, setTheme } = useInsightsTheme();
  return <div data-testid="scope" data-insights-theme={resolvedTheme}><InsightsThemeControl value={theme} onChange={setTheme} /></div>;
}
/**
 * Each block's tokens, sliced as the legibility test below does. The compact block inherits the dark
 * block's other tokens (such as --gamma-warning), so its effective set merges the two, as the cascade does.
 */
function themeTokenSets() {
  const css = readFileSync("src/features/insights/gamma/gamma-theme.module.css", "utf8");
  const tokens = (block: string): Record<string, string> => Object.fromEntries([...block.matchAll(/(--gamma-[\w-]+):\s*(#[\da-f]{6})/g)].map((match) => [match[1], match[2]]));
  const dark = tokens(css.split('.scope[data-insights-theme="dark"]')[1].split("}")[0]);
  return {
    light: tokens(css.split('.scope[data-insights-theme="dark"]')[0]),
    dark,
    compact: { ...dark, ...tokens(css.split('.scope[data-insights-theme="dark"][data-density="compact"]')[1].split("}")[0]) },
  };
}
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

describe("dashboard appearance", () => {
  it("follows system changes, persists explicit choices and follows system again when requested", () => {
    let dark = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({ get matches() { return dark; }, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) }));
    const view = render(<Harness />);
    expect(screen.getByTestId("scope")).toHaveAttribute("data-insights-theme", "dark");
    fireEvent.click(screen.getByRole("combobox", { name: "Dashboard appearance" }));
    fireEvent.click(screen.getByRole("option", { name: "Light" }));
    expect(screen.getByTestId("scope")).toHaveAttribute("data-insights-theme", "light");
    expect(localStorage.getItem(INSIGHTS_THEME_KEY)).toBe("light");
    act(() => { dark = false; listeners.forEach((listener) => listener()); dark = true; listeners.forEach((listener) => listener()); });
    expect(screen.getByTestId("scope")).toHaveAttribute("data-insights-theme", "light");
    view.unmount();
    render(<Harness />);
    expect(screen.getByTestId("scope")).toHaveAttribute("data-insights-theme", "light");
    fireEvent.click(screen.getByRole("combobox", { name: "Dashboard appearance" }));
    fireEvent.click(screen.getByRole("option", { name: "System" }));
    expect(screen.getByTestId("scope")).toHaveAttribute("data-insights-theme", "dark");
    act(() => { dark = false; listeners.forEach((listener) => listener()); });
    expect(screen.getByTestId("scope")).toHaveAttribute("data-insights-theme", "light");
  });

  it("updates an open portal when its dashboard changes theme", async () => {
    const root = document.createElement("div"), panel = document.createElement("div");
    root.dataset.insightsTheme = "light";
    root.style.setProperty("--gamma-bg", "#ffffff");
    root.style.setProperty("--gamma-color-scheme", "light");
    document.body.append(root, panel);
    const stop = inheritGammaTheme(root, panel);
    expect(panel.style.getPropertyValue("--gamma-bg")).toBe("#ffffff");
    expect(panel.style.colorScheme).toBe("light");
    root.style.setProperty("--gamma-bg", "#202822");
    root.style.setProperty("--gamma-color-scheme", "dark");
    root.dataset.insightsTheme = "dark";
    await act(async () => { await Promise.resolve(); });
    expect(panel.style.getPropertyValue("--gamma-bg")).toBe("#202822");
    expect(panel.style.colorScheme).toBe("dark");
    expect(panel).toHaveAttribute("data-insights-theme", "dark");
    stop(); root.remove(); panel.remove();
  });

  it("refreshes portal tokens on density and desktop changes, then cleans up", async () => {
    const root = document.createElement("div"), panel = document.createElement("div");
    root.dataset.insightsTheme = "dark";
    document.body.append(root, panel);
    let desktop = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => {
      expect(query).toBe("(min-width: 1024px)");
      return { addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
    });
    // jsdom does not evaluate media queries. No style mutation here: that
    // would mask a missing density or breakpoint event in the adapter.
    const computed = vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({
      length: 1, item: () => "--gamma-bg",
      getPropertyValue: (name: string) => name === "--gamma-bg" ? (desktop && root.dataset.density === "compact" ? "#0b1b22" : "#182127") : "dark",
    }) as unknown as CSSStyleDeclaration);
    const stop = inheritGammaTheme(root, panel);
    expect(panel.style.getPropertyValue("--gamma-bg")).toBe("#182127");
    root.dataset.density = "compact";
    await act(async () => { await Promise.resolve(); });
    expect(panel.style.getPropertyValue("--gamma-bg")).toBe("#0b1b22");
    desktop = false;
    act(() => listeners.forEach(listener => listener()));
    expect(panel.style.getPropertyValue("--gamma-bg")).toBe("#182127");
    desktop = true;
    act(() => listeners.forEach(listener => listener()));
    expect(panel.style.getPropertyValue("--gamma-bg")).toBe("#0b1b22");
    stop();
    expect(listeners.size).toBe(0);
    root.dataset.density = "standard";
    await act(async () => { await Promise.resolve(); });
    expect(panel.style.getPropertyValue("--gamma-bg")).toBe("#0b1b22");
    computed.mockRestore(); root.remove(); panel.remove();
  });

  it("keeps normal and muted copy legible on every light/dark surface", () => {
    const css = readFileSync("src/features/insights/gamma/gamma-theme.module.css", "utf8");
    for (const block of [css.split('.scope[data-insights-theme="dark"]')[0], css.split('.scope[data-insights-theme="dark"]')[1].split("}")[0], css.split('.scope[data-insights-theme="dark"][data-density="compact"]')[1].split("}")[0]]) {
      const tokens = Object.fromEntries([...block.matchAll(/(--gamma-[\w-]+):\s*(#[\da-f]{6})/g)].map((match) => [match[1], match[2]]));
      for (const surface of ["bg", "surface", "surface-2", "page", "sidebar"])
        for (const ink of ["ink", "muted"])
          expect(contrastRatio(tokens[`--gamma-${ink}`], tokens[`--gamma-${surface}`])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens["--gamma-accent-ink"], tokens["--gamma-accent"])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens["--gamma-accent-text"], tokens["--gamma-accent-soft"])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens["--gamma-chart-axis"], tokens["--gamma-bg"])).toBeGreaterThanOrEqual(4.5);
      for (let index = 1; index <= 8; index++)
        expect(contrastRatio(tokens[`--gamma-chart-${index}`], tokens["--gamma-bg"])).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the 24-step density ramp complete, ordered by luminance, and at least 3:1 against its page", () => {
    const sets = themeTokenSets();
    for (const [name, direction] of [["light", -1], ["dark", 1], ["compact", 1]] as const) {
      const tokens = sets[name];
      const ramp = Array.from({ length: 24 }, (_, index) => tokens[`--gamma-density-${index}`]);
      for (const color of ramp) expect(color).toMatch(/^#[\da-f]{6}$/);
      // Contrast against black is (L + 0.05) / 0.05, so it orders colours by relative luminance.
      const luminance = ramp.map((color) => contrastRatio(color, "#000000"));
      for (let index = 1; index < luminance.length; index++) expect(Math.sign(luminance[index] - luminance[index - 1])).toBe(direction);
      for (const color of ramp) expect(contrastRatio(color, tokens["--gamma-bg"])).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps hatch and warning marks at least 3:1 against the empty chart fill in every block", () => {
    for (const tokens of Object.values(themeTokenSets())) {
      expect(contrastRatio(tokens["--gamma-chart-hatch"], tokens["--gamma-chart-empty"])).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(tokens["--gamma-warning"], tokens["--gamma-chart-empty"])).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the lowest density step at least 3:1 against the empty chart fill in every block", () => {
    for (const tokens of Object.values(themeTokenSets()))
      expect(contrastRatio(tokens["--gamma-density-0"], tokens["--gamma-chart-empty"])).toBeGreaterThanOrEqual(3);
  });

  it("keeps the empty chart fill distinct from the page background in every block", () => {
    // Empty may sit close to the page (an observed zero reads as nothing drawn), but never on it.
    for (const tokens of Object.values(themeTokenSets()))
      expect(tokens["--gamma-chart-empty"]).not.toBe(tokens["--gamma-bg"]);
  });
});

describe("status tokens", () => {
  const levels = ["ok", "info", "warning", "critical", "unknown"];
  const mirror = JSON.parse(readFileSync("../docs/design/insights/status-tokens.json", "utf8")) as { levels: string[]; blocks: Record<string, Record<string, string>> };
  const surfaces = ["--gamma-bg", "--gamma-surface", "--gamma-surface-2", "--gamma-page", "--gamma-sidebar"];

  it("mirrors the scoped CSS values in status-tokens.json for every block", () => {
    const sets = themeTokenSets();
    for (const block of ["light", "dark", "compact"] as const) {
      const css = Object.fromEntries(Object.entries(sets[block]).filter(([name]) => name.startsWith("--gamma-status-")));
      expect(Object.keys(css)).toHaveLength(levels.length * 4);
      expect(css).toEqual(mirror.blocks[block]);
    }
    expect(mirror.levels).toEqual(levels);
  });

  it("keeps every status mark at least 3:1 against its block background", () => {
    for (const [block, tokens] of Object.entries(themeTokenSets()))
      for (const level of levels)
        expect(contrastRatio(tokens[`--gamma-status-${level}`], tokens["--gamma-bg"]), `${block} ${level}`).toBeGreaterThanOrEqual(3);
  });

  it("keeps status text at least 4.5:1 on every surface and tint it sits on", () => {
    for (const [block, tokens] of Object.entries(themeTokenSets()))
      for (const level of levels)
        for (const surface of [...surfaces, `--gamma-status-${level}-soft`])
          expect(contrastRatio(tokens[`--gamma-status-${level}-text`], tokens[surface]), `${block} ${level} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps on-fill ink at least 4.5:1 against its status mark", () => {
    for (const [block, tokens] of Object.entries(themeTokenSets()))
      for (const level of levels)
        expect(contrastRatio(tokens[`--gamma-status-${level}-on`], tokens[`--gamma-status-${level}`]), `${block} ${level}`).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps ok and critical at least 3:1 apart in lightness in every block", () => {
    for (const [block, tokens] of Object.entries(themeTokenSets()))
      expect(contrastRatio(tokens["--gamma-status-ok"], tokens["--gamma-status-critical"]), block).toBeGreaterThanOrEqual(3);
  });
});
