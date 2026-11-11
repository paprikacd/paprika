"use client";

import type { BreachLevel, BreachLevelSummary } from "./breaches";
import styles from "./breach.module.css";

const LEVEL_LABEL: Record<BreachLevel, string> = { critical: "Critical", warning: "Warning" };

/** A plain duration for a breach: seconds under a minute, minutes under an hour, then hours and minutes. */
export function formatBreachDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/**
 * The footer line for a time series' breaches, e.g. "Critical · 2 intervals · 14 min". Each level is named in words, so the
 * line reads the same without colour. It renders nothing when no series breaches.
 */
export function BreachSummary({ summary, partial = false, unshaded = 0 }: { summary: readonly BreachLevelSummary[]; partial?: boolean; unshaded?: number }) {
  if (!summary.length) return null;
  return (
    <span className={styles.summary} data-breach-summary>
      {summary.map((entry, index) => (
        <span key={entry.level} className={styles.level} data-level={entry.level} data-breach-level={entry.level}>
          {index > 0 && "; "}
          {LEVEL_LABEL[entry.level]} · {entry.intervals} {entry.intervals === 1 ? "interval" : "intervals"} · {formatBreachDuration(entry.duration)}
        </span>
      ))}
      {partial && " · partial result"}
      {unshaded > 0 && ` · ${unshaded} more ${unshaded === 1 ? "band" : "bands"} not shaded`}
    </span>
  );
}
