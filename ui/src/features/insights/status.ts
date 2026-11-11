// Semantic status vocabulary for thresholds. A threshold names a status; each status resolves to a per-theme
// --gamma-status-* token (gamma/gamma-theme.module.css), so one document shares its meaning across themes.
// An explicit hex colour is a hue override and replaces the status mark for that band. The Go validator in
// internal/insights/schema_extensions.go mirrors statusLevels, and docs/design/insights/status-tokens.json mirrors the tokens.
import { readableTextColor } from "./appearance";

export const statusLevels = ["ok", "info", "warning", "critical", "unknown"] as const;
export type StatusLevel = (typeof statusLevels)[number];

/** The paint-relevant part of a threshold. A threshold must name a status, a colour or both. */
export type StatusMark = { status?: StatusLevel; color?: string };

/** Each block's --gamma-status-* values, mirrored from status-tokens.json by status.test.ts. */
export type StatusTheme = "light" | "dark" | "compact";
export const STATUS_HEX: Record<StatusTheme, Record<string, string>> = {
  light: {
    "--gamma-status-ok": "#4b9864",
    "--gamma-status-ok-soft": "#eaf4ed",
    "--gamma-status-ok-text": "#2a6a43",
    "--gamma-status-ok-on": "#000000",
    "--gamma-status-info": "#3f72b4",
    "--gamma-status-info-soft": "#e9f0fa",
    "--gamma-status-info-text": "#2c5c94",
    "--gamma-status-info-on": "#ffffff",
    "--gamma-status-warning": "#986111",
    "--gamma-status-warning-soft": "#faf5e8",
    "--gamma-status-warning-text": "#6e4a0d",
    "--gamma-status-warning-on": "#ffffff",
    "--gamma-status-critical": "#7f0a12",
    "--gamma-status-critical-soft": "#fff0ec",
    "--gamma-status-critical-text": "#7f0a12",
    "--gamma-status-critical-on": "#ffffff",
    "--gamma-status-unknown": "#4d5d68",
    "--gamma-status-unknown-soft": "#eef2f3",
    "--gamma-status-unknown-text": "#3a4852",
    "--gamma-status-unknown-on": "#ffffff",
  },
  dark: {
    "--gamma-status-ok": "#498a5c",
    "--gamma-status-ok-soft": "#22382c",
    "--gamma-status-ok-text": "#83b69b",
    "--gamma-status-ok-on": "#000000",
    "--gamma-status-info": "#5b93d6",
    "--gamma-status-info-soft": "#1d2c40",
    "--gamma-status-info-text": "#9fc3f2",
    "--gamma-status-info-on": "#000000",
    "--gamma-status-warning": "#cb9742",
    "--gamma-status-warning-soft": "#3b3525",
    "--gamma-status-warning-text": "#dec48b",
    "--gamma-status-warning-on": "#000000",
    "--gamma-status-critical": "#ffd4cc",
    "--gamma-status-critical-soft": "#422b28",
    "--gamma-status-critical-text": "#f29c8e",
    "--gamma-status-critical-on": "#000000",
    "--gamma-status-unknown": "#8d9ca6",
    "--gamma-status-unknown-soft": "#26353e",
    "--gamma-status-unknown-text": "#b8c6cd",
    "--gamma-status-unknown-on": "#000000",
  },
  compact: {
    "--gamma-status-ok": "#3e8357",
    "--gamma-status-ok-soft": "#10291e",
    "--gamma-status-ok-text": "#7fcc9d",
    "--gamma-status-ok-on": "#000000",
    "--gamma-status-info": "#6aa9ee",
    "--gamma-status-info-soft": "#132a40",
    "--gamma-status-info-text": "#9ccbff",
    "--gamma-status-info-on": "#000000",
    "--gamma-status-warning": "#d0993c",
    "--gamma-status-warning-soft": "#2b2412",
    "--gamma-status-warning-text": "#f2b84b",
    "--gamma-status-warning-on": "#000000",
    "--gamma-status-critical": "#ffc6bc",
    "--gamma-status-critical-soft": "#35201e",
    "--gamma-status-critical-text": "#ffb8ac",
    "--gamma-status-critical-on": "#000000",
    "--gamma-status-unknown": "#8a9ca6",
    "--gamma-status-unknown-soft": "#182f39",
    "--gamma-status-unknown-text": "#b9c9d2",
    "--gamma-status-unknown-on": "#000000",
  },
};

/** Light-theme marks: the var() fallback, and the hex that hex-only checks compare against. */
const LIGHT_MARKS = Object.fromEntries(statusLevels.map((level) => [level, STATUS_HEX.light[`--gamma-status-${level}`]])) as Record<StatusLevel, string>;

export type StatusPart = "" | "-soft" | "-text" | "-on";

/**
 * The CSS variable for a status. The mark carries a light fallback so it still paints outside the Insights scope;
 * the other parts need the scoped theme and have no fallback.
 */
export function statusToken(level: StatusLevel, part: StatusPart = ""): string {
  return part === "" ? `var(--gamma-status-${level}, ${LIGHT_MARKS[level]})` : `var(--gamma-status-${level}${part})`;
}

/** The concrete hex of one status token in one theme block, for checks and contrast adjustment. */
export function statusHex(theme: StatusTheme, level: StatusLevel, part: StatusPart = ""): string {
  return STATUS_HEX[theme][`--gamma-status-${level}${part}`];
}

/** Marks and fills: a threshold's hex hue override when it has one, otherwise its status mark. */
export function thresholdPaint(threshold: StatusMark | undefined): string | undefined {
  if (!threshold) return undefined;
  if (threshold.color !== undefined) return threshold.color;
  return threshold.status === undefined ? undefined : statusToken(threshold.status);
}

/** Text in a threshold's colour: its hex override, or the status's text token (which meets 4.5:1 on the surfaces). */
export function thresholdText(threshold: StatusMark | undefined): string | undefined {
  if (!threshold) return undefined;
  if (threshold.color !== undefined) return threshold.color;
  return threshold.status === undefined ? undefined : statusToken(threshold.status, "-text");
}

/** Text drawn on a solid threshold fill: the status's on-fill ink, or the readable ink for a hex override. */
export function thresholdInk(threshold: StatusMark | undefined): string | undefined {
  if (!threshold) return undefined;
  if (threshold.color !== undefined) return readableTextColor(threshold.color);
  return threshold.status === undefined ? undefined : statusToken(threshold.status, "-on");
}

/**
 * A plain hex for a threshold in one theme block, for checks and swatches that need a number rather than a theme
 * token. It is the hue override, or that block's mark for a status-only threshold.
 */
export function thresholdHex(threshold: StatusMark | undefined, theme: StatusTheme = "light"): string | undefined {
  if (!threshold) return undefined;
  if (threshold.color !== undefined) return threshold.color;
  return threshold.status === undefined ? undefined : statusHex(theme, threshold.status);
}
