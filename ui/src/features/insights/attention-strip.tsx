"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowDown } from "lucide-react";
import { useDashboardTimeZone } from "./dashboard-time-zone";
import { newestSampleAt, useAttentionPublisher, useWidgetAttentions, type WidgetAttentionEntry } from "./attention-store";
import { StatusChip } from "./status-chip";
import { ATTENTION_REASONS, reduceAttention, type AttentionReason } from "./widget-attention";
import type { StatusLevel } from "./status";
import styles from "./attention-strip.module.css";

/** How long a chip's outline stays on its tile, in milliseconds. */
const OUTLINE_MS = 1600;
/** Counts settle before they are announced, so a burst of tiles loading is one announcement. */
const ANNOUNCE_DELAY_MS = 1000;
/** How long a notice (a reveal or an unreachable tile) stays on screen. */
const NOTICE_MS = 4000;

/** The glyph each reason draws. Failed and stale mean the current state is not known, so they use the unknown mark. */
const REASON_STATUS: Record<AttentionReason, StatusLevel> = { critical: "critical", warning: "warning", failed: "unknown", stale: "unknown" };

/** The rollup for one dashboard, with the same counting rule query_dashboard applies (reduceAttention). */
export interface AttentionSummary {
  /** Widgets the dashboard lists. */
  widgets: number;
  checked: number;
  /** Listed widgets with no result yet: never queried, still loading, or waiting for an offscreen tile. Not failed or empty. */
  notLoaded: number;
  counts: Record<AttentionReason, number>;
  /** Each reason's widget ids, in the order the dashboard lists them. */
  listed: Record<AttentionReason, string[]>;
  /** The oldest settle among loaded widgets: every loaded tile is at least this recent. */
  oldestCompletedAt?: number;
  /** The newest displayed sample among loaded widgets. */
  newestSampleAt?: number;
}

/**
 * Counts a dashboard's attention. Each listed widget is counted once under its most severe reason. A widget with no
 * published facts, or whose result is still pending, is not loaded and unchecked. Entries for widgets the dashboard
 * no longer lists are ignored.
 */
export function summarizeAttention(ids: readonly string[], entries: readonly WidgetAttentionEntry[]): AttentionSummary {
  const listed = new Set(ids);
  const current = entries.filter((entry) => listed.has(entry.widgetId));
  const rollup = reduceAttention(current.map((entry) => ({ id: entry.widgetId, ...entry.facts })));
  const byReason: Record<AttentionReason, string[]> = { critical: [], warning: [], failed: [], stale: [] };
  for (const id of ids) {
    const reason = rollup.attention[id];
    if (reason) byReason[reason].push(id);
  }
  const byId = new Map(current.map((entry) => [entry.widgetId, entry]));
  const notLoaded = ids.filter((id) => {
    const entry = byId.get(id);
    return !entry || (entry.facts.failure === "none" && entry.facts.signal === "pending");
  }).length;
  const settled = current.flatMap((entry) => (entry.completedAt === undefined ? [] : [entry.completedAt]));
  return {
    widgets: ids.length,
    checked: rollup.checked,
    notLoaded,
    counts: { critical: rollup.critical, warning: rollup.warning, failed: rollup.failed, stale: rollup.stale },
    listed: byReason,
    oldestCompletedAt: settled.length ? Math.min(...settled) : undefined,
    newestSampleAt: newestSampleAt(current),
  };
}

/** Plain-word age for the freshness line: "12 s ago", "11 min ago", "2 h ago". */
export function formatAge(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The dashboard's refresh state: a fixed window never refreshes, otherwise the author's interval applies. */
export type AutoRefresh = { mode: "fixed" } | { mode: "off" } | { mode: "every"; seconds: number };

/** The toolbar's wording: seconds under a minute, then whole minutes. */
export function refreshLabel(refresh: AutoRefresh): string {
  if (refresh.mode === "fixed") return "Paused for a fixed window";
  if (refresh.mode === "off") return "Auto refresh off";
  return refresh.seconds < 60 ? `Refreshes every ${refresh.seconds} s` : `Refreshes every ${refresh.seconds / 60}m`;
}

/** The polite announcement for the problem counts. It never calls the dashboard healthy or says nothing is wrong. */
export function announcementFor(counts: Record<AttentionReason, number>, notLoaded = 0): string {
  const parts = ATTENTION_REASONS.flatMap((reason) => (counts[reason] ? [`${counts[reason]} ${reason}`] : []));
  if (parts.length) return `${parts.join(", ")}.`;
  return notLoaded ? "Nothing flagged so far." : "Nothing flagged.";
}

function reducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.motion === "reduced") return true;
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The space a keyboard-focused chip keeps from the row's edges, so it is never flush with them. */
const CHIP_EDGE_MARGIN = 8;

/**
 * Scrolls the chip row sideways so a keyboard-focused chip is visible with a margin at each edge. Mouse focus is left
 * alone: a pointer press should not move the row. Browsers do not reliably scroll a focused element inside this row, so
 * the row is adjusted from the rects; rects are zero outside a layout engine, so tests are unaffected.
 */
function keepInRow(chip: HTMLElement) {
  let keyboard = false;
  try { keyboard = chip.matches(":focus-visible"); } catch { keyboard = false; }
  const row = chip.parentElement;
  if (!keyboard || !row || row.scrollWidth <= row.clientWidth) return;
  const element = chip.getBoundingClientRect();
  const track = row.getBoundingClientRect();
  if (element.left < track.left + CHIP_EDGE_MARGIN) row.scrollLeft -= track.left + CHIP_EDGE_MARGIN - element.left;
  else if (element.right > track.right - CHIP_EDGE_MARGIN) row.scrollLeft += element.right - (track.right - CHIP_EDGE_MARGIN);
}

function tileElement(scope: HTMLElement | null, widgetId: string): HTMLElement | undefined {
  return Array.from(scope?.querySelectorAll<HTMLElement>("article[data-widget-id]") ?? []).find((element) => element.dataset.widgetId === widgetId);
}

/** A clock that ticks once a second while something has settled, so the age stays current. */
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    // A tick that lags the first settle reads as "just now": formatAge clamps an age below zero.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * The attention strip above the dashboard's widgets: how fresh the loaded results are, the newest sample time once for
 * the whole dashboard, the auto-refresh state, the problem counts as chips that step through their widgets, and how
 * many widgets are checked or not loaded yet. It reads the canvas's attention store, so it must render inside the
 * provider. Its height is reserved (the canvas sets the layout), so counts and ages never move the widgets below.
 */
export function AttentionStrip({ widgets, scopeRef, autoRefresh }: {
  /** The dashboard's widgets in the order they are shown. */
  widgets: readonly { id: string }[];
  /** The canvas element whose tiles the chips scroll to. */
  scopeRef: RefObject<HTMLElement | null>;
  autoRefresh: AutoRefresh;
}) {
  const entries = useWidgetAttentions();
  const store = useAttentionPublisher();
  const timeZone = useDashboardTimeZone();
  const idsKey = widgets.map((widget) => widget.id).join("\n");
  const ids = useMemo(() => (idsKey ? idsKey.split("\n") : []), [idsKey]);
  useEffect(() => { store.prune(ids); }, [store, ids]);

  const summary = useMemo(() => summarizeAttention(ids, entries), [ids, entries]);
  const { counts, checked, notLoaded, oldestCompletedAt, newestSampleAt: newestSample } = summary;
  const now = useClock(oldestCompletedAt !== undefined);

  // The polite region changes only when the problem counts change, and then only after they have settled. It starts
  // empty; the mount state is the baseline, so every later change, including a dashboard's first results, is announced.
  const signature = ATTENTION_REASONS.map((reason) => counts[reason]).join(":");
  const announcement = announcementFor(counts, notLoaded);
  const [announced, setAnnounced] = useState("");
  const announcedSignature = useRef(signature);
  useEffect(() => {
    if (signature === announcedSignature.current) return;
    const timer = setTimeout(() => {
      announcedSignature.current = signature;
      setAnnounced(announcement);
    }, ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [signature, announcement]);

  // Each chip remembers which of its widgets it showed last, so the next activation shows the next one.
  const [cursor, setCursor] = useState<Partial<Record<AttentionReason, number>>>({});
  const [notice, setNotice] = useState("");
  const outlines = useRef(new Map<HTMLElement, number>());
  const sectionRef = useRef<HTMLElement>(null);
  // The chip that had focus, so focus can move to a stable element if that chip disappears.
  const focusedReason = useRef<AttentionReason | undefined>(undefined);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const pending = outlines.current;
    return () => {
      for (const [element, timer] of pending) {
        clearTimeout(timer);
        element.removeAttribute("data-attention-target");
      }
      pending.clear();
    };
  }, []);

  const flagged = ATTENTION_REASONS.filter((reason) => counts[reason] > 0);
  // A chip that was focused and is gone leaves focus on the body. Move it to the strip, which is always there.
  useEffect(() => {
    const reason = focusedReason.current;
    if (!reason || flagged.includes(reason)) return;
    focusedReason.current = undefined;
    if (document.activeElement === document.body || document.activeElement === null) sectionRef.current?.focus();
  });

  function reveal(reason: AttentionReason) {
    const listed = summary.listed[reason];
    if (!listed.length) return;
    const index = ((cursor[reason] ?? -1) + 1) % listed.length;
    setCursor((current) => ({ ...current, [reason]: index }));
    const widgetId = listed[index];
    const title = entries.find((entry) => entry.widgetId === widgetId)?.title ?? widgetId;
    const element = tileElement(scopeRef.current, widgetId);
    if (!element) {
      setNotice(`${title} is not on screen.`);
      return;
    }
    setNotice(`Showing ${title}, ${index + 1} of ${listed.length}.`);
    element.scrollIntoView?.({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    const previous = outlines.current.get(element);
    if (previous !== undefined) clearTimeout(previous);
    element.setAttribute("data-attention-target", "");
    outlines.current.set(element, window.setTimeout(() => {
      element.removeAttribute("data-attention-target");
      outlines.current.delete(element);
    }, OUTLINE_MS));
  }

  if (!ids.length) return null;
  const age = oldestCompletedAt === undefined ? undefined : formatAge(now - oldestCompletedAt);
  const sampleTime = newestSample === undefined ? undefined : new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone, timeZoneName: "short" }).format(new Date(newestSample));
  const titleOf = (widgetId: string) => entries.find((entry) => entry.widgetId === widgetId)?.title ?? widgetId;
  const ageText = age === undefined ? (notLoaded ? "Loading results" : "No results yet") : `Updated ${age}`;
  const sampleText = sampleTime === undefined ? undefined : `Newest sample ${sampleTime}`;
  const refreshText = refreshLabel(autoRefresh);
  // The full time text sits in a title as well, since the visible text is cut with an ellipsis when it does not fit.
  const timeText = [ageText, sampleText, refreshText].filter(Boolean).join(" · ");
  // Counts are one nowrap item, with the separator in its text, so they read as one phrase at every width.
  const countsText = `${checked} of ${summary.widgets} checked${notLoaded > 0 ? ` · ${notLoaded} not loaded yet` : ""}`;
  return (
    <section ref={sectionRef} tabIndex={-1} aria-label="Dashboard attention" className={styles.strip} data-attention-strip="">
      <div className={styles.text} title={timeText}>
        <span className={styles.age} data-freshness={oldestCompletedAt === undefined ? "none" : "settled"}>{ageText}</span>
        {sampleText && <span className={styles.sample}>{sampleText}</span>}
        <span className={styles.refresh}>{refreshText}</span>
      </div>
      <div className={styles.chips}>
        {!flagged.length && <span className={styles.clear}>{notLoaded ? "Nothing flagged so far" : "Nothing flagged"}</span>}
        {flagged.map((reason) => {
          const label = `${counts[reason]} ${reason}`;
          const shown = cursor[reason];
          const position = shown === undefined ? undefined : shown % summary.listed[reason].length;
          const first = summary.listed[reason][0];
          return (
            <button
              key={reason}
              type="button"
              className={styles.chip}
              data-reason={reason}
              aria-label={position === undefined
                ? `${label}: show first ${reason} widget, ${titleOf(first)}`
                : `${label}: showing ${titleOf(summary.listed[reason][position])}, ${position + 1} of ${counts[reason]}; activate for the next`}
              onFocus={(event) => { focusedReason.current = reason; keepInRow(event.currentTarget); }}
              onClick={() => reveal(reason)}
            >
              <StatusChip status={REASON_STATUS[reason]} label={label} />
              <ArrowDown className={styles.chipArrow} size={12} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <p className={styles.counts}>{countsText}</p>
      {/* Polite regions without the status role, so they do not join other status messages on the page. */}
      <p aria-live="polite" aria-atomic="true" className={styles.srOnly}>{announced}</p>
      <p aria-live="polite" aria-atomic="true" className={styles.notice} data-notice="">{notice}</p>
    </section>
  );
}
