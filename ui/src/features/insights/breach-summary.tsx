"use client";

import type { BreachLevel, BreachLevelSummary } from "./breaches";
import chartStyles from "./charts.module.css";
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

/** The words for one level, e.g. "Critical · 2 intervals · 14 min" or "Warning · 1 single sample". */
export function breachLevelText(entry: BreachLevelSummary): string {
  const parts: string[] = [];
  if (entry.intervals) parts.push(`${entry.intervals} ${entry.intervals === 1 ? "interval" : "intervals"}`, formatBreachDuration(entry.duration));
  if (entry.samples) parts.push(`${entry.samples} single ${entry.samples === 1 ? "sample" : "samples"}`);
  return [LEVEL_LABEL[entry.level], ...parts].join(" · ");
}

/**
 * The breach line of a time series. Each level is named in words, so the line reads the same without colour. It is always
 * rendered for a widget with a warning or critical status, and reads "No breaches in range" when nothing breaches. It has a
 * fixed height and truncates, so its text never changes the footer's layout.
 */
export function BreachSummary({ summary, partial = false, unshaded = 0 }: { summary: readonly BreachLevelSummary[]; partial?: boolean; unshaded?: number }) {
  return (
    <span className={`${chartStyles.notice} ${styles.summary}`} data-breach-summary data-breach-state={summary.length ? "active" : "none"}>
      {summary.length ? summary.map((entry, index) => (
        <span key={entry.level} className={styles.level} data-level={entry.level} data-breach-level={entry.level}>
          {index > 0 && "; "}
          {breachLevelText(entry)}
        </span>
      )) : "No breaches in range"}
      {partial && " · partial result"}
      {unshaded > 0 && ` · ${unshaded} more ${unshaded === 1 ? "band" : "bands"} not shaded`}
    </span>
  );
}
