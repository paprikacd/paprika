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

  it("keeps normal and muted copy legible on every light/dark surface", () => {
    const css = readFileSync("src/features/insights/gamma/gamma-theme.module.css", "utf8");
    for (const block of [css.split('.scope[data-insights-theme="dark"]')[0], css.split('.scope[data-insights-theme="dark"]')[1].split("}")[0]]) {
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
});
