"use client"

import { createContext, useContext, type ReactNode } from "react"
import type { QueryResult } from "./schema"
import type { ObservationWindow } from "./time-window"

/** Runtime-only actions. Bounds are Unix milliseconds, matching chart points. */
export type DashboardWindowActions = {
  /** End of the queried range in Unix milliseconds; never wall-clock now. */
  rangeEnd?: number
  apply?: (window: ObservationWindow) => void
  previous?: (window: ObservationWindow, signal: AbortSignal) => Promise<QueryResult>
}
const WindowActions = createContext<DashboardWindowActions>({})
export function DashboardWindowProvider({ value, children }: { value: DashboardWindowActions; children: ReactNode }) {
  return <WindowActions.Provider value={value}>{children}</WindowActions.Provider>
}
export const useDashboardWindow = () => useContext(WindowActions)
