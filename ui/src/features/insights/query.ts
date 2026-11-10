"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  widgetKind,
  type QueryRequest,
  type QueryResult,
  type Widget,
} from "./schema";
import {
  createQueryDiagnosticLedger,
  diagnosticFailure,
  diagnosticResult,
  type QueryDiagnosticStore,
  type QueryExecutionReceipt,
} from "./query-diagnostics";

export type QueryFetcher = ((
  request: QueryRequest,
  signal: AbortSignal,
) => Promise<QueryResult>) & {
  /**
   * Stable identity of the resolved query: what it asks for once bindings and variables apply, with binding errors
   * included. The time window (start, end, step) is not part of it: a window moves a series, it does not change it.
   */
  requestIdentity?: (request: QueryRequest) => string;
  /** Changes when the underlying provider/scheduler is invalidated. */
  requestRevision?: QueryFetcher;
  /** Passive, bounded execution history owned by the authenticated scheduler. */
  diagnostics?: QueryDiagnosticStore;
};

/** The request without its window. Requests that differ only in start, end or step are one series. */
function withoutWindow(request: QueryRequest): Partial<QueryRequest> {
  const series: Partial<QueryRequest> = { ...request };
  delete series.start;
  delete series.end;
  delete series.step;
  return series;
}

/** Keep query resolution authoritative while allowing unrelated variable
 * changes to retain an unchanged result and its interaction state. */
export function createResolvedQueryFetcher(scheduler: QueryFetcher, resolve: (request: QueryRequest) => QueryRequest): QueryFetcher {
  const fetcher: QueryFetcher = async (request, signal) => scheduler(resolve(request), signal);
  fetcher.requestRevision = scheduler;
  fetcher.diagnostics = scheduler.diagnostics;
  fetcher.requestIdentity = request => {
    try { return JSON.stringify(["resolved", withoutWindow(resolve(request))]); }
    catch (error) { return JSON.stringify(["error", error instanceof Error ? error.message : "Invalid query"]); }
  };
  return fetcher;
}

interface QuerySubscriber {
  resolve: (data: QueryResult) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
}

interface PendingQuery {
  key: string;
  receiptId: string;
  queuedAtMs: number;
  startedAtMs?: number;
  finished: boolean;
  request: QueryRequest;
  controller: AbortController;
  subscribers: Set<QuerySubscriber>;
}

export interface QuerySchedulerOptions {
  concurrency?: number;
  cacheTTL?: number;
  cacheSize?: number;
  /** Recent execution receipts retained in memory (1..200, default 100). */
  diagnosticsLimit?: number;
}

/**
 * Create one scheduler per authenticated Insights session. Identical widget
 * queries share a bounded request; cancellation detaches only that subscriber.
 * Credentials must never share a scheduler across different user sessions.
 */
export function createQueryScheduler(
  fetcher: QueryFetcher,
  options: QuerySchedulerOptions = {},
): QueryFetcher {
  const concurrency = Math.max(
    1,
    Math.min(16, Math.floor(options.concurrency ?? 4)),
  );
  const cacheTTL = Math.max(0, options.cacheTTL ?? 5_000);
  const cacheSize = Math.max(
    0,
    Math.min(100, Math.floor(options.cacheSize ?? 100)),
  );
  const pending = new Map<string, PendingQuery>();
  const queue: PendingQuery[] = [];
  const cache = new Map<string, { data: QueryResult; expires: number; executionId: string }>();
  const diagnostics = createQueryDiagnosticLedger(options.diagnosticsLimit);
  let active = 0;

  const aborted = () =>
    new DOMException("The query was cancelled.", "AbortError");

  function finish(entry: PendingQuery, outcome: Partial<QueryExecutionReceipt>) {
    // A provider that ignores AbortSignal must not turn a cancelled receipt
    // back into a success when it eventually settles.
    if (entry.finished) return;
    entry.finished = true;
    const finishedAtMs = performance.now();
    diagnostics.update(entry.receiptId, {
      ...outcome,
      finishedAtMs,
      queueMs: Math.max(0, (entry.startedAtMs ?? finishedAtMs) - entry.queuedAtMs),
      requestMs: entry.startedAtMs === undefined ? 0 : Math.max(0, finishedAtMs - entry.startedAtMs),
      totalMs: Math.max(0, finishedAtMs - entry.queuedAtMs),
    });
  }

  function settle(entry: PendingQuery, outcome: { data: QueryResult } | { error: unknown }) {
    // Remove before resolving callers: a caller may immediately retry an error
    // before the running request's finally handler releases its slot.
    if (pending.get(entry.key) === entry) pending.delete(entry.key);
    finish(entry, "error" in outcome ? diagnosticFailure(outcome.error) : diagnosticResult(outcome.data));
    for (const subscriber of entry.subscribers) {
      subscriber.signal.removeEventListener("abort", subscriber.abort);
      if ("error" in outcome) subscriber.reject(outcome.error);
      else subscriber.resolve(outcome.data);
    }
    entry.subscribers.clear();
  }

  function drain() {
    while (active < concurrency && queue.length) {
      const entry = queue.shift()!;
      if (!entry.subscribers.size || entry.controller.signal.aborted) continue;
      active++;
      void Promise.resolve()
        .then(() => {
          if (entry.controller.signal.aborted) throw aborted();
          entry.startedAtMs = performance.now();
          diagnostics.update(entry.receiptId, {
            state: "running",
            startedAtMs: entry.startedAtMs,
            queueMs: Math.max(0, entry.startedAtMs - entry.queuedAtMs),
          });
          return fetcher(entry.request, entry.controller.signal);
        })
        .then(
          (data) => {
            if (
              !entry.controller.signal.aborted &&
              entry.subscribers.size &&
              cacheTTL > 0 &&
              cacheSize > 0
            ) {
              cache.delete(entry.key);
              cache.set(entry.key, { data, expires: Date.now() + cacheTTL, executionId: entry.receiptId });
              while (cache.size > cacheSize)
                cache.delete(cache.keys().next().value!);
            }
            settle(entry, { data });
          },
          (error: unknown) => settle(entry, { error }),
        )
        .finally(() => {
          active--;
          if (pending.get(entry.key) === entry) pending.delete(entry.key);
          drain();
        });
    }
  }

  const schedule: QueryFetcher = (request, signal) => {
    const queuedAtMs = performance.now();
    if (signal.aborted) {
      const error = aborted();
      diagnostics.add(request, queuedAtMs, {
        ...diagnosticFailure(error),
        finishedAtMs: queuedAtMs,
        queueMs: 0,
        requestMs: 0,
        totalMs: 0,
        cancelledConsumers: 1,
      });
      return Promise.reject(error);
    }
    const key = JSON.stringify([
      request.providerId,
      request.kind,
      request.query,
      request.start,
      request.end,
      request.step,
      request.queryRef,
      request.traceId,
    ]);
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) {
      // Move hits to the newest position, keeping the cache bounded by use.
      cache.delete(key);
      cache.set(key, cached);
      diagnostics.add(request, queuedAtMs, {
        ...diagnosticResult(cached.data),
        executionId: cached.executionId,
        reuse: "cache",
        finishedAtMs: queuedAtMs,
        queueMs: 0,
        requestMs: 0,
        totalMs: 0,
      });
      return Promise.resolve(cached.data);
    }
    cache.delete(key);
    let entry = pending.get(key);
    if (!entry) {
      const receipt = diagnostics.add(request, queuedAtMs);
      entry = {
        key,
        receiptId: receipt.id,
        queuedAtMs,
        finished: false,
        request: { ...request },
        controller: new AbortController(),
        subscribers: new Set(),
      };
      pending.set(key, entry);
      queue.push(entry);
    } else {
      diagnostics.update(entry.receiptId, receipt => ({
        consumers: receipt.consumers + 1,
        sharedConsumers: receipt.sharedConsumers + 1,
      }));
    }
    const ownedEntry = entry;
    const promise = new Promise<QueryResult>((resolve, reject) => {
      const subscriber: QuerySubscriber = {
        resolve,
        reject,
        signal,
        abort: () => {
          ownedEntry.subscribers.delete(subscriber);
          signal.removeEventListener("abort", subscriber.abort);
          diagnostics.update(ownedEntry.receiptId, receipt => ({ cancelledConsumers: receipt.cancelledConsumers + 1 }));
          reject(aborted());
          if (!ownedEntry.subscribers.size) {
            finish(ownedEntry, diagnosticFailure(aborted()));
            ownedEntry.controller.abort();
            if (pending.get(key) === ownedEntry) pending.delete(key);
            const queuedIndex = queue.indexOf(ownedEntry);
            if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
          }
        },
      };
      ownedEntry.subscribers.add(subscriber);
      signal.addEventListener("abort", subscriber.abort, { once: true });
    });
    drain();
    return promise;
  };
  schedule.diagnostics = diagnostics.store;
  return schedule;
}

export interface WidgetQueryOptions {
  fetcher: QueryFetcher;
  /** Unix seconds, matching the Prometheus and Tempo query APIs. */
  start: number;
  end: number;
  step: number;
  /** Polling interval in milliseconds. Zero disables polling. */
  refreshInterval?: number;
  enabled?: boolean;
  /** Coalesce live authoring changes without retaining a previous query’s data. */
  debounceMs?: number;
  /** Where the host keeps this widget's last outcome, so a remounted widget does not start from a placeholder. */
  retention?: QueryRetention;
}

/** The last outcome of one series, as a host keeps it between mounts. */
export interface RetainedQuery {
  series: string;
  /** Set only for a fetcher without an identity: the series then belongs to that fetcher instance. */
  unidentified?: QueryFetcher;
  result?: QueryResult;
  error?: string;
}

/** Where a host keeps a widget's RetainedQuery. The hook reads it once, on mount, and writes each settled request. */
export interface QueryRetention {
  read: () => RetainedQuery | undefined;
  write: (retained: RetainedQuery) => void;
}

interface QueryState {
  /** The request this outcome answers, and the series it belongs to. */
  key?: string;
  series?: string;
  unidentified?: QueryFetcher;
  fetcher?: QueryFetcher;
  data: QueryResult | undefined;
  loading: boolean;
  error: string | null;
}

/**
 * A widget owns only its current query. Moving, resizing, renaming or recoloring
 * it does not refetch data. In-flight requests and polling are cancelled when
 * the query changes or the widget leaves the canvas.
 */
export function useWidgetQuery(widget: Widget, options: WidgetQueryOptions) {
  const { providerId, query, type, dataKind } = widget;
  const referenceKey = widget.queryRef ? JSON.stringify(widget.queryRef) : "";
  const queryRef = useMemo(
    () =>
      referenceKey
        ? (JSON.parse(referenceKey) as NonNullable<Widget["queryRef"]>)
        : undefined,
    [referenceKey],
  );
  const {
    fetcher,
    start,
    end,
    step,
    refreshInterval = 0,
    enabled = true,
    debounceMs = 0,
    retention,
  } = options;
  const debounceRef = useRef(debounceMs);
  useEffect(() => { debounceRef.current = debounceMs; }, [debounceMs]);
  const kind = widgetKind({ type, dataKind });
  const request: QueryRequest = { providerId, query, kind, start, end, step, ...(queryRef ? { queryRef } : {}) };
  const requestIdentity = fetcher.requestIdentity?.(request);
  const fetcherRevision = fetcher.requestIdentity ? fetcher.requestRevision ?? fetcher : fetcher;
  // A series is what the widget asks for. Its window and step only move it through time, so they never start a new one.
  const series = JSON.stringify([widget.id, providerId, query, kind, referenceKey, requestIdentity ?? null]);
  // A fetcher without an identity may resolve differently after any change, so such a fetcher owns its series.
  const unidentified = fetcher.requestIdentity ? undefined : fetcher;
  const fetcherRef = useRef(fetcher);
  useLayoutEffect(() => { fetcherRef.current = fetcher; }, [fetcher]);
  const retentionRef = useRef(retention);
  useLayoutEffect(() => { retentionRef.current = retention; }, [retention]);
  const key = JSON.stringify([
    providerId,
    query,
    kind,
    start,
    end,
    step,
    referenceKey,
    requestIdentity,
  ]);
  const [state, setState] = useState<QueryState>(() => {
    const retained = retention?.read();
    const kept = retained && retained.series === series && retained.unidentified === unidentified ? retained : undefined;
    return { series, unidentified, data: kept?.result, error: kept?.error ?? null, loading: enabled };
  });
  const runRef = useRef<(manual?: boolean) => void>(() => {});
  const previousRequest = useRef<
    { key: string; fetcher: QueryFetcher } | undefined
  >(undefined);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requestChanged =
      previousRequest.current?.key !== key ||
      previousRequest.current?.fetcher !== fetcherRevision;
    previousRequest.current = { key, fetcher: fetcherRevision };
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };

    async function run(manual = false) {
      clearTimer();
      controller?.abort();
      const requestGeneration = ++generation;
      // An outcome is applied only to the request that asked for it, with the series it belongs to.
      const owner = { key, series, unidentified, fetcher: fetcherRevision };
      if (!queryRef && (!providerId || !query.trim())) {
        setState({ ...owner, data: undefined, loading: false, error: null });
        return;
      }
      if (!enabled) {
        // Scrolling away pauses work without turning known observations into an
        // empty state. A different query is cleared by the identity check below.
        setState((previous) => ({ ...previous, loading: false }));
        return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      // A manual retry clears the error, so the widget shows progress. An automatic refresh keeps the last outcome in
      // place and marks the frame busy instead, so a failing widget does not flash between error and placeholder.
      setState((previous) => ({ ...previous, loading: true, error: manual ? null : previous.error }));
      try {
        const data = await fetcherRef.current(
          {
            providerId,
            query,
            kind,
            start,
            end,
            step,
            ...(queryRef ? { queryRef } : {}),
          },
          signal,
        );
        if (!disposed && !signal.aborted && generation === requestGeneration) {
          setState({ ...owner, data, loading: false, error: null });
          retentionRef.current?.write({ series, unidentified, result: data });
        }
      } catch (error) {
        if (!disposed && !signal.aborted && generation === requestGeneration) {
          const message = error instanceof Error ? error.message : "The query could not be completed.";
          setState({ ...owner, data: undefined, loading: false, error: message });
          retentionRef.current?.write({ series, unidentified, error: message });
        }
      } finally {
        if (
          !disposed &&
          !signal.aborted &&
          generation === requestGeneration &&
          refreshInterval > 0 &&
          !document.hidden
        ) {
          timer = setTimeout(run, Math.max(5_000, refreshInterval));
        }
      }
    }

    function onVisibilityChange() {
      clearTimer();
      if (!document.hidden && refreshInterval > 0) void run();
    }

    runRef.current = (manual = false) => {
      void run(manual);
    };
    // Defer the initial request so effect cleanup can cancel a StrictMode replay.
    queueMicrotask(() => {
      if (!disposed) {
        if (requestChanged)
          setState((previous) => {
            // The same series keeps its last outcome visible while it reloads. Another series starts empty.
            const sameSeries = previous.series === series && previous.unidentified === unidentified;
            return {
              key,
              series,
              unidentified,
              fetcher: fetcherRevision,
              data: sameSeries ? previous.data : undefined,
              error: sameSeries ? previous.error : null,
              loading: enabled,
            };
          });
        if (requestChanged && debounceRef.current > 0 && enabled)
          timer = setTimeout(run, debounceRef.current);
        else void run();
      }
    });
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      runRef.current = () => {};
    };
  }, [
    providerId,
    query,
    kind,
    start,
    end,
    step,
    refreshInterval,
    enabled,
    fetcherRevision,
    referenceKey,
    key,
    queryRef,
    series,
    unidentified,
  ]);

  // Manual refresh (Retry, Refresh) starts progress; the outcome of the series stays visible while it reloads.
  const refresh = useCallback(() => runRef.current(true), []);
  const sameSeries = state.series === series && state.unidentified === unidentified;
  const current = sameSeries && state.key === key && state.fetcher === fetcherRevision;
  return {
    data: sameSeries ? state.data : undefined,
    loading: current ? state.loading : enabled,
    error: sameSeries ? state.error : null,
    refresh,
  };
}
