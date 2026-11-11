"use client";

import { useLayoutEffect, useState, type CSSProperties, type HTMLAttributes, type RefObject } from "react";
import { statusToken, thresholdInk, thresholdPaint, type StatusLevel, type StatusMark } from "./status";
import styles from "./status-chip.module.css";

/**
 * The second, non-hue cue for a status: a glyph plus a word. The glyphs match the console's status tones
 * (ok ✓, critical ×, warning !, unknown ?) and info uses i. Glyphs are decorative; the word is the name.
 */
export const STATUS_GLYPHS: Record<StatusLevel, string> = { ok: "✓", info: "i", warning: "!", critical: "×", unknown: "?" };
export const STATUS_WORDS: Record<StatusLevel, string> = { ok: "OK", info: "Info", warning: "Warning", critical: "Critical", unknown: "Unknown" };

/** Whether `text` already contains the status word as a whole word, ignoring case ("Critical 90%" names Critical). */
function namesWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z])${word.toLowerCase()}([^a-z]|$)`).test(text.toLowerCase());
}

/**
 * The reading a band announces in names and titles: its label, with the status word added once when the label
 * does not already say it. A status-only band reads as its word; a hex-only band keeps its label or the fallback.
 */
export function bandReading(band: { status?: StatusLevel; color?: string; label?: string } | undefined, fallback = "Observed"): string {
  const label = band?.label?.trim() ?? "";
  if (!band?.status) return label || fallback;
  const word = STATUS_WORDS[band.status];
  if (!label) return word;
  return namesWord(label, word) ? label : `${label} · ${word}`;
}

export type StatusStrokeLevel = "warning" | "critical";

/** Frame widths in px. The keyline (1 px, tile colour) sits between the frame and the fill. */
const FRAME_PX: Record<StatusStrokeLevel, number> = { warning: 1, critical: 2 };

/**
 * Status cells take a frame only when they are large enough to keep fill beneath it: at least 2 x frame + 3 px
 * in both directions. Thin marks stay unframed, so their fill is never reduced; their level is carried by the
 * legend chip and the accessible name. Hatching is reserved for missing data, and a hex-only band has no level.
 */
export function statusStrokeLevel(
  mark: StatusMark | undefined,
  size?: { width?: number; height?: number },
): StatusStrokeLevel | undefined {
  const level = mark?.status === "warning" || mark?.status === "critical" ? mark.status : undefined;
  if (!level) return undefined;
  const needed = 2 * FRAME_PX[level] + 3;
  const fits = (px: number | undefined) => px === undefined || px >= needed;
  return fits(size?.width) && fits(size?.height) ? level : undefined;
}

/** Spread with the stroke level. The frame is the ink colour, so it contrasts with the tile surface. */
export function statusStrokeStyle(mark: StatusMark | undefined, size?: { width?: number; height?: number }): CSSProperties {
  return statusStrokeLevel(mark, size) ? ({ "--status-stroke-color": "var(--gamma-ink)" } as CSSProperties) : {};
}

/**
 * The rendered size of the first element matching `selector` under `root`, re-measured on resize. It is undefined
 * before the first layout, and when the element is hidden, so an unmeasured cell is not stripped of its frame.
 */
export function useTrackSize(root: RefObject<HTMLElement | null>, selector: string, revision: unknown) {
  const [size, setSize] = useState<{ width: number; height: number }>();
  useLayoutEffect(() => {
    const element = root.current?.querySelector<HTMLElement>(selector);
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize(width > 0 && height > 0 ? { width, height } : undefined);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [root, selector, revision]);
  return size;
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
 * "Elevated" is announced as "Warning: Elevated", and a label that already says the word is not repeated.
 */
export function StatusChip({ status, color, label, size = "inline", className = "", style, ...rest }: StatusChipProps) {
  const mark = { status, color };
  const word = STATUS_WORDS[status];
  const text = label?.trim() ? label.trim() : word;
  const announcedWord = namesWord(text, word) ? undefined : word;
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
