"use client";

import type { CSSProperties, HTMLAttributes } from "react";
import { statusToken, thresholdInk, thresholdPaint, type StatusLevel, type StatusMark } from "./status";
import styles from "./status-chip.module.css";

/**
 * The second, non-hue cue for a status: a glyph plus a word. The glyphs match the console's status tones
 * (ok ✓, critical ×, warning !, unknown ?) and info uses i. Glyphs are decorative; the word is the name.
 */
export const STATUS_GLYPHS: Record<StatusLevel, string> = { ok: "✓", info: "i", warning: "!", critical: "×", unknown: "?" };
export const STATUS_WORDS: Record<StatusLevel, string> = { ok: "OK", info: "Info", warning: "Warning", critical: "Critical", unknown: "Unknown" };

/** The status word a band reads as: its name when it has one, its status word otherwise, and the default reading when neither exists. */
export function statusName(mark: StatusMark | undefined, fallback = "Observed"): string {
  return mark?.status ? STATUS_WORDS[mark.status] : fallback;
}

export type StatusStrokeLevel = "warning" | "critical";

/**
 * Status cells get a 1 px inset stroke for warning and 2 px for critical. Hatching is reserved for missing data
 * (docs/design/insights/UX-CONTRACT.md), so it never encodes a status. A hex-only band has no level and no stroke.
 */
export function statusStrokeLevel(mark: StatusMark | undefined): StatusStrokeLevel | undefined {
  return mark?.status === "warning" || mark?.status === "critical" ? mark.status : undefined;
}

/**
 * Spread onto a status cell with `data-status-stroke={statusStrokeLevel(mark)}`. The owning stylesheet applies
 * `box-shadow: var(--status-inset, 0 0 #0000)`, so the stroke composes with focus and pressed rings.
 */
export function statusStrokeStyle(mark: StatusMark | undefined): CSSProperties {
  const ink = statusStrokeLevel(mark) ? thresholdInk(mark) : undefined;
  return ink ? ({ "--status-stroke-color": ink } as CSSProperties) : {};
}

export interface StatusChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, "color"> {
  status: StatusLevel;
  /** Hue override for the glyph mark. The status still names the meaning and the text tone. */
  color?: string;
  /** Visible text. It defaults to the status word; a custom label is announced after the status word. */
  label?: string;
  size?: "inline" | "tile";
}

/**
 * Glyph plus label for one status. It is non-interactive: a plain span with no role, focus or handler. Callers
 * that need interaction wrap it. The accessible name always includes the status word, so a custom label such as
 * "Elevated" is announced as "Warning: Elevated" and colour is never the only carrier of the status.
 */
export function StatusChip({ status, color, label, size = "inline", className = "", style, ...rest }: StatusChipProps) {
  const mark = { status, color };
  const word = STATUS_WORDS[status];
  const text = label?.trim() ? label.trim() : word;
  const announcedWord = text.toLowerCase() === word.toLowerCase() ? undefined : word;
  return (
    <span
      {...rest}
      className={`${styles.chip} ${className}`.trim()}
      data-status={status}
      data-size={size}
      style={{
        "--chip-soft": statusToken(status, "-soft"),
        "--chip-text": statusToken(status, "-text"),
        "--chip-mark": thresholdPaint(mark),
        "--chip-ink": thresholdInk(mark),
        ...style,
      } as CSSProperties}
    >
      <span className={styles.glyph} aria-hidden="true">{STATUS_GLYPHS[status]}</span>
      <span className={styles.text}>
        {announcedWord && <span className={styles.srOnly}>{announcedWord}: </span>}
        {text}
      </span>
    </span>
  );
}
