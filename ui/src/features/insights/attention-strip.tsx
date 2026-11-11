"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useAttentionPublisher, useWidgetAttentions, type WidgetAttentionEntry } from "./attention-store";
import { StatusChip } from "./status-chip";
import { ATTENTION_REASONS, reduceAttention, type AttentionReason } from "./widget-attention";
import type { StatusLevel } from "./status";
import styles from "./attention-strip.module.css";

/** How long a chip's outline stays on its tile, in milliseconds. */
const OUTLINE_MS = 1600;
/** Counts settle before they are announced, so a burst of tiles loading is one announcement. */
const ANNOUNCE_DELAY_MS = 1000;

/** The glyph each reason draws. Failed and stale mean the current state is not known, so they use the unknown mark. */
const REASON_STATUS: Record<AttentionReason, StatusLevel> = { critical: "critical", warning: "warning", failed: "unknown", stale: "unknown" };

/** The rollup for one dashboard, with the same counting rule query_dashboard applies (reduceAttention). */
export interface AttentionSummary {
  /** Widgets the dashboard lists. */
  widgets: number;
  checked: number;
  counts: Record<AttentionReason, number>;
  /** Each reason's widget ids, in the order the dashboard lists them. */
  listed: Record<AttentionReason, string[]>;
  /** Listed widgets whose tile is not mounted now (focus mode). Their last known state is counted. */
  lastKnown: number;
  /** The newest settled query among listed widgets, in Unix milliseconds. */
  completedAt?: number;
}

/**
 * Counts a dashboard's attention. Each listed widget is counted once under its most severe reason. A widget with no
 * published facts (not yet loaded, or never mounted) is unchecked. Entries for widgets the dashboard no longer lists
 * are ignored.
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
  const settled = current.flatMap((entry) => (entry.completedAt === undefined ? [] : [entry.completedAt]));
  return {
    widgets: ids.length,
    checked: rollup.checked,
    counts: { critical: rollup.critical, warning: rollup.warning, failed: rollup.failed, stale: rollup.stale },
    listed: byReason,
    lastKnown: current.filter((entry) => !entry.mounted).length,
    completedAt: settled.length ? Math.max(...settled) : undefined,
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

function refreshLabel(refresh: AutoRefresh): string {
  if (refresh.mode === "fixed") return "Paused for a fixed window";
  if (refresh.mode === "off") return "Auto refresh off";
  return `Refreshes every ${refresh.seconds} s`;
}

/** The polite announcement for the problem counts. Checked counts and ages are never announced. */
export function announcementFor(counts: Record<AttentionReason, number>): string {
  const parts = ATTENTION_REASONS.flatMap((reason) => (counts[reason] ? [`${counts[reason]} ${reason}`] : []));
  return parts.length ? `${parts.join(", ")}.` : "No attention needed.";
}

function reducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.motion === "reduced") return true;
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
 * The attention strip above the dashboard's widgets: the newest query age, the auto-refresh state, the problem counts
 * as chips that step through their widgets, and how many widgets are checked. It reads the canvas's attention store,
 * so it must render inside the provider. Its height is reserved so that counts and ages never move the widgets.
 */
export function AttentionStrip({ widgets, scopeRef, autoRefresh, inset = false }: {
  /** The dashboard's widgets in the order they are shown. */
  widgets: readonly { id: string }[];
  /** The canvas element whose tiles the chips scroll to. */
  scopeRef: RefObject<HTMLElement | null>;
  autoRefresh: AutoRefresh;
  /** Pads the strip when the canvas has no page padding of its own, as in focus mode. */
  inset?: boolean;
}) {
  const entries = useWidgetAttentions();
  const store = useAttentionPublisher();
  const idsKey = widgets.map((widget) => widget.id).join("\n");
  const ids = useMemo(() => (idsKey ? idsKey.split("\n") : []), [idsKey]);
  useEffect(() => { store.prune(ids); }, [store, ids]);

  const summary = useMemo(() => summarizeAttention(ids, entries), [ids, entries]);
  const { counts, checked, completedAt } = summary;
  const now = useClock(completedAt !== undefined);

  // The polite region changes only when the problem counts change, and then only after they have settled.
  const signature = ATTENTION_REASONS.map((reason) => counts[reason]).join(":");
  const announcement = announcementFor(counts);
  // Empty until the first change: the state a dashboard opens in is not news.
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

  const cursor = useRef(new Map<AttentionReason, number>());
  const outlines = useRef(new Map<HTMLElement, number>());
  const [hint, setHint] = useState("");
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

  function reveal(reason: AttentionReason) {
    const listed = summary.listed[reason];
    if (!listed.length) return;
    const index = ((cursor.current.get(reason) ?? -1) + 1) % listed.length;
    cursor.current.set(reason, index);
    const widgetId = listed[index];
    const element = tileElement(scopeRef.current, widgetId);
    if (!element) {
      const title = entries.find((entry) => entry.widgetId === widgetId)?.title ?? "That widget";
      setHint(`${title} is not on screen. Leave focus mode to see it.`);
      return;
    }
    setHint("");
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
  const age = completedAt === undefined ? undefined : formatAge(now - completedAt);
  const flagged = ATTENTION_REASONS.filter((reason) => counts[reason] > 0);
  const titleOf = (widgetId: string) => entries.find((entry) => entry.widgetId === widgetId)?.title ?? widgetId;
  return (
    <section aria-label="Dashboard attention" className={`${styles.strip}${inset ? ` ${styles.inset}` : ""}`} data-attention-strip="">
      <p className={styles.freshness} data-freshness={completedAt === undefined ? "none" : "settled"}>
        {age === undefined ? "Waiting for first results" : `Updated ${age}`}
        <span className={styles.refresh}> · {refreshLabel(autoRefresh)}</span>
      </p>
      <div className={styles.chips}>
        {!flagged.length && <span className={styles.clear}>No attention needed</span>}
        {flagged.map((reason) => {
          const label = `${counts[reason]} ${reason}`;
          return (
            <button
              key={reason}
              type="button"
              className={styles.chip}
              data-reason={reason}
              aria-label={`${label}: show next ${reason} widget (${titleOf(summary.listed[reason][0])} first)`}
              onClick={() => reveal(reason)}
            >
              <StatusChip status={REASON_STATUS[reason]} label={label} />
            </button>
          );
        })}
      </div>
      <p className={styles.counts}>
        {checked}/{summary.widgets} checked
        {summary.lastKnown > 0 && (
          <span className={styles.lastKnown} title="Widgets outside the focused view are counted at their last known state.">
            {" · "}{summary.lastKnown} last known
          </span>
        )}
      </p>
      {/* A polite live region without the status role, so it does not join other status messages on the page. */}
      <p aria-live="polite" aria-atomic="true" className={styles.srOnly}>{announced}</p>
      {hint && <p role="status" className={styles.hint}>{hint}</p>}
    </section>
  );
}
