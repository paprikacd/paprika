"use client";

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";

export interface ChartCursor { source: string; timestamp: number; pinned: boolean }
export function createChartCursorStore() {
  let current: ChartCursor | null = null;
  const candidates = new Map<string, ChartCursor>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish(source: string, timestamp: number, pinned = false) {
      if (!Number.isFinite(timestamp)) return;
      const candidate = { source, timestamp, pinned };
      candidates.delete(source);
      candidates.set(source, candidate);
      if (current?.pinned && current.source !== source && !pinned) return;
      if (current?.source === source && current.timestamp === timestamp && current.pinned === pinned) return;
      current = candidate; notify();
    },
    clear(source: string) {
      candidates.delete(source);
      if (current?.source !== source) return;
      const remaining = [...candidates.values()];
      current = remaining.findLast(candidate => candidate.pinned) ?? remaining.at(-1) ?? null;
      notify();
    },
  };
}
const fallback = { getSnapshot: () => null, subscribe: () => () => {}, publish() {}, clear() {} };
const Context = createContext<ReturnType<typeof createChartCursorStore>>(fallback);
export function ChartCursorProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createChartCursorStore);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
/** Publishing does not subscribe a tooltip to other charts' pointer movements. */
export function useChartCursorPublisher() { return useContext(Context); }
export function useChartCursor() {
  const store = useContext(Context);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, fallback.getSnapshot);
}
