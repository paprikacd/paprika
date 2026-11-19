"use client";

// Query-backed options for dashboard variables. This module must not import ./client:
// the caller injects the metadata and query loaders, so canvas and plugin files stay clean.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MAX_VARIABLE_VALUE_LENGTH,
  variableSourceDependencies,
  type DashboardQueryReference,
  type DashboardVariable,
  type QueryResult,
} from "./schema";
import { interpolateQuery, type VariableValues } from "./drilldown";

/** Values per variable after dedupe; a source may declare a lower limit. */
export const VARIABLE_VALUE_LIMIT = 100;
/** How long resolved values stay reusable within this browser session. */
export const VARIABLE_VALUE_TTL_MS = 30_000;
/** Resolved sources kept in the session cache; the least recently used is dropped first. */
export const VARIABLE_VALUE_CACHE_ENTRIES = 64;
/** Range start and end round to this many seconds so that refreshes reuse cached values. */
export const VARIABLE_RANGE_BUCKET_SECONDS = 60;

export interface VariableRange {
  start: number;
  end: number;
}

/** Metrics queries refuse more than 5000 points per series, so a source's step grows with its range. */
export const SOURCE_QUERY_MAX_POINTS = 300;

/** Step in seconds for a metrics saved-query source over [start, end]: at most SOURCE_QUERY_MAX_POINTS points, never below 1 s. */
export function sourceQueryStep(start: number, end: number): number {
  return Math.max(1, Math.ceil((end - start) / SOURCE_QUERY_MAX_POINTS));
}

export interface LabelValuesRequest {
  providerId: string;
  label: string;
  selector?: string;
  start: number;
  end: number;
  limit: number;
}

export interface SavedQueryValuesRequest {
  queryRef: DashboardQueryReference;
  field: string;
  start: number;
  end: number;
  /** The values of the variables the source reads, so the query runs at the values the plan was keyed on. */
  variables: VariableValues;
}

export interface VariableValueLoaders {
  /** Names the data scope, such as "live" or "example", so cached values never cross scopes. */
  scope: string;
  metadata(
    request: LabelValuesRequest,
    signal: AbortSignal,
  ): Promise<{ values: string[]; truncated?: boolean }>;
  query(request: SavedQueryValuesRequest, signal: AbortSignal): Promise<QueryResult>;
}

export interface VariableValueResult {
  values: string[];
  truncated: boolean;
}

export type VariableSourcePlan =
  | { state: "needs_variable"; parent: string }
  | { state: "invalid"; error: string }
  | {
      state: "fetch";
      /** Identifies the source and its parent values, and the range bucket. */
      key: string;
      /** Identifies the source and its parent values only. Two plans with one sourceKey differ only by range bucket. */
      sourceKey: string;
      run: (loaders: VariableValueLoaders, signal: AbortSignal) => Promise<VariableValueResult>;
    };

/** Dedupe, drop values the dashboard cannot hold, and cap at the source limit. */
export function normalizeVariableValues(raw: readonly string[], limit: number): VariableValueResult {
  const unique = [...new Set(raw)];
  const fitting = unique.filter((value) => value.length <= MAX_VARIABLE_VALUE_LENGTH);
  const truncated = fitting.length !== unique.length || fitting.length > limit;
  return { values: fitting.slice(0, limit), truncated };
}

/** Distinct non-empty values of one records column or one series label. Traces cannot supply values. */
export function variableValuesFromQuery(result: QueryResult, field: string): VariableValueResult {
  if (result.spans || result.traces) throw new Error("Trace results cannot supply variable values");
  if (result.records) {
    const index = result.records.columns.findIndex((column) => column.key === field);
    if (index < 0) throw new Error(`Column “${field}” is not in this saved query’s results`);
    const raw = result.records.rows.flatMap((row) => {
      const cell = row[index];
      if (typeof cell === "string" && cell !== "") return [cell];
      if (typeof cell === "number" && Number.isFinite(cell)) return [String(cell)];
      return [];
    });
    const capped = normalizeVariableValues(raw, VARIABLE_VALUE_LIMIT);
    return { values: capped.values, truncated: capped.truncated || Boolean(result.records.truncated || result.truncated) };
  }
  if (result.series?.length) {
    const labelled = result.series.filter((series) => Object.hasOwn(series.labels, field));
    if (!labelled.length) throw new Error(`Series have no label “${field}”`);
    const raw = labelled.map((series) => series.labels[field]).filter((value) => value !== "");
    const capped = normalizeVariableValues(raw, VARIABLE_VALUE_LIMIT);
    return { values: capped.values, truncated: capped.truncated || Boolean(result.truncated) };
  }
  return { values: [], truncated: Boolean(result.truncated) };
}

/**
 * Describes how a source variable resolves for the current parent values and range.
 * Undefined means the variable has no source.
 */
/**
 * The cache scope for variable values: the workspace kind and the signed-in principal. Values loaded for one principal
 * never serve another, while a token renewal for the same principal keeps them, so an open list does not empty.
 */
export function variableValueScope(example: boolean, principal: string | undefined): string {
  return `${example ? "example" : "live"}:${principal ?? "anonymous"}`;
}

export function planVariableSource(
  variable: DashboardVariable,
  values: VariableValues,
  range: VariableRange,
  scope: string,
): VariableSourcePlan | undefined {
  const source = variable.source;
  if (!source) return undefined;
  const dependencies = [...new Set(variableSourceDependencies(source))];
  const parent = dependencies.find((name) => !Object.hasOwn(values, name));
  if (parent !== undefined) return { state: "needs_variable", parent };
  const used: VariableValues = Object.fromEntries(dependencies.map((name) => [name, values[name]]));
  const bucket = [
    Math.floor(range.start / VARIABLE_RANGE_BUCKET_SECONDS),
    Math.floor(range.end / VARIABLE_RANGE_BUCKET_SECONDS),
  ];
  const sourceKey = JSON.stringify([scope, source, used]);
  const key = JSON.stringify([sourceKey, bucket]);
  const limit = source.limit ?? VARIABLE_VALUE_LIMIT;
  if (source.type === "labelValues") {
    let selector: string | undefined;
    try {
      selector = source.selector === undefined ? undefined : interpolateQuery(source.selector, used);
    } catch (cause) {
      return { state: "invalid", error: cause instanceof Error ? cause.message : "Invalid selector" };
    }
    const request = { providerId: source.providerId, label: source.label, selector };
    return {
      state: "fetch",
      key,
      sourceKey,
      run: async (loaders, signal) => {
        const response = await loaders.metadata({ ...request, start: range.start, end: range.end, limit }, signal);
        const capped = normalizeVariableValues(response.values, limit);
        return { values: capped.values, truncated: capped.truncated || Boolean(response.truncated) };
      },
    };
  }
  return {
    state: "fetch",
    key,
    sourceKey,
    run: async (loaders, signal) => {
      const result = await loaders.query(
        { queryRef: source.queryRef, field: source.field, start: range.start, end: range.end, variables: used },
        signal,
      );
      const extracted = variableValuesFromQuery(result, source.field);
      const capped = normalizeVariableValues(extracted.values, limit);
      return { values: capped.values, truncated: extracted.truncated || capped.truncated };
    },
  };
}

interface CacheEntry {
  value: VariableValueResult;
  storedAt: number;
}

export interface VariableValueCache {
  get(key: string): VariableValueResult | undefined;
  set(key: string, value: VariableValueResult): void;
  clear(): void;
}

/** A small LRU cache whose entries expire after the TTL, measured from when they were stored. */
export function createVariableValueCache(
  options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {},
): VariableValueCache {
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlMs ?? VARIABLE_VALUE_TTL_MS;
  const maxEntries = options.maxEntries ?? VARIABLE_VALUE_CACHE_ENTRIES;
  const entries = new Map<string, CacheEntry>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.storedAt >= ttl) {
        entries.delete(key);
        return undefined;
      }
      // Re-insert so that the most recently read entry is evicted last.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, storedAt: now() });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    clear() {
      entries.clear();
    },
  };
}

/** Shared by every dashboard view in this browser session. */
export const sessionVariableValueCache = createVariableValueCache();

export type VariableOptionsState = "idle" | "loading" | "ready" | "empty" | "failed" | "needs_variable" | "invalid";

export interface VariableOptionsSnapshot {
  state: VariableOptionsState;
  values: string[];
  truncated: boolean;
  /**
   * Set when the values are the previous range bucket's, shown while the current bucket loads. The source and its
   * parent values are unchanged; only the time window rolled over.
   */
  refreshing?: boolean;
  /** The parent variable a needs_variable state waits for. */
  parent?: string;
  /** Why the source cannot be planned, such as an invalid selector template. Retry does not help. */
  error?: string;
}

export interface VariableOptionsController {
  snapshot(name: string): VariableOptionsSnapshot | undefined;
  /** Start loading a source the first time its control opens; it then refetches when its inputs change. */
  activate(name: string): void;
  retry(name: string): void;
}

interface LoadEntry {
  key: string;
  sourceKey: string;
  state: "loading" | "ok" | "failed";
  /** The last values loaded for this source. Kept while a new range bucket loads, never across parent values. */
  result?: VariableValueResult;
  error?: string;
}

const IDLE: VariableOptionsSnapshot = { state: "idle", values: [], truncated: false };

/**
 * Resolves the query-backed options of every source variable that a viewer has opened.
 * Results are masked by source key, so a response for old parent values never shows.
 */
export function useVariableOptions({
  variables,
  values,
  range,
  loaders,
  cache = sessionVariableValueCache,
}: {
  variables: DashboardVariable[];
  values: VariableValues;
  range: VariableRange;
  loaders?: VariableValueLoaders;
  cache?: VariableValueCache;
}): VariableOptionsController {
  const scope = loaders?.scope ?? "none";
  const plans = new Map<string, VariableSourcePlan>();
  for (const variable of variables) {
    const plan = planVariableSource(variable, values, range, scope);
    if (plan) plans.set(variable.name, plan);
  }
  const [active, setActive] = useState<ReadonlySet<string>>(() => new Set());
  const [loaded, setLoaded] = useState<Record<string, LoadEntry>>({});
  const [attempt, setAttempt] = useState(0);
  // One request per source key, each with its own controller, so a retry or a key change on one source never
  // aborts another source's request.
  const inflight = useRef(new Map<string, { key: string; controller: AbortController }>());
  const latest = useRef({ plans, loaders, cache });
  // Layout effects run before the passive fetch effect below, so the fetch always reads this render's inputs.
  useLayoutEffect(() => {
    latest.current = { plans, loaders, cache };
  });
  // Once a viewer opens any source on the bar, every source on it resolves, so a dependent value that
  // its parent has just changed is marked from fresh values without another click.
  const resolving = active.size > 0;
  const pending = [...plans]
    .filter(([name, plan]) => plan.state === "fetch" && (resolving || active.has(name)))
    .map(([name, plan]) => [name, plan.state === "fetch" ? plan.key : ""] as const);
  const signature = JSON.stringify(pending);

  useEffect(() => {
    const { plans: current, loaders: source, cache: store } = latest.current;
    const names = JSON.parse(signature) as [string, string][];
    const wanted = new Set(names.map(([name]) => name));
    for (const [name, running] of inflight.current) {
      if (wanted.has(name)) continue;
      running.controller.abort();
      inflight.current.delete(name);
    }
    if (!source) return;
    for (const [name] of names) {
      const plan = current.get(name);
      if (!plan || plan.state !== "fetch") continue;
      const { key, sourceKey } = plan;
      const running = inflight.current.get(name);
      if (running && running.key === key && !running.controller.signal.aborted) continue;
      running?.controller.abort();
      inflight.current.delete(name);
      const hit = store.get(key);
      if (hit) {
        setLoaded((previous) => ({ ...previous, [name]: { key, sourceKey, state: "ok", result: hit } }));
        continue;
      }
      const controller = new AbortController();
      inflight.current.set(name, { key, controller });
      setLoaded((previous) => {
        // Keep the previous bucket's values for the same source while the new bucket loads.
        const before = previous[name];
        const kept = before?.sourceKey === sourceKey ? before.result : undefined;
        return { ...previous, [name]: { key, sourceKey, state: "loading", result: kept } };
      });
      plan.run(source, controller.signal).then(
        (result) => {
          if (inflight.current.get(name)?.controller !== controller) return;
          inflight.current.delete(name);
          store.set(key, result);
          setLoaded((previous) => ({ ...previous, [name]: { key, sourceKey, state: "ok", result } }));
        },
        (cause: unknown) => {
          if (inflight.current.get(name)?.controller !== controller) return;
          inflight.current.delete(name);
          setLoaded((previous) => ({
            ...previous,
            [name]: { key, sourceKey, state: "failed", error: cause instanceof Error ? cause.message : String(cause) },
          }));
        },
      );
    }
    // A new loaders object can make a failed source answerable (for example, when the saved-query library arrives),
    // so the effect runs again and re-requests every source that has no request in flight and no cached value.
  }, [signature, attempt, loaders]);

  // Unmounting aborts whatever is still in flight. Source changes abort only the superseded source.
  useEffect(
    () => () => {
      for (const running of inflight.current.values()) running.controller.abort();
      inflight.current.clear();
    },
    [],
  );

  return {
    snapshot(name) {
      const plan = plans.get(name);
      if (!plan) return undefined;
      if (plan.state === "needs_variable") return { state: "needs_variable", values: [], truncated: false, parent: plan.parent };
      if (plan.state === "invalid") return { state: "invalid", values: [], truncated: false, error: plan.error };
      if (!loaders) return { state: "failed", values: [], truncated: false, error: "Values are not available in this view" };
      if (!resolving) return IDLE;
      const entry = loaded[name];
      const rolled = entry !== undefined && entry.key !== plan.key && entry.state !== "failed";
      if (entry && (entry.state === "loading" || rolled) && entry.sourceKey === plan.sourceKey && entry.result) {
        const kept = entry.result;
        return { state: kept.values.length ? "ready" : "empty", values: kept.values, truncated: kept.truncated, refreshing: true };
      }
      if (!entry || entry.key !== plan.key || entry.state === "loading") return { ...IDLE, state: "loading" };
      if (entry.state === "failed") return { state: "failed", values: [], truncated: false, error: entry.error };
      const result = entry.result ?? { values: [], truncated: false };
      return {
        state: result.values.length ? "ready" : "empty",
        values: result.values,
        truncated: result.truncated,
      };
    },
    activate(name) {
      setActive((previous) => (previous.has(name) ? previous : new Set([...previous, name])));
    },
    retry(name) {
      inflight.current.get(name)?.controller.abort();
      inflight.current.delete(name);
      setLoaded((previous) => {
        const next = { ...previous };
        delete next[name];
        return next;
      });
      setAttempt((count) => count + 1);
    },
  };
}
