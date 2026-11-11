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
 * CIEDE2000 colour difference (Sharma, Wu and Dalal 2005, kL = kC = kH = 1) between two CIELAB colours, written out so
 * the palette tests need no colour dependency. insights-theme.test.tsx checks it against the paper's published pairs.
 */
function deltaE2000Lab([L1, a1, b1]: readonly number[], [L2, a2, b2]: readonly number[]): number {
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

const deltaE2000 = (first: string, second: string) => deltaE2000Lab(toLab(first), toLab(second));

/**
 * Deuteranopia as Machado, Oliveira and Fernandes (2009) model it: severity 1.0 matrix applied to linear sRGB, then
 * re-encoded. The simulated colours are compared with CIEDE2000, as the rest of the palette tests do.
 */
const DEUTERANOPIA = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]];
function simulateDeuteranopia(hex: string): string {
  const linear = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const encoded = DEUTERANOPIA.map((row) => {
    const value = Math.min(1, Math.max(0, row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2]));
    const channel = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
    return Math.round(channel * 255).toString(16).padStart(2, "0");
  });
  return `#${encoded.join("")}`;
}

/** The colour a series tile tint gives when a palette colour is mixed with white (CSS color-mix in srgb). */
function tintOf(hex: string, share: number): string {
  return `#${[1, 3, 5].map((offset) => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * share + 255 * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
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

/** The 34 test pairs published with the CIEDE2000 paper (Sharma, Wu and Dalal 2005, Table 1), as [Lab1, Lab2, dE00]. */
const PUBLISHED_CIEDE2000_PAIRS: [number[], number[], number][] = [
  [[50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425],
  [[50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615],
  [[50.0, 2.8361, -74.02], [50.0, 0.0, -82.7485], 3.4412],
  [[50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0],
  [[50.0, -1.1848, -84.8006], [50.0, 0.0, -82.7485], 1.0],
  [[50.0, -0.9009, -85.5211], [50.0, 0.0, -82.7485], 1.0],
  [[50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669],
  [[50.0, -1.0, 2.0], [50.0, 0.0, 0.0], 2.3669],
  [[50.0, 2.49, -0.001], [50.0, -2.49, 0.0009], 7.1792],
  [[50.0, 2.49, -0.001], [50.0, -2.49, 0.001], 7.1792],
  [[50.0, 2.49, -0.001], [50.0, -2.49, 0.0011], 7.2195],
  [[50.0, 2.49, -0.001], [50.0, -2.49, 0.0012], 7.2195],
  [[50.0, -0.001, 2.49], [50.0, 0.0009, -2.49], 4.8045],
  [[50.0, -0.001, 2.49], [50.0, 0.001, -2.49], 4.8045],
  [[50.0, -0.001, 2.49], [50.0, 0.0011, -2.49], 4.7461],
  [[50.0, 2.5, 0.0], [50.0, 0.0, -2.5], 4.3065],
  [[50.0, 2.5, 0.0], [73.0, 25.0, -18.0], 27.1492],
  [[50.0, 2.5, 0.0], [61.0, -5.0, 29.0], 22.8977],
  [[50.0, 2.5, 0.0], [56.0, -27.0, -3.0], 31.903],
  [[50.0, 2.5, 0.0], [58.0, 24.0, 15.0], 19.4535],
  [[50.0, 2.5, 0.0], [50.0, 3.1736, 0.5854], 1.0],
  [[50.0, 2.5, 0.0], [50.0, 3.2972, 0.0], 1.0],
  [[50.0, 2.5, 0.0], [50.0, 1.8634, 0.5757], 1.0],
  [[50.0, 2.5, 0.0], [50.0, 3.2592, 0.335], 1.0],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
  [[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
  [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
  [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
  [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
  [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
  [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
];

describe("series palette", () => {
  const css = readFileSync("src/features/insights/gamma/gamma-theme.module.css", "utf8");
  const statusLevels = ["ok", "info", "warning", "critical", "unknown"] as const;
  // The categorical colours must stay apart from every status mark and from the Gamma semantic danger, success and warning.
  const statusTokens = ["--gamma-status-ok", "--gamma-status-info", "--gamma-status-warning", "--gamma-status-critical", "--gamma-status-unknown", "--gamma-danger", "--gamma-success", "--gamma-warning"];
  // Every surface a series stroke or tile is drawn on, as in the status legibility tests.
  const surfaces = ["--gamma-bg", "--gamma-surface", "--gamma-surface-2", "--gamma-page", "--gamma-sidebar"];
  const sets = themeTokenSets();
  const slotsOf = (tokens: Record<string, string>) => Array.from({ length: 8 }, (_, index) => tokens[`--gamma-series-${index + 1}`]);
  const darkBlocks = ["dark", "compact"] as const;
  const ADJACENT_MIN_DE = 15;
  const ALL_PAIRS_MIN_DE_DARK = 10;
  const ALL_PAIRS_MIN_DE_LIGHT = 15;
  const INK_MIN_DE_DARK = 20;
  const STATUS_MIN_DE = 15;
  const DEUTERANOPIA_MIN_DE = 8;
  const DARK_MAX_LIGHTNESS = 80;
  const TINT_TEXT = "#23332c";
  const TINT_MIN_TEXT_CONTRAST = 4.5;
  const TINT_MIN_DE = 6;

  it("matches CIEDE2000 on all 34 published test pairs", () => {
    expect(PUBLISHED_CIEDE2000_PAIRS).toHaveLength(34);
    for (const [first, second, expected] of PUBLISHED_CIEDE2000_PAIRS)
      expect(Math.abs(deltaE2000Lab(first, second) - expected), `${first} vs ${second}`).toBeLessThan(1e-4);
    expect(deltaE2000("#000000", "#000000")).toBe(0);
  });

  it("mirrors the CSS slots in series-palette.ts for every block", () => {
    for (const block of ["light", "dark", "compact"] as const) {
      expect(slotsOf(sets[block]), block).toEqual(SERIES_HEX[block]);
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
          expect(distance, `${block} slot ${index} vs ${status}`).toBeGreaterThanOrEqual(STATUS_MIN_DE);
        }
  });

  it("keeps adjacent slots at least 15 dE2000 apart, and every pair apart by 10 in dark blocks and 15 in light", () => {
    for (const [block, tokens] of Object.entries(sets)) {
      const slots = slotsOf(tokens);
      for (let index = 0; index < slots.length; index++)
        for (let other = index + 1; other < slots.length; other++) {
          const distance = deltaE2000(slots[index], slots[other]);
          if (other === index + 1) expect(distance, `${block} slots ${index + 1} and ${other + 1}`).toBeGreaterThanOrEqual(ADJACENT_MIN_DE);
          const minimum = block === "light" ? ALL_PAIRS_MIN_DE_LIGHT : ALL_PAIRS_MIN_DE_DARK;
          expect(distance, `${block} slots ${index + 1} and ${other + 1}`).toBeGreaterThanOrEqual(minimum);
        }
    }
  });

  it("keeps every slot in the dark blocks at L* 80 or below, so no wedge or line washes out", () => {
    for (const block of darkBlocks)
      for (const slot of slotsOf(sets[block])) expect(toLab(slot)[0], `${block} ${slot}`).toBeLessThanOrEqual(DARK_MAX_LIGHTNESS);
  });

  it("keeps every dark-block slot at least 20 dE2000 from the widget ink", () => {
    for (const block of darkBlocks)
      for (const slot of slotsOf(sets[block])) expect(deltaE2000(slot, sets[block]["--gamma-ink"]), `${block} ${slot}`).toBeGreaterThanOrEqual(INK_MIN_DE_DARK);
  });

  it("keeps the first four slots at least 8 dE2000 apart under simulated deuteranopia, in every block", () => {
    for (const [block, tokens] of Object.entries(sets)) {
      const simulated = slotsOf(tokens).slice(0, 4).map(simulateDeuteranopia);
      for (let index = 0; index < simulated.length; index++)
        for (let other = index + 1; other < simulated.length; other++)
          expect(deltaE2000(simulated[index], simulated[other]), `${block} slots ${index + 1} and ${other + 1}`).toBeGreaterThanOrEqual(DEUTERANOPIA_MIN_DE);
    }
  });

  it("keeps every role's slot at least 15 dE2000 from every status mark too", () => {
    for (const [block, tokens] of Object.entries(sets))
      for (const role of SERIES_ROLES) {
        const colour = tokens[`--gamma-series-${SERIES_ROLE_SLOT[role]}`];
        for (const level of statusLevels)
          expect(deltaE2000(colour, tokens[`--gamma-status-${level}`]), `${block} ${role} vs ${level}`).toBeGreaterThanOrEqual(STATUS_MIN_DE);
      }
  });

  it("keeps the pie and treemap tints legible and distinct: dark tile text at 4.5:1 or better, and no two tints closer than 6 dE2000", () => {
    // records.module.css mixes each slot 1-6 with white at --record-tint. The light share is the default; dark and compact override it.
    const records = readFileSync("src/features/insights/plugins/records.module.css", "utf8");
    const light = Number(records.match(/--record-tint:\s*(\d+)%/)![1]) / 100;
    const dark = Number(records.match(/:global\(\[data-insights-theme="dark"\]\) \.treemap\s*\{\s*--record-tint:\s*(\d+)%/)![1]) / 100;
    expect(light).toBeGreaterThan(0);
    expect(dark).toBeGreaterThan(0);
    for (const [share, slots] of [[light, SERIES_HEX.light], [dark, SERIES_HEX.dark], [dark, SERIES_HEX.compact]] as const) {
      const tints = slots.slice(0, 6).map((slot) => tintOf(slot, share));
      for (const tint of tints) expect(contrastRatio(TINT_TEXT, tint), tint).toBeGreaterThanOrEqual(TINT_MIN_TEXT_CONTRAST);
      for (let index = 0; index < tints.length; index++)
        for (let other = index + 1; other < tints.length; other++)
          expect(deltaE2000(tints[index], tints[other]), `${tints[index]} vs ${tints[other]}`).toBeGreaterThanOrEqual(TINT_MIN_DE);
    }
  });
});

describe("query editor syntax tokens", () => {
  const sets = themeTokenSets();
  const syntax = ["--gamma-syntax-keyword", "--gamma-syntax-function", "--gamma-syntax-string", "--gamma-syntax-number"];

  it("gives the editor its own syntax colours, each at least 4.5:1 on the editor surface in every block", () => {
    for (const [block, tokens] of Object.entries(sets))
      for (const token of syntax)
        expect(contrastRatio(tokens[token], tokens["--gamma-surface"]), `${block} ${token}`).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the four syntax colours at least 15 dE2000 apart in every block", () => {
    for (const [block, tokens] of Object.entries(sets))
      for (let index = 0; index < syntax.length; index++)
        for (let other = index + 1; other < syntax.length; other++)
          expect(deltaE2000(tokens[syntax[index]], tokens[syntax[other]]), `${block} ${syntax[index]} vs ${syntax[other]}`).toBeGreaterThanOrEqual(15);
  });

  it("reads the syntax tokens in the editor rather than chart or status colours", () => {
    const source = readFileSync("src/features/insights/query-code-editor.tsx", "utf8");
    expect(source).toContain("var(--gamma-syntax-keyword");
    expect(source).toContain("var(--gamma-syntax-function");
    expect(source).toContain("var(--gamma-syntax-string");
    expect(source).toContain("var(--gamma-syntax-number");
    expect(source).not.toMatch(/var\(--gamma-chart-/);
  });
});
