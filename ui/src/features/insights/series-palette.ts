// The categorical series palette. --gamma-series-1..8 in gamma/gamma-theme.module.css is the one source of series
// colour: renderers take a slot by index here, and a series colour rule can name a role. Series colours are
// categorical, not status: they must stay clear of the --gamma-status-* marks (insights-theme.test.tsx enforces it).
// SERIES_HEX mirrors the CSS for canvas and SVG uses that cannot read custom properties; the same test keeps them equal.

export const SERIES_SLOTS = 8;

/** Semantic roles. Each names a slot, so a rule can say "server errors" without a hex value. */
export const SERIES_ROLES = ["traffic", "success", "client-error", "server-error", "p50", "p95", "p99"] as const;
export type SeriesRole = (typeof SERIES_ROLES)[number];

/** The 1-based slot each role aliases in gamma-theme.module.css. Two roles never share a slot. */
export const SERIES_ROLE_SLOT: Readonly<Record<SeriesRole, number>> = {
  traffic: 1,
  success: 2,
  "client-error": 3,
  "server-error": 7,
  p50: 4,
  p95: 6,
  p99: 5,
};

export type SeriesTheme = "light" | "dark" | "compact";

/** Each block's --gamma-series-1..8 values, in slot order. */
export const SERIES_HEX: Readonly<Record<SeriesTheme, readonly string[]>> = {
  light: ["#003d75", "#0c9a93", "#887fd0", "#127a8b", "#a75fa7", "#61516f", "#b77080", "#86885b"],
  dark: ["#21ccfe", "#32dcd5", "#ae7ecf", "#29a1a3", "#d76fa1", "#a5a1c9", "#e7a5c4", "#999a66"],
  compact: ["#14c2e8", "#00d8cf", "#b499aa", "#1fa6a9", "#cf7abf", "#9e9ed1", "#ff92b7", "#8f9e54"],
};

/** The slot colour for a series index. Indexes wrap after eight; the light value is the fallback outside a Gamma scope. */
export function seriesSlot(index: number): string {
  const slot = ((Math.trunc(index) % SERIES_SLOTS) + SERIES_SLOTS) % SERIES_SLOTS;
  return `var(--gamma-series-${slot + 1}, ${SERIES_HEX.light[slot]})`;
}

/** Slot colours in order, as the renderers consume them. */
export const SERIES_PALETTE: readonly string[] = Array.from({ length: SERIES_SLOTS }, (_, index) => seriesSlot(index));

/** The colour a role resolves to in the active theme. */
export function seriesRole(role: SeriesRole): string {
  return `var(--gamma-series-${role}, ${SERIES_HEX.light[SERIES_ROLE_SLOT[role] - 1]})`;
}

/** The hex value of a slot in one theme, for canvas and SVG output that cannot read custom properties. */
export function seriesHex(index: number, theme: SeriesTheme = "light"): string {
  return SERIES_HEX[theme][((Math.trunc(index) % SERIES_SLOTS) + SERIES_SLOTS) % SERIES_SLOTS];
}
