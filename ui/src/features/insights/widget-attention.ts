import { createContext, useContext } from "react";
import { latestPoint, sampleCadence, type Point } from "./chart-data";
import { breachSummary, timeSeriesBreaches, type BreachLevel, type BreachLevelSummary } from "./breaches";
import { thresholdForValue } from "./chart-renderer-shared";
import type { QueryResult, Threshold, Widget } from "./schema";
import { validTimestamp } from "./widget-context";

/*
 * Dashboard attention, the UI port of internal/insights/dashboard_attention.go. The reducer below is the same rule
 * over the same facts, and docs/design/insights/conformance/attention.json is the shared contract: the vitest suite
 * runs those cases through reduceAttention. Only author-declared statuses count, and nothing here infers health.
 *
 * Split in two. extractAttentionFacts reads one widget's result into facts, using the series caps the Go side pins
 * (dashboard_facts.go) and the breach rules of breaches.ts. reduceAttention is the pure rule over facts.
 */

export type AttentionFailure = "none" | "planning" | "provider";
/** The signal a widget's data reduces to. "pending" is UI-only: the tile has no result yet. */
export type AttentionSignal = "ok" | "partial" | "empty" | "error" | "none" | "pending";
export type FreshnessState = "fresh" | "stale" | "no_threshold" | "unknown";

/** The facts attention reads for one widget, in the shape the shared conformance cases use. */
export interface AttentionFacts {
  failure: AttentionFailure;
  signal: AttentionSignal;
  /** The band that applies: a stat's displayed value, or a multi-series widget's worst drawn band. */
  threshold: { state: "matched" | "unknown"; status: string } | null;
  /** Breaches of a time series within its window, per level. */
  breaches: { summary: { level: BreachLevel; intervals: number; samples: number }[] } | null;
  freshness: FreshnessState | null;
}

/** The reasons a widget needs attention, most severe first. */
export const ATTENTION_REASONS = ["critical", "warning", "failed", "stale"] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** A tile's state: its reason when it needs attention, otherwise what its data allows. */
export type AttentionState = AttentionReason | "partial" | "empty" | "ok" | "pending";

/** The reducer's rollup, with the field names of the Go DashboardAttention output. */
export interface AttentionRollup {
  widgets: number;
  checked: number;
  critical: number;
  warning: number;
  failed: number;
  stale: number;
  attention: Record<string, AttentionReason>;
}

/** The reason a widget's facts give, or empty when none applies. Critical outranks warning, then failed, then stale. */
export function attentionReason(facts: AttentionFacts): AttentionReason | "" {
  const declares = (level: BreachLevel) =>
    (facts.threshold?.state === "matched" && facts.threshold.status === level) ||
    (facts.breaches?.summary.some((entry) => entry.level === level && (entry.intervals > 0 || entry.samples > 0)) ?? false);
  if (declares("critical")) return "critical";
  if (declares("warning")) return "warning";
  if (facts.failure !== "none") return "failed";
  if (facts.freshness === "stale") return "stale";
  return "";
}

/** The pure rule: each widget is counted once under its reason, and checked widgets have no failure and an ok signal. */
export function reduceAttention(widgets: readonly ({ id: string } & AttentionFacts)[]): AttentionRollup {
  const rollup: AttentionRollup = { widgets: widgets.length, checked: 0, critical: 0, warning: 0, failed: 0, stale: 0, attention: {} };
  for (const widget of widgets) {
    if (widget.failure === "none" && widget.signal === "ok") rollup.checked++;
    const reason = attentionReason(widget);
    if (!reason) continue;
    rollup.attention[widget.id] = reason;
    rollup[reason]++;
  }
  return rollup;
}

/** The tile's state from its facts: the reason first, then what the data allows. */
export function attentionState(facts: AttentionFacts): AttentionState {
  const reason = attentionReason(facts);
  if (reason) return reason;
  switch (facts.signal) {
    case "ok": return "ok";
    case "partial": return "partial";
    case "empty": return "empty";
    case "pending": return "pending";
    default: return "failed";
  }
}

/** The series caps the Go side pins to the UI (dashboard_facts.go): how many leading series each band widget draws. */
const HEATMAP_MAX_ROWS = 100;
const GAUGE_DEFAULT_MAX_SERIES = 6;
const STATUS_HISTORY_DEFAULT_MAX_SERIES = 12;
const STATUS_GRID_DEFAULT_MAX_SERIES = 512;
/** How many series a time series evaluates for breaches (breaches.go maxBreachSeries). */
const BREACH_SERIES_CAP = 12;

const STATUS_RANK: Record<string, number> = { critical: 4, warning: 3, unknown: 2, info: 1, ok: 0 };

type AttentionWidget = Pick<Widget, "type" | "options"> & { pluginId?: string; config?: unknown };

function optionalNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/** How many leading series a multi-series band widget draws, from its config. */
function drawnSeriesCap(widget: AttentionWidget): number {
  const config = (widget.config ?? {}) as { seriesMode?: unknown; maxSeries?: unknown };
  if (widget.type === "heatmap") return HEATMAP_MAX_ROWS;
  if (widget.pluginId === "threshold-gauge") return config.seriesMode === "all" ? optionalNumber(config.maxSeries, GAUGE_DEFAULT_MAX_SERIES) : 1;
  if (widget.pluginId === "status-history") return optionalNumber(config.maxSeries, STATUS_HISTORY_DEFAULT_MAX_SERIES);
  return optionalNumber(config.maxSeries, STATUS_GRID_DEFAULT_MAX_SERIES);
}

function isMultiSeriesBandWidget(widget: AttentionWidget): boolean {
  return widget.type === "heatmap" || (widget.type === "plugin" && (widget.pluginId === "threshold-gauge" || widget.pluginId === "status-grid" || widget.pluginId === "status-history"));
}

/** The first series with a valid finite observation, and its latest valid point, as the stat draws it. */
function displayedSample(result: QueryResult): { value: number; timestamp: number } | undefined {
  for (const series of result.series ?? []) {
    const point = latestPoint(series);
    if (point) return { value: point.value, timestamp: point.timestamp };
  }
  return undefined;
}

/** Whether the result holds anything the tile can show: an observation, a trace or a record row. */
function hasUsableData(result: QueryResult): boolean {
  const observed = (result.series ?? []).some((series) => series.points.some((point) => validTimestamp(point.timestamp) && Number.isFinite(point.value)));
  return observed || (result.traces?.length ?? 0) > 0 || (result.records?.rows.length ?? 0) > 0;
}

/**
 * The worst declared band across the drawn series. Each series sets a band from its latest recorded sample; a missing
 * latest sample sets none. The most severe status wins, and the lowest series position wins a tie.
 */
function worstSeriesStatus(series: readonly { points: readonly Point[] }[], thresholds: readonly Threshold[]): string | undefined {
  let worst: string | undefined;
  let worstRank = 0;
  let found = false;
  for (const entry of series) {
    let latest: Point | undefined;
    for (const point of entry.points) {
      if (validTimestamp(point.timestamp) && (!latest || point.timestamp >= latest.timestamp)) latest = point;
    }
    if (!latest || typeof latest.value !== "number" || !Number.isFinite(latest.value)) continue;
    const band = thresholdForValue(latest.value, thresholds);
    const status = band?.status ?? "";
    const rank = STATUS_RANK[status] ?? -1;
    if (!found || rank > worstRank) {
      worst = status;
      worstRank = rank;
      found = true;
    }
  }
  return worst;
}

/** The time-series freshness limit in effect: an explicit staleAfterSeconds, or twice the longest cadence of the newest series. */
function timeseriesLimitMs(series: QueryResult["series"], at: number, explicitSeconds: number | undefined): number | undefined {
  if (explicitSeconds !== undefined) return explicitSeconds * 1000;
  let cadence: number | undefined;
  for (const entry of series ?? []) {
    const last = latestPoint(entry);
    if (!last || last.timestamp !== at) continue;
    const step = sampleCadence(entry.points);
    if (step !== null) cadence = Math.max(cadence ?? 0, step);
  }
  return cadence === undefined ? undefined : 2 * cadence;
}

/** The inputs a tile has for its attention verdict. */
export interface AttentionSource {
  /** The query's result, when the tile holds one. */
  result?: QueryResult;
  /** A failed read, an unconfigured provider, or a source that cannot load. A failed read has no band. */
  failure?: Exclude<AttentionFailure, "none">;
  /** The range end in Unix milliseconds. Without it a sample cannot be aged. */
  rangeEnd?: number;
}

/** The verdict for one widget, with the matched band and age the stat renders from. */
export interface WidgetAttention {
  state: AttentionState;
  reason: AttentionReason | "";
  facts: AttentionFacts;
  /** The threshold band that matched a stat's displayed value. */
  band?: Threshold;
  /** Age of a stat's displayed sample at the range end, in seconds. */
  ageSeconds?: number;
  /** Whether the displayed sample is older than the author's staleAfterSeconds. */
  stale: boolean;
  /** Whether the provider's response was truncated. A stat shows this as a chip, not a block notice. */
  partial: boolean;
}

/** One widget's facts from its source outcome, as the Go side reads them from the executed signal. */
export function extractAttentionFacts(widget: AttentionWidget, source: AttentionSource): { facts: AttentionFacts; band?: Threshold; ageSeconds?: number } {
  const thresholds = widget.options?.thresholds;
  const notJudged = { threshold: null, breaches: null, freshness: null };
  if (source.failure) {
    return { facts: { failure: source.failure, signal: source.failure === "planning" ? "none" : "error", ...notJudged } };
  }
  const result = source.result;
  if (!result) return { facts: { failure: "none", signal: "pending", ...notJudged } };
  const truncated = result.truncated === true || result.records?.truncated === true;
  const signal: AttentionSignal = hasUsableData(result) ? "ok" : truncated ? "partial" : "empty";

  if (widget.type === "stat") {
    const displayed = displayedSample(result);
    const band = displayed && thresholds?.length ? thresholdForValue(displayed.value, thresholds) : undefined;
    const threshold = thresholds?.length ? (band ? { state: "matched" as const, status: band.status ?? "" } : { state: "unknown" as const, status: "" }) : null;
    let freshness: FreshnessState | null = "no_threshold";
    let ageSeconds: number | undefined;
    if (displayed && source.rangeEnd !== undefined && Number.isFinite(source.rangeEnd)) {
      ageSeconds = Math.max(0, (source.rangeEnd - displayed.timestamp) / 1000);
    }
    const explicit = widget.options?.staleAfterSeconds;
    if (!displayed) freshness = "unknown";
    else if (explicit === undefined) freshness = "no_threshold";
    else if (ageSeconds === undefined) freshness = "unknown";
    else freshness = ageSeconds * 1000 > explicit * 1000 ? "stale" : "fresh";
    return {
      facts: { failure: "none", signal, threshold, breaches: null, freshness },
      band,
      ageSeconds,
    };
  }

  if (isMultiSeriesBandWidget(widget)) {
    const hasStatus = thresholds?.some((threshold) => threshold.status !== undefined) ?? false;
    let threshold: AttentionFacts["threshold"] = null;
    if (hasStatus && thresholds) {
      const worst = worstSeriesStatus((result.series ?? []).slice(0, drawnSeriesCap(widget)), thresholds);
      threshold = worst === undefined ? { state: "unknown", status: "" } : { state: "matched", status: worst };
    }
    return { facts: { failure: "none", signal, threshold, breaches: null, freshness: "no_threshold" } };
  }

  if (widget.type === "timeseries") {
    const hasBreach = thresholds?.some((threshold) => threshold.status === "warning" || threshold.status === "critical") ?? false;
    let breaches: AttentionFacts["breaches"] = null;
    if (hasBreach && thresholds) {
      const evaluated = (result.series ?? []).slice(0, BREACH_SERIES_CAP);
      const intervals = timeSeriesBreaches(evaluated.map((entry) => ({ points: entry.points, step: sampleCadence(entry.points) })), thresholds);
      const summary: BreachLevelSummary[] = breachSummary(intervals);
      breaches = { summary };
    }
    let freshness: FreshnessState = "no_threshold";
    if (!truncated && source.rangeEnd !== undefined && Number.isFinite(source.rangeEnd)) {
      const latest = (result.series ?? []).flatMap((entry) => { const point = latestPoint(entry); return point ? [point.timestamp] : []; });
      if (!latest.length) freshness = "unknown";
      else {
        const at = Math.max(...latest);
        const limit = timeseriesLimitMs(result.series, at, widget.options?.staleAfterSeconds);
        if (limit !== undefined) freshness = source.rangeEnd - at > limit ? "stale" : "fresh";
      }
    }
    return { facts: { failure: "none", signal, threshold: null, breaches, freshness } };
  }

  return { facts: { failure: "none", signal, threshold: null, breaches: null, freshness: "no_threshold" } };
}

/** A tile's verdict from its source outcome. */
export function widgetAttention(widget: AttentionWidget, source: AttentionSource): WidgetAttention {
  const extracted = extractAttentionFacts(widget, source);
  return {
    state: attentionState(extracted.facts),
    reason: attentionReason(extracted.facts),
    facts: extracted.facts,
    band: extracted.band,
    ageSeconds: extracted.ageSeconds,
    stale: extracted.facts.freshness === "stale",
    partial: source.result?.truncated === true || source.result?.records?.truncated === true,
  };
}

/** The state alone, for callers that need only the verdict. A thrown or failed read is passed as the error. */
export function evaluateWidgetAttention(widget: AttentionWidget, result: QueryResult | undefined, error: unknown, rangeEnd: number | undefined): AttentionState {
  return widgetAttention(widget, { result, failure: error ? "provider" : undefined, rangeEnd }).state;
}

/** Whether a state draws the rail and a status chip. */
export function isAttentionLevel(state: AttentionState): state is "critical" | "warning" {
  return state === "critical" || state === "warning";
}

/**
 * The verdict a canvas tile computed for its widget. Renderers under that tile read it instead of evaluating again.
 * Embedded renderers (tooltips) do not inherit it, because they show a different widget.
 */
export const WidgetAttentionContext = createContext<WidgetAttention | undefined>(undefined);
export function useWidgetAttentionContext() {
  return useContext(WidgetAttentionContext);
}
