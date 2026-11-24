import { useEffect, useState } from "react";
import { fnv1a32 } from "./series-colors";

/** The longest a widget waits for its slot in an auto-refresh tick. */
export const REFRESH_STAGGER_CAP_MS = 4000;

/**
 * The window in which a board's auto-refresh ticks spread across its widgets: a quarter of the refresh
 * interval, capped. A manual refresh or a range change does not stagger.
 */
export function refreshStaggerSpread(intervalSeconds: number): number {
  return Math.min(REFRESH_STAGGER_CAP_MS, intervalSeconds * 250);
}

/** A widget's slot in the spread. It is stable for the widget's id, so a tile always refreshes at the same point in the tick. */
export function staggerOffsetMs(id: string, spreadMs: number): number {
  if (spreadMs <= 0) return 0;
  return ((fnv1a32(id) % 1000) / 1000) * spreadMs;
}

/**
 * The window a widget queries. Every tile receives the board's aligned end, so they all adopt the same window; a
 * staggered tick only delays when each tile adopts it. With no stagger the live window is returned at once.
 * A change that is superseded before the offset elapses is cancelled, so a stale window is never adopted.
 */
export function useStaggeredWindow(
  id: string,
  start: number,
  end: number,
  staggerMs: number,
): { start: number; end: number } {
  const [applied, setApplied] = useState({ start, end });
  const immediate = staggerMs <= 0;
  if (immediate && (applied.start !== start || applied.end !== end)) setApplied({ start, end });
  useEffect(() => {
    if (immediate || (applied.start === start && applied.end === end)) return;
    const timer = setTimeout(() => setApplied({ start, end }), staggerOffsetMs(id, staggerMs));
    return () => clearTimeout(timer);
  }, [id, start, end, staggerMs, immediate, applied.start, applied.end]);
  return immediate ? { start, end } : applied;
}
