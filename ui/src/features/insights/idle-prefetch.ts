import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { QueryDiagnosticStore } from "./query-diagnostics";

/** Widgets granted per idle batch, in reading order. */
export const PREFETCH_BATCH = 2;
/** Boards with more widgets than this are not prefetched. */
export const PREFETCH_MAX_WIDGETS = 24;
/** Quiet time the query scheduler must have before the next batch is granted. */
export const PREFETCH_SETTLE_MS = 400;

const noopSubscribe = () => () => {};

/**
 * Whether idle prefetch may run for a board. It is off with Save-Data, and for a board too large to warm
 * without competing with the tiles in view.
 */
export function prefetchSupported(count: number, connection: { saveData?: boolean } | undefined): boolean {
  if (count > PREFETCH_MAX_WIDGETS) return false;
  return connection?.saveData !== true;
}

/** Busy means a query is waiting for or holding the scheduler. Prefetch yields to it. */
function isBusy(receipts: readonly { state: string }[]): boolean {
  return receipts.some(receipt => receipt.state === "queued" || receipt.state === "running");
}

/** Runs the callback when the browser is idle, or on the next tick where idle callbacks do not exist. */
function whenIdle(callback: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(callback, { timeout: 1000 });
    return () => cancelIdleCallback(handle);
  }
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

/**
 * The widget ids that may prefetch, in reading order. A batch is granted only after the scheduler has been idle
 * for PREFETCH_SETTLE_MS, and never while a query is queued or running. Prefetch pauses while the tab is hidden,
 * and it needs the fetcher's diagnostics, which tell the hook when the scheduler is busy.
 */
export function useIdlePrefetch(
  ids: readonly string[],
  diagnostics: QueryDiagnosticStore | undefined,
  enabled: boolean,
): ReadonlySet<string> {
  const busy = useSyncExternalStore(
    diagnostics?.subscribe ?? noopSubscribe,
    () => (diagnostics ? isBusy(diagnostics.getSnapshot()) : false),
    () => false,
  );
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  // A new set of widgets starts again from the first batch.
  const key = ids.join("\n");
  const [grant, setGrant] = useState({ key, count: 0 });
  const granted = grant.key === key ? grant.count : 0;
  const limit = Math.min(ids.length, PREFETCH_MAX_WIDGETS);
  const active = enabled && !!diagnostics && !hidden && ids.length <= PREFETCH_MAX_WIDGETS;
  useEffect(() => {
    if (!active || busy || granted >= limit) return;
    let cancelIdle: (() => void) | undefined;
    const timer = setTimeout(() => {
      cancelIdle = whenIdle(() => setGrant({ key, count: Math.min(granted + PREFETCH_BATCH, limit) }));
    }, PREFETCH_SETTLE_MS);
    return () => {
      clearTimeout(timer);
      cancelIdle?.();
    };
  }, [active, busy, granted, limit, key]);
  return useMemo(() => new Set(active ? ids.slice(0, granted) : []), [active, granted, ids]);
}
