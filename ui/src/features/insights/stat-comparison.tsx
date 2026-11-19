"use client";

import { createContext, useContext, useLayoutEffect, type RefObject } from "react";
import { formatChange, type ComparisonWindow, type StatComparison } from "./time-window";
import styles from "./charts.module.css";

/**
 * What a stat's tile knows about its comparison with an earlier window. The tile fetches the earlier window and computes
 * the outcome; the renderer only shows it. An embedded stat, or a stat outside a tile, has no context and shows no change.
 */
export interface StatComparisonState {
  window: ComparisonWindow;
  /** Which direction reads as better. Unset is neutral: the change is shown with no verdict. */
  good?: "up" | "down";
  /** Length of the current range in milliseconds. It names the earlier window for "previous". */
  span: number;
  /** The stat's unit and decimals, so the change reads like the reading. */
  unit: string;
  decimals?: number;
  /** The outcome, once the earlier window has loaded. Undefined while it loads or when it failed. */
  outcome?: StatComparison;
  /** The earlier window could not be fetched. The message is for the title only. */
  error?: string;
}

export const StatComparisonContext = createContext<StatComparisonState | undefined>(undefined);

export function useStatComparison(): StatComparisonState | undefined {
  return useContext(StatComparisonContext);
}

/** A duration as a short phrase: "1 h", "15 min", "7 d". */
export function durationPhrase(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  const [value, unit] = seconds < 60 ? [seconds, "s"] : seconds < 3600 ? [seconds / 60, "min"] : seconds < 86_400 ? [seconds / 3600, "h"] : [seconds / 86_400, "d"];
  return `${Number(value.toFixed(1))} ${unit}`;
}

/** The chip's label names the earlier window and what it is compared with, not a generic "previous period". */
export function comparisonLabel(window: ComparisonWindow, span: number): string {
  const length = window === "previous" ? durationPhrase(span) : window === "1d" ? "1 d" : "7 d";
  return `vs ${length} earlier`;
}

const UNAVAILABLE_COPY: Record<Exclude<StatComparison, { state: "ok" | "partial" }>["reason"], string> = {
  no_previous_range: "Earlier period unavailable",
  no_current_sample: "No current sample",
  no_prior_sample: "No earlier sample",
  ambiguous_series: "Earlier series ambiguous",
};

/**
 * The change beside a stat's reading. It is information, not status: it never takes a band colour, and it names
 * "better" or "worse" only when the author set which direction is better. Unavailable and partial states say so in words.
 */
export function StatDelta({ state, formatTime }: { state: StatComparisonState; formatTime: (timestamp: number) => string }) {
  const label = comparisonLabel(state.window, state.span);
  const outcome = state.outcome;
  if (!outcome) {
    if (state.error) return <span className={styles.statDelta} data-stat-delta="error" title={state.error}><span className={styles.statSrOnly} data-stat-spoken="">{`${label}: earlier period unavailable`}</span><span aria-hidden="true">Earlier period unavailable</span></span>;
    // Reserved while the earlier window loads: no shimmer and no zero, so the reading does not move when it arrives.
    return <span className={styles.statDeltaPending} data-stat-delta="loading" aria-hidden="true" />;
  }
  if (outcome.state === "unavailable") {
    const copy = UNAVAILABLE_COPY[outcome.reason];
    return <span className={styles.statDelta} data-stat-delta="unavailable" data-stat-delta-reason={outcome.reason} title={`${label}: ${copy}`}><span className={styles.statSrOnly} data-stat-spoken="">{`${label}: ${copy}`}</span><span aria-hidden="true">{copy}</span></span>;
  }
  const change = formatChange(outcome.delta, outcome.percent, state.unit, state.decimals, outcome.current?.value);
  const glyph = change.direction === "up" ? "▲" : change.direction === "down" ? "▼" : "";
  // The verdict is a word in ink, never a colour: "better" or "worse" only when the author declared a good direction.
  const verdict = state.good === undefined ? undefined : change.direction === "flat" ? "unchanged" : change.direction === state.good ? "better" : "worse";
  const partial = outcome.state === "partial";
  // The spoken sentence carries the whole change; the visible pieces are hidden from assistive tech so it is read once.
  const spoken = `${label}: ${change.text}${verdict ? `, ${verdict}` : ""}${partial ? ", partial" : ""}`;
  const title = `${change.exactTitle}${verdict ? `, ${verdict}` : ""} · earlier sample ${formatTime(outcome.baseline.timestamp)}${partial ? " · earlier response partial" : ""}`;
  return (
    <span className={styles.statDelta} data-stat-delta={change.direction} data-stat-delta-state={outcome.state} title={title}>
      <span className={styles.statSrOnly} data-stat-spoken="">{spoken}</span>
      {glyph && <span className={styles.statDeltaGlyph} aria-hidden="true">{glyph}</span>}
      <span className={styles.statDeltaValue} aria-hidden="true">{change.text}</span>
      {verdict && <span className={styles.statDeltaLabel} data-stat-delta-verdict={verdict} aria-hidden="true">{verdict}</span>}
      <span className={styles.statDeltaLabel} aria-hidden="true">{label}</span>
      {partial && <span className={styles.statDeltaLabel} aria-hidden="true">partial</span>}
    </span>
  );
}

/**
 * Keeps the change out of view when it makes its stat overflow. A change that fits is drawn; one that would clip, scroll
 * or push the reading past its card is not drawn. Its words move to the reading's title instead, where a pointer can reach
 * them, and assistive technology keeps the change it already had. The overflow is read on the stat's own box, with the change
 * drawn and then hidden, in the same frame, so nothing paints between the two. It runs after every render, so a new change
 * or reading is judged as soon as it is laid out.
 */
export function useStatDeltaFit(host: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const fit = () => {
      // The reading's own title is rendered by React as data-exact-title; the fit only adds the hidden change to it.
      const value = element.querySelector<HTMLElement>("[data-exact-title]");
      const exact = value?.dataset.exactTitle;
      const setValueTitle = (title: string | undefined) => {
        if (value && title !== undefined && value.title !== title) value.title = title;
      };
      const delta = element.querySelector<HTMLElement>("[data-stat-delta]:not([data-stat-delta='loading'])");
      delta?.removeAttribute("data-stat-delta-fit");
      setValueTitle(exact);
      if (!delta) return;
      const sparkline = element.querySelector<HTMLElement>("[data-stat-sparkline]");
      const overflows = () => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
      // A change drawn over a side sparkline's lane collides with the trend, even though the card itself does not overflow.
      const overSparkline = () => {
        if (!sparkline || sparkline.closest("[data-sparkline-placement='side']") === null) return false;
        const a = delta.getBoundingClientRect(), b = sparkline.getBoundingClientRect();
        return a.width > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      };
      const collides = () => overflows() || overSparkline();
      if (collides()) {
        // Hidden, the change may still be the cause; when the stat overflows regardless, nothing here is ours to hide.
        delta.setAttribute("data-stat-delta-fit", "hidden");
        if (overflows()) delta.removeAttribute("data-stat-delta-fit");
      }
      // A change is not drawn when the fit hid it or its container's rule collapsed it to a 1 px box. Its words then move to the reading.
      const drawn = !delta.hasAttribute("data-stat-delta-fit") && delta.getBoundingClientRect().width > 1;
      const spoken = delta.getAttribute("title");
      if (!drawn && exact !== undefined && spoken) setValueTitle(`${exact} · ${spoken}`);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  });
}
