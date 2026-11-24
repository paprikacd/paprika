"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  widgetKind,
  type QueryRequest,
  type QueryResult,
  type Widget,
} from "./schema";
import { jitter, REPLAY_DELAY_CAP_MS } from "./replay-timing";
import { parseSloConfig } from "./slo-config";
import { compileSloQuery, sloStep, sloSummaryPluginId } from "./slo";
import {
  createQueryDiagnosticLedger,
  diagnosticFailure,
  diagnosticResult,
  type QueryDiagnosticStore,
  type QueryExecutionReceipt,
} from "./query-diagnostics";

// InsightsQueryError (client.ts) carries the machine code of a failed query. It
// is read by shape so this module does not import the client and its generated
// protobuf modules: the widget lab type-checks query.ts without them.
function queryErrorCodeOf(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "InsightsQueryError") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

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

/** Exact request ownership, shared by primary observations and recorded events. */
export function queryIdentity(request: QueryRequest, fetcher: QueryFetcher) {
  const resolved = fetcher.requestIdentity?.(request);
  const revision = fetcher.requestIdentity ? fetcher.requestRevision ?? fetcher : fetcher;
  const key = JSON.stringify([
    request.providerId, request.query, request.kind, request.start, request.end,
    request.step, request.queryRef, request.traceId, resolved,
  ]);
  return { key, resolved, revision };
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
  /** Capacity refusals replayed so far, and the backoff they have cost. */
  attempts: number;
  capacityWaitMs: number;
  /** Set while the entry backs off after a refusal. It stays pending, so identical widgets still share it. */
  waiting: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
}

export interface QuerySchedulerOptions {
  concurrency?: number;
  cacheTTL?: number;
  cacheSize?: number;
  /** Recent execution receipts retained in memory (1..200, default 100). */
  diagnosticsLimit?: number;
  /** Capacity refusals replayed per query before the error settles (default 3). */
  capacityReplays?: number;
  /** Longest total backoff a query may spend on capacity refusals (default 30 s). */
  maxCapacityWaitMs?: number;
}

/** The Retry-After and gateway limit scope of an admission 429 from the query route, or undefined for any other error. */
function capacityRefusal(error: unknown): { retryAfter: string | null; limitScope?: string } | undefined {
  if (!error || typeof error !== "object" || (error as { status?: unknown }).status !== 429) return undefined;
  const { retryAfter, limitScope } = error as { retryAfter?: string | null; limitScope?: string };
  return { retryAfter: retryAfter ?? null, limitScope };
}

/**
 * The hold key for a refusal. A provider-scoped refusal (or one that names no
 * scope) holds only its own provider. An edge, budget or queue refusal limits
 * every provider, so it holds the whole board.
 */
const BOARD_HOLD = "*";
function holdKeyFor(providerId: string, limitScope: string | undefined): string {
  return limitScope === undefined || limitScope === "provider" ? providerId : BOARD_HOLD;
}

/**
 * The backoff for a refusal, before jitter: the server's Retry-After, or the
 * exponential default. Undefined when it exceeds the replay cap, so the error
 * settles rather than the query waiting longer than the browser will replay.
 */
function capacityBackoffMs(retryAfter: string | null, attempt: number): number | undefined {
  let delay = 1000 * 2 ** attempt;
  const header = retryAfter?.trim();
  if (header) {
    const requested = /^\d+$/.test(header) ? Number(header) * 1000 :
      /^[A-Za-z]{3}, /.test(header) ? Date.parse(header) - Date.now() : NaN;
    if (!Number.isNaN(requested)) delay = Math.max(100, requested);
  }
  return delay <= REPLAY_DELAY_CAP_MS ? delay : undefined;
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
  const capacityReplays = Math.max(0, Math.floor(options.capacityReplays ?? 3));
  const maxCapacityWaitMs = Math.max(0, options.maxCapacityWaitMs ?? 30_000);
  const pending = new Map<string, PendingQuery>();
  const queue: PendingQuery[] = [];
  const cache = new Map<string, { data: QueryResult; expires: number; executionId: string }>();
  const diagnostics = createQueryDiagnosticLedger(options.diagnosticsLimit);
  /** Per provider, the Date.now() time until which its queued entries wait after a refusal. */
  const providerHolds = new Map<string, number>();
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
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
    clearRetryTimer(entry);
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

  function clearRetryTimer(entry: PendingQuery) {
    if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    entry.waiting = false;
  }

  /**
   * A capacity refusal releases the entry's execution slot at once and re-queues
   * it, at the front, after the jittered backoff. The timer then calls drain. Returns
   * false when the refusal must settle instead (not a 429, out of replays or time,
   * or no caller still waits).
   */
  function requeueCapacity(entry: PendingQuery, error: unknown): boolean {
    const refusal = capacityRefusal(error);
    if (!refusal || entry.finished || entry.controller.signal.aborted || !entry.subscribers.size) return false;
    if (entry.attempts >= capacityReplays) return false;
    const backoff = capacityBackoffMs(refusal.retryAfter, entry.attempts);
    if (backoff === undefined) return false;
    const delay = jitter(backoff);
    if (entry.capacityWaitMs + delay > maxCapacityWaitMs) return false;
    entry.attempts++;
    entry.capacityWaitMs += delay;
    entry.waiting = true;
    // A provider-scoped refusal holds that provider's queued entries; an edge, budget or queue refusal holds the board.
    const holdKey = holdKeyFor(entry.request.providerId, refusal.limitScope);
    providerHolds.set(holdKey, Math.max(providerHolds.get(holdKey) ?? 0, Date.now() + delay));
    diagnostics.update(entry.receiptId, { state: "queued", attempts: entry.attempts, capacityWaitMs: entry.capacityWaitMs });
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      entry.waiting = false;
      if (entry.finished || entry.controller.signal.aborted || !entry.subscribers.size) return;
      queue.unshift(entry);
      drain();
    }, delay);
    return true;
  }

  /**
   * Starts queued entries while slots are free, skipping any whose provider is
   * holding after a refusal. A timer re-drains when the earliest hold ends.
   */
  function drain() {
    let nextRelease = Infinity;
    while (active < concurrency) {
      const now = Date.now();
      let index = -1;
      for (let i = 0; i < queue.length; i++) {
        const until = Math.max(providerHolds.get(queue[i].request.providerId) ?? 0, providerHolds.get(BOARD_HOLD) ?? 0);
        if (until <= now) {
          index = i;
          break;
        }
        nextRelease = Math.min(nextRelease, until);
      }
      if (index < 0) break;
      const [entry] = queue.splice(index, 1);
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
          (error: unknown) => {
            if (!requeueCapacity(entry, error)) settle(entry, { error });
          },
        )
        .finally(() => {
          active--;
          // A backing-off entry stays pending, so identical widgets join it.
          if (!entry.waiting && pending.get(entry.key) === entry) pending.delete(entry.key);
          drain();
        });
    }
    if (holdTimer !== undefined) clearTimeout(holdTimer);
    holdTimer = undefined;
    if (nextRelease !== Infinity && queue.length) {
      holdTimer = setTimeout(() => {
        holdTimer = undefined;
        drain();
      }, Math.max(0, nextRelease - Date.now()));
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
        attempts: 0,
        capacityWaitMs: 0,
        waiting: false,
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
            clearRetryTimer(ownedEntry);
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
  errorCode?: string | null;
  /** Only a settled, exactly matching request may suppress a remount fetch. */
  request?: { key: string; revision: QueryFetcher; settledAt: number };
}

/** Session-owned observations survive presentation remounts, never a changed request or scheduler. */
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
  /** The machine code of a failed query, when Insights sent one; see InsightsQueryError in client.ts. */
  errorCode: string | null;
  /** The request whose outcome is in data or error, once that outcome has settled. A request still loading does not set it. */
  settled?: { key: string; fetcher?: QueryFetcher };
}

/** The window a widget's query is asked for. */
export interface WidgetRange {
  start: number;
  end: number;
  step: number;
}

const isSloWidget = (widget: Widget) => widget.type === "plugin" && widget.pluginId === sloSummaryPluginId;

/**
 * The request a widget sends. An slo-summary widget runs the PromQL compiled from its objective config, not the stored
 * query text, which is editor output. It uses one step that spans the range, so the query returns the window's start
 * and end points. A config that does not compile sends an empty query, which the query path treats as an empty state with
 * no request. A saved query reference is never sent with an SLO widget, because the provider has no saved-query form of it.
 */
export function effectiveWidgetRequest(widget: Widget, range: WidgetRange): QueryRequest {
  const { providerId, query, type, dataKind } = widget;
  const kind = widgetKind({ type, dataKind });
  if (isSloWidget(widget)) {
    let compiled = "";
    try {
      compiled = compileSloQuery(parseSloConfig(widget.config));
    } catch {
      compiled = "";
    }
    return { providerId, query: compiled, kind, start: range.start, end: range.end, step: sloStep(range.start, range.end) };
  }
  return { providerId, query, kind, start: range.start, end: range.end, step: range.step, ...(widget.queryRef ? { queryRef: widget.queryRef } : {}) };
}

/**
 * A widget owns only its current query. Moving, resizing, renaming or recoloring
 * it does not refetch data. In-flight requests and polling are cancelled when
 * the query changes or the widget leaves the canvas.
 */
export function useWidgetQuery(widget: Widget, options: WidgetQueryOptions) {
  const { providerId, type, dataKind } = widget;
  const referenceKey = widget.queryRef && !isSloWidget(widget) ? JSON.stringify(widget.queryRef) : "";
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
  const request = effectiveWidgetRequest(widget, { start, end, step });
  const query = request.query;
  const executedStep = request.step;
  const { key, resolved: requestIdentity, revision: fetcherRevision } = queryIdentity(request, fetcher);
  // A series is what the widget asks for. Its window and step only move it through time, so they never start a new one.
  const series = JSON.stringify([widget.id, providerId, query, kind, referenceKey, requestIdentity ?? null]);
  // A fetcher without an identity may resolve differently after any change, so such a fetcher owns its series.
  const unidentified = fetcher.requestIdentity ? undefined : fetcher;
  const fetcherRef = useRef(fetcher);
  useLayoutEffect(() => { fetcherRef.current = fetcher; }, [fetcher]);
  const retentionRef = useRef(retention);
  useLayoutEffect(() => { retentionRef.current = retention; }, [retention]);
  const [state, setState] = useState<QueryState>(() => {
    const retained = retention?.read();
    const kept = retained && retained.series === series && retained.unidentified === unidentified ? retained : undefined;
    const completed = kept?.request;
    const current = completed?.key === key && completed.revision === fetcherRevision;
    const due = refreshInterval > 0 && (!completed || Date.now() >= completed.settledAt + Math.max(5_000, refreshInterval));
    return { key: completed?.key, fetcher: completed?.revision, series, unidentified, data: kept?.result, error: kept?.error ?? null, errorCode: kept?.errorCode ?? null, loading: enabled && (!current || due), settled: completed ? { key: completed.key, fetcher: completed.revision } : undefined };
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
    const mayRestore = previousRequest.current === undefined || !requestChanged;
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
        setState({ ...owner, data: undefined, loading: false, error: null, errorCode: null, settled: { key, fetcher: fetcherRevision } });
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
      // A cancelled explicit retry must remain unfinished on the next mount.
      // Keep its old display outcome, but revoke permission to reuse it as current.
      const retained = retentionRef.current?.read();
      if (retained?.request?.key === key && retained.request.revision === fetcherRevision)
        retentionRef.current?.write({ ...retained, request: undefined });
      // A manual retry clears the error, so the widget shows progress. An automatic refresh keeps the last outcome in
      // place and marks the frame busy instead, so a failing widget does not flash between error and placeholder.
      setState((previous) => ({ ...previous, loading: true, error: manual ? null : previous.error, errorCode: manual ? null : previous.errorCode }));
      try {
        const data = await fetcherRef.current(
          {
            providerId,
            query,
            kind,
            start,
            end,
            step: executedStep,
            ...(queryRef ? { queryRef } : {}),
          },
          signal,
        );
        if (!disposed && !signal.aborted && generation === requestGeneration) {
          setState({ ...owner, data, loading: false, error: null, errorCode: null, settled: { key, fetcher: fetcherRevision } });
          retentionRef.current?.write({ series, unidentified, result: data, request: { key, revision: fetcherRevision, settledAt: Date.now() } });
        }
      } catch (error) {
        if (!disposed && !signal.aborted && generation === requestGeneration) {
          const message = error instanceof Error ? error.message : "The query could not be completed.";
          const errorCode = queryErrorCodeOf(error);
          setState({ ...owner, data: undefined, loading: false, error: message, errorCode, settled: { key, fetcher: fetcherRevision } });
          retentionRef.current?.write({ series, unidentified, error: message, errorCode, request: { key, revision: fetcherRevision, settledAt: Date.now() } });
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
        const retained = mayRestore ? retentionRef.current?.read() : undefined;
        if (enabled && retained?.series === series && retained.unidentified === unidentified &&
            retained.request?.key === key && retained.request.revision === fetcherRevision) {
          const remaining = retained.request.settledAt + Math.max(5_000, refreshInterval) - Date.now();
          if (refreshInterval === 0 || remaining > 0 || document.hidden) {
            setState({ key, series, unidentified, fetcher: fetcherRevision, data: retained.result, error: retained.error ?? null, errorCode: retained.errorCode ?? null, loading: false, settled: { key, fetcher: fetcherRevision } });
            // Resume the original poll deadline; opening/closing the editor must
            // neither refresh early nor postpone the next real refresh.
            if (refreshInterval > 0 && !document.hidden) timer = setTimeout(run, remaining);
            return;
          }
        }
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
              errorCode: sameSeries ? previous.errorCode : null,
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
    executedStep,
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
    errorCode: sameSeries ? state.errorCode : null,
    /** Whether `data` and `error` answer the request just asked for, not an earlier window that is still on screen. */
    current: sameSeries && current,
    /** Whether `data` and `error` are the settled outcome of the request just asked for. A request that is still loading is not settled, even when an earlier outcome stays on screen. */
    settled: sameSeries && state.settled?.key === key && state.settled.fetcher === fetcherRevision,
    refresh,
  };
}
