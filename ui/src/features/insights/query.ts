"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  widgetKind,
  type QueryRequest,
  type QueryResult,
  type Widget,
} from "./schema";

export type QueryFetcher = ((
  request: QueryRequest,
  signal: AbortSignal,
) => Promise<QueryResult>) & {
  /** Stable identity of the fully resolved request, including binding errors. */
  requestIdentity?: (request: QueryRequest) => string;
  /** Changes when the underlying provider/scheduler is invalidated. */
  requestRevision?: QueryFetcher;
};

/** Keep query resolution authoritative while allowing unrelated variable
 * changes to retain an unchanged result and its interaction state. */
export function createResolvedQueryFetcher(scheduler: QueryFetcher, resolve: (request: QueryRequest) => QueryRequest): QueryFetcher {
  const fetcher: QueryFetcher = async (request, signal) => scheduler(resolve(request), signal);
  fetcher.requestRevision = scheduler;
  fetcher.requestIdentity = request => {
    try { return JSON.stringify(["resolved", resolve(request)]); }
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
  request: QueryRequest;
  controller: AbortController;
  subscribers: Set<QuerySubscriber>;
}

export interface QuerySchedulerOptions {
  concurrency?: number;
  cacheTTL?: number;
  cacheSize?: number;
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
  const cache = new Map<string, { data: QueryResult; expires: number }>();
  let active = 0;

  const aborted = () =>
    new DOMException("The query was cancelled.", "AbortError");

  function settle(entry: PendingQuery, data?: QueryResult, error?: unknown) {
    // Remove before resolving callers: a caller may immediately retry an error
    // before the running request's finally handler releases its slot.
    if (pending.get(entry.key) === entry) pending.delete(entry.key);
    for (const subscriber of entry.subscribers) {
      subscriber.signal.removeEventListener("abort", subscriber.abort);
      if (error !== undefined) subscriber.reject(error);
      else subscriber.resolve(data!);
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
              cache.set(entry.key, { data, expires: Date.now() + cacheTTL });
              while (cache.size > cacheSize)
                cache.delete(cache.keys().next().value!);
            }
            settle(entry, data);
          },
          (error: unknown) => settle(entry, undefined, error),
        )
        .finally(() => {
          active--;
          if (pending.get(entry.key) === entry) pending.delete(entry.key);
          drain();
        });
    }
  }

  return (request, signal) => {
    if (signal.aborted) return Promise.reject(aborted());
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
      return Promise.resolve(cached.data);
    }
    cache.delete(key);
    let entry = pending.get(key);
    if (!entry) {
      entry = {
        key,
        request: { ...request },
        controller: new AbortController(),
        subscribers: new Set(),
      };
      pending.set(key, entry);
      queue.push(entry);
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
          reject(aborted());
          if (!ownedEntry.subscribers.size) {
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
}

interface QueryState {
  key?: string;
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
  } = options;
  const debounceRef = useRef(debounceMs);
  useEffect(() => { debounceRef.current = debounceMs; }, [debounceMs]);
  const kind = widgetKind({ type, dataKind });
  const request: QueryRequest = { providerId, query, kind, start, end, step, ...(queryRef ? { queryRef } : {}) };
  const requestIdentity = fetcher.requestIdentity?.(request);
  const fetcherRevision = fetcher.requestIdentity ? fetcher.requestRevision ?? fetcher : fetcher;
  const fetcherRef = useRef(fetcher);
  useLayoutEffect(() => { fetcherRef.current = fetcher; }, [fetcher]);
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
  const [state, setState] = useState<QueryState>({
    data: undefined,
    loading: enabled,
    error: null,
  });
  const runRef = useRef<() => void>(() => {});
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

    async function run() {
      clearTimer();
      controller?.abort();
      const requestGeneration = ++generation;
      if (!queryRef && (!providerId || !query.trim())) {
        setState({
          key,
          fetcher: fetcherRevision,
          data: undefined,
          loading: false,
          error: null,
        });
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
      setState((previous) => ({ ...previous, loading: true, error: null }));
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
          setState({ key, fetcher: fetcherRevision, data, loading: false, error: null });
        }
      } catch (error) {
        if (!disposed && !signal.aborted && generation === requestGeneration) {
          setState({
            key,
            fetcher: fetcherRevision,
            data: undefined,
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "The query could not be completed.",
          });
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

    runRef.current = () => {
      void run();
    };
    // Defer the initial request so effect cleanup can cancel a StrictMode replay.
    queueMicrotask(() => {
      if (!disposed) {
        if (requestChanged)
          setState({
            key,
            fetcher: fetcherRevision,
            data: undefined,
            loading: enabled,
            error: null,
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
  ]);

  const refresh = useCallback(() => runRef.current(), []);
  const current = state.key === key && state.fetcher === fetcherRevision;
  return {
    data: current ? state.data : undefined,
    loading: current ? state.loading : enabled,
    error: current ? state.error : null,
    refresh,
  };
}
