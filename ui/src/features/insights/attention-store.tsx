"use client";

import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AttentionFacts } from "./widget-attention";

/**
 * One tile's published attention. The facts are what the dashboard rollup counts (reduceAttention), so the strip and
 * query_dashboard apply one rule. completedAt is when the tile's latest query settled, and sampleAt is the time of the
 * sample a stat displays (both Unix milliseconds). mounted is false once the tile unmounts; its facts stay as the last
 * known state until the dashboard stops listing it (prune).
 */
export interface WidgetAttentionEntry {
  widgetId: string;
  title: string;
  facts: AttentionFacts;
  completedAt?: number;
  sampleAt?: number;
  mounted: boolean;
}

export type WidgetAttentionPublication = Omit<WidgetAttentionEntry, "mounted">;

const NO_ENTRIES: readonly WidgetAttentionEntry[] = [];

function sameEntry(left: WidgetAttentionEntry, right: WidgetAttentionPublication & { mounted: boolean }) {
  return left.mounted === right.mounted && left.title === right.title && left.completedAt === right.completedAt && left.sampleAt === right.sampleAt &&
    JSON.stringify(left.facts) === JSON.stringify(right.facts);
}

/**
 * The dashboard's attention, in the order tiles first published. Tiles publish on mount and whenever their verdict
 * changes. Unmounting does not drop a tile: it is released, so its last known facts still count until the dashboard
 * stops listing it (prune).
 */
export function createAttentionStore() {
  let entries: readonly WidgetAttentionEntry[] = NO_ENTRIES;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  const replace = (next: readonly WidgetAttentionEntry[]) => { entries = next; notify(); };
  return {
    getSnapshot: () => entries,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish(publication: WidgetAttentionPublication) {
      const next = { ...publication, mounted: true };
      const index = entries.findIndex(current => current.widgetId === publication.widgetId);
      if (index < 0) return replace([...entries, next]);
      if (sameEntry(entries[index], next)) return;
      replace(entries.map((existing, position) => position === index ? next : existing));
    },
    /** The tile unmounted. Its last known facts stay in the rollup. */
    release(widgetId: string) {
      const index = entries.findIndex(current => current.widgetId === widgetId);
      if (index < 0 || !entries[index].mounted) return;
      replace(entries.map((existing, position) => position === index ? { ...existing, mounted: false } : existing));
    },
    /** Forget tiles the dashboard no longer lists. */
    prune(widgetIds: readonly string[]) {
      const listed = new Set(widgetIds);
      if (entries.every(entry => listed.has(entry.widgetId))) return;
      replace(entries.filter(entry => listed.has(entry.widgetId)));
    },
  };
}

export type AttentionStore = ReturnType<typeof createAttentionStore>;
const fallback: AttentionStore = { getSnapshot: () => NO_ENTRIES, subscribe: () => () => {}, publish() {}, release() {}, prune() {} };
const Context = createContext<AttentionStore>(fallback);

export function AttentionStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createAttentionStore);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

/** Publishing does not subscribe the publisher to other tiles' changes. The same store also prunes and releases. */
export function useAttentionPublisher() { return useContext(Context); }

/** Every published tile's attention. Subscribers re-render only when a tile publishes, releases or is pruned. */
export function useWidgetAttentions(): readonly WidgetAttentionEntry[] {
  const store = useContext(Context);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, fallback.getSnapshot);
}

/** The newest displayed sample among the entries, in Unix milliseconds. */
export function newestSampleAt(entries: readonly WidgetAttentionEntry[]): number | undefined {
  let newest: number | undefined;
  for (const entry of entries) {
    if (entry.sampleAt !== undefined && (newest === undefined || entry.sampleAt > newest)) newest = entry.sampleAt;
  }
  return newest;
}

/**
 * The dashboard's newest displayed sample, shared with every tile so a stat can drop a repeated time that matches it.
 * Tiles read it in the same provider as the strip, so the two agree.
 */
const SampleAsOf = createContext<number | undefined>(undefined);
export function SampleAsOfProvider({ children }: { children: ReactNode }) {
  const entries = useWidgetAttentions();
  const newest = useMemo(() => newestSampleAt(entries), [entries]);
  return <SampleAsOf.Provider value={newest}>{children}</SampleAsOf.Provider>;
}
export function useSampleAsOf() { return useContext(SampleAsOf); }

/**
 * The range end (Unix seconds) that a settled query was made with. query.ts retains the settled request's key, which
 * is queryIdentity's JSON array; its fifth element is the request end. A tile judges its data against this end, so a
 * tile that was not re-queried keeps judging its own result after the dashboard's range end has moved.
 */
export function settledRequestEnd(key: string | undefined): number | undefined {
  if (!key) return undefined;
  try {
    const parts: unknown = JSON.parse(key);
    const end = Array.isArray(parts) ? parts[4] : undefined;
    return typeof end === "number" && Number.isFinite(end) ? end : undefined;
  } catch {
    return undefined;
  }
}
