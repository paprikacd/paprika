import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSIGHTS_THEME_KEY, InsightsThemeControl, useInsightsTheme } from "./insights-theme";
import { inheritGammaTheme } from "./gamma/inherit-theme";
import { readFileSync } from "node:fs";
import { contrastRatio } from "./appearance";
import { SERIES_HEX, SERIES_PALETTE, SERIES_ROLES, SERIES_ROLE_SLOT, seriesSlot } from "./series-palette";

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

/**
 * CIEDE2000 colour difference between two hex colours (Sharma, Wu and Dalal 2005, kL = kC = kH = 1), written out
 * here so the palette test has no colour dependency. Checked against the paper's reference pairs.
 */
function deltaE2000(first: string, second: string): number {
  const [L1, a1, b1] = toLab(first), [L2, a2, b2] = toLab(second);
  const deg = (radians: number) => (radians * 180) / Math.PI, rad = (degrees: number) => (degrees * Math.PI) / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (a: number, b: number) => (a === 0 && b === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360);
  const h1p = hue(a1p, b1), h2p = hue(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbar = (L1 + L2) / 2, Cbarp = (C1p + C2p) / 2;
  let hbar = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbar = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    else hbar = (h1p + h2p) / 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hbar - 30)) + 0.24 * Math.cos(rad(2 * hbar)) + 0.32 * Math.cos(rad(3 * hbar + 6)) - 0.2 * Math.cos(rad(4 * hbar - 63));
  const dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const SC = 1 + 0.045 * Cbarp, SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(rad(2 * dTheta)) * RC;
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

function toLab(hex: string): [number, number, number] {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const r = linear(parseInt(hex.slice(1, 3), 16)), g = linear(parseInt(hex.slice(3, 5), 16)), b = linear(parseInt(hex.slice(5, 7), 16));
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
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

  it("keeps every status mark at least 3:1 against every surface it is drawn on in each block", () => {
    for (const [block, tokens] of Object.entries(themeTokenSets()))
      for (const level of levels)
        for (const surface of surfaces)
          expect(contrastRatio(tokens[`--gamma-status-${level}`], tokens[surface]), `${block} ${level} on ${surface}`).toBeGreaterThanOrEqual(3);
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

describe("series palette", () => {
  const css = readFileSync("src/features/insights/gamma/gamma-theme.module.css", "utf8");
  const statusLevels = ["ok", "info", "warning", "critical", "unknown"] as const;
  // The categorical colours must stay apart from every status mark and from the Gamma semantic danger, success and warning.
  const statusTokens = ["--gamma-status-ok", "--gamma-status-info", "--gamma-status-warning", "--gamma-status-critical", "--gamma-status-unknown", "--gamma-danger", "--gamma-success", "--gamma-warning"];
  // Every surface a series stroke or tile is drawn on, as in the status legibility tests.
  const surfaces = ["--gamma-bg", "--gamma-surface", "--gamma-surface-2", "--gamma-page", "--gamma-sidebar"];
  const ADJACENT_MIN_DE = 15;
  const ALL_PAIRS_MIN_DE = 10;
  const DISTINCT_STATUS_MIN_DE = 15;
  const sets = themeTokenSets();

  it("computes CIEDE2000 against the reference pairs the paper publishes", () => {
    expect(deltaE2000("#000000", "#000000")).toBe(0);
    expect(deltaE2000("#3f72b4", "#4b9864")).toBeCloseTo(41.6415, 3);
    expect(deltaE2000("#003d75", "#0a9192")).toBeCloseTo(35.8782, 3);
    expect(deltaE2000("#ffffff", "#000000")).toBeCloseTo(100, 3);
    expect(deltaE2000("#43d0ff", "#1e9faf")).toBeCloseTo(16.5531, 3);
  });

  it("mirrors the CSS slots in series-palette.ts for every block", () => {
    for (const block of ["light", "dark", "compact"] as const) {
      const slots = Array.from({ length: 8 }, (_, index) => sets[block][`--gamma-series-${index + 1}`]);
      expect(slots, block).toEqual(SERIES_HEX[block]);
      // Chart tokens predate the series tokens, so each repeats its slot.
      const charts = Array.from({ length: 8 }, (_, index) => sets[block][`--gamma-chart-${index + 1}`]);
      expect(charts, block).toEqual(SERIES_HEX[block]);
    }
  });

  it("declares a role alias for every role, pointing at the slot series-palette.ts names", () => {
    const aliases = Object.fromEntries([...css.matchAll(/--gamma-series-([a-z0-9-]+):\s*var\(--gamma-series-(\d)\);/g)].map((match) => [match[1], Number(match[2])]));
    expect(Object.keys(aliases).sort()).toEqual([...SERIES_ROLES].sort());
    for (const role of SERIES_ROLES) expect(aliases[role], role).toBe(SERIES_ROLE_SLOT[role]);
    // Two roles never share a slot, so no two named colours are interchangeable.
    expect(new Set(Object.values(SERIES_ROLE_SLOT)).size).toBe(SERIES_ROLES.length);
  });

  it("gives the same slot list to the renderers, with the light value as fallback", () => {
    expect(SERIES_PALETTE).toHaveLength(8);
    SERIES_PALETTE.forEach((token, index) => expect(token).toBe(`var(--gamma-series-${index + 1}, ${SERIES_HEX.light[index]})`));
    expect(seriesSlot(8)).toBe(seriesSlot(0));
    expect(seriesSlot(-1)).toBe(seriesSlot(7));
  });

  it("keeps every slot and role at least 3:1 against every surface in each block", () => {
    for (const [block, tokens] of Object.entries(sets))
      for (let index = 1; index <= 8; index++)
        for (const surface of surfaces)
          expect(contrastRatio(tokens[`--gamma-series-${index}`], tokens[surface]), `${block} slot ${index} on ${surface}`).toBeGreaterThanOrEqual(3);
  });

  it("keeps every slot at least 15 dE2000 from every status mark and semantic status colour in its block", () => {
    for (const [block, tokens] of Object.entries(sets))
      for (let index = 1; index <= 8; index++)
        for (const status of statusTokens) {
          const distance = deltaE2000(tokens[`--gamma-series-${index}`], tokens[status]);
          expect(distance, `${block} slot ${index} vs ${status}`).toBeGreaterThanOrEqual(DISTINCT_STATUS_MIN_DE);
        }
  });

  it("keeps adjacent slots at least 15 dE2000 apart and every pair at least 10", () => {
    for (const [block, tokens] of Object.entries(sets)) {
      const slots = Array.from({ length: 8 }, (_, index) => tokens[`--gamma-series-${index + 1}`]);
      for (let index = 0; index < slots.length; index++)
        for (let other = index + 1; other < slots.length; other++) {
          const distance = deltaE2000(slots[index], slots[other]);
          if (other === index + 1) expect(distance, `${block} slots ${index + 1} and ${other + 1}`).toBeGreaterThanOrEqual(ADJACENT_MIN_DE);
          expect(distance, `${block} slots ${index + 1} and ${other + 1}`).toBeGreaterThanOrEqual(ALL_PAIRS_MIN_DE);
        }
    }
  });

  it("names no status meaning in a role: each role's slot clears every status mark too", () => {
    for (const [block, tokens] of Object.entries(sets))
      for (const role of SERIES_ROLES) {
        const colour = tokens[`--gamma-series-${SERIES_ROLE_SLOT[role]}`];
        for (const level of statusLevels)
          expect(deltaE2000(colour, tokens[`--gamma-status-${level}`]), `${block} ${role} vs ${level}`).toBeGreaterThanOrEqual(DISTINCT_STATUS_MIN_DE);
      }
  });
});
