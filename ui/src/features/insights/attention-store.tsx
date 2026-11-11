"use client";

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AttentionState } from "./widget-attention";

/** One tile's published verdict. Tiles publish on mount and on change, and clear when they unmount. */
export interface WidgetAttentionEntry { widgetId: string; title: string; state: AttentionState }

const NO_ENTRIES: readonly WidgetAttentionEntry[] = [];

/**
 * The dashboard's attention, in the order tiles first published. A later attention strip reads it through
 * useWidgetAttentions; it has no effect on rendering by itself.
 */
export function createAttentionStore() {
  let entries: readonly WidgetAttentionEntry[] = NO_ENTRIES;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  return {
    getSnapshot: () => entries,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish(entry: WidgetAttentionEntry) {
      const index = entries.findIndex(current => current.widgetId === entry.widgetId);
      if (index >= 0) {
        const current = entries[index];
        if (current.title === entry.title && current.state === entry.state) return;
        entries = entries.map((existing, position) => position === index ? entry : existing);
      } else {
        entries = [...entries, entry];
      }
      notify();
    },
    clear(widgetId: string) {
      if (!entries.some(entry => entry.widgetId === widgetId)) return;
      entries = entries.filter(entry => entry.widgetId !== widgetId);
      notify();
    },
  };
}

export type AttentionStore = ReturnType<typeof createAttentionStore>;
const fallback: AttentionStore = { getSnapshot: () => NO_ENTRIES, subscribe: () => () => {}, publish() {}, clear() {} };
const Context = createContext<AttentionStore>(fallback);

export function AttentionStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createAttentionStore);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

/** Publishing does not subscribe the publisher to other tiles' changes. */
export function useAttentionPublisher() { return useContext(Context); }

/** Every published tile's attention. Subscribers re-render only when a tile publishes or clears. */
export function useWidgetAttentions(): readonly WidgetAttentionEntry[] {
  const store = useContext(Context);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, fallback.getSnapshot);
}
