"use client";

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AttentionFacts } from "./widget-attention";

/**
 * One tile's published attention. The facts are what the dashboard rollup counts (reduceAttention), so the strip and
 * query_dashboard apply one rule. completedAt is the newest query settle time for the tile, in Unix milliseconds.
 * mounted is false once the tile unmounts (focus mode mounts one tile); its facts stay as the last known state.
 */
export interface WidgetAttentionEntry {
  widgetId: string;
  title: string;
  facts: AttentionFacts;
  completedAt?: number;
  mounted: boolean;
}

export type WidgetAttentionPublication = Omit<WidgetAttentionEntry, "mounted">;

const NO_ENTRIES: readonly WidgetAttentionEntry[] = [];

function sameEntry(left: WidgetAttentionEntry, right: WidgetAttentionPublication & { mounted: boolean }) {
  return left.mounted === right.mounted && left.title === right.title && left.completedAt === right.completedAt && JSON.stringify(left.facts) === JSON.stringify(right.facts);
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
