// Semantic status vocabulary for thresholds. A threshold names a status; each status resolves to a per-theme
// --gamma-status-* token (gamma/gamma-theme.module.css), so one document shares its meaning across themes.
// An explicit hex colour is a hue override and replaces the status mark for that band. The Go validator in
// internal/insights/schema_extensions.go mirrors statusLevels, and docs/design/insights/status-tokens.json mirrors the tokens.
import { readableTextColor } from "./appearance";

export const statusLevels = ["ok", "info", "warning", "critical", "unknown"] as const;
export type StatusLevel = (typeof statusLevels)[number];

/** The paint-relevant part of a threshold. A threshold must name a status, a colour or both. */
export type StatusMark = { status?: StatusLevel; color?: string };

/** Light-theme mark values. They are the var() fallback, and the hex that hex-only checks compare against. */
const LIGHT_MARKS: Record<StatusLevel, string> = {
  ok: "#59a26f",
  info: "#3f72b4",
  warning: "#986111",
  critical: "#881418",
  unknown: "#6b7b85",
};

export type StatusPart = "" | "-soft" | "-text" | "-on";

/**
 * The CSS variable for a status. The mark carries a light fallback so it still paints outside the Insights scope;
 * the other parts need the scoped theme and have no fallback.
 */
export function statusToken(level: StatusLevel, part: StatusPart = ""): string {
  return part === "" ? `var(--gamma-status-${level}, ${LIGHT_MARKS[level]})` : `var(--gamma-status-${level}${part})`;
}

/** The colour that paints a threshold: its hex hue override when it has one, otherwise its status mark. */
export function thresholdPaint(threshold: StatusMark | undefined): string | undefined {
  if (!threshold) return undefined;
  if (threshold.color !== undefined) return threshold.color;
  return threshold.status === undefined ? undefined : statusToken(threshold.status);
}

/** Text drawn on a solid threshold fill: the status's on-fill ink, or the readable ink for a hex override. */
export function thresholdInk(threshold: StatusMark | undefined): string | undefined {
  if (!threshold) return undefined;
  if (threshold.color !== undefined) return readableTextColor(threshold.color);
  return threshold.status === undefined ? undefined : statusToken(threshold.status, "-on");
}

/**
 * A plain hex for a threshold, for checks that need a number rather than a theme token (for example the heatmap
 * text-contrast warning). It is the hue override, or the light-theme mark for a status-only threshold.
 */
export function thresholdHex(threshold: StatusMark | undefined): string | undefined {
  if (!threshold) return undefined;
  if (threshold.color !== undefined) return threshold.color;
  return threshold.status === undefined ? undefined : LIGHT_MARKS[threshold.status];
}
