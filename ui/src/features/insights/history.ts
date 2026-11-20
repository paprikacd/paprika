import { useCallback, useState } from "react"
import type { Dashboard } from "./schema"

/** Keystrokes in the same group within this many milliseconds share one undo step. */
export const HISTORY_GROUP_WINDOW_MS = 1000

export type HistoryUpdateOptions = {
  /** Edits with the same group name, less than HISTORY_GROUP_WINDOW_MS apart, merge into one undo step. */
  group?: string
  /** Clock reading for the grouping window. Defaults to Date.now(). */
  now?: number
}

type HistoryState<T> = {
  past: T[]
  present: T
  future: T[]
  lastGroup?: string
  lastAt: number
}

/** Bounded draft history, shared by dashboard and focused widget editing. */
export function useDraftHistory<T>(initial: T) {
  const [state, setState] = useState<HistoryState<T>>({
    past: [],
    present: initial,
    future: [],
    lastAt: 0,
  })
  const update = useCallback((next: T | ((current: T) => T), options?: HistoryUpdateOptions) => {
    const at = options?.now ?? Date.now()
    const group = options?.group
    setState((current) => {
      const present = typeof next === "function" ? (next as (current: T) => T)(current.present) : next
      if (JSON.stringify(present) === JSON.stringify(current.present)) return current
      if (group && group === current.lastGroup && at - current.lastAt < HISTORY_GROUP_WINDOW_MS) {
        const base = current.past.at(-1)
        // The burst returned to the state before it began, so the step is no longer a change.
        if (base !== undefined && JSON.stringify(base) === JSON.stringify(present))
          return { past: current.past.slice(0, -1), present, future: [], lastAt: at }
        return { ...current, present, future: [], lastAt: at }
      }
      return {
        past: [...current.past.slice(-49), current.present],
        present,
        future: [],
        lastGroup: group,
        lastAt: at,
      }
    })
  }, [])
  /** Closes the open group, so the next update starts a new undo step. Call it on blur. */
  const endGroup = useCallback(
    () => setState((current) => (current.lastGroup === undefined ? current : { ...current, lastGroup: undefined })),
    [],
  )
  const reset = useCallback(
    (present: T) => setState({ past: [], present, future: [], lastAt: 0 }),
    [],
  )
  const undo = useCallback(
    () =>
      setState((current) =>
        current.past.length
          ? {
              past: current.past.slice(0, -1),
              present: current.past.at(-1)!,
              future: [current.present, ...current.future],
              lastAt: 0,
            }
          : current,
      ),
    [],
  )
  const redo = useCallback(
    () =>
      setState((current) =>
        current.future.length
          ? {
              past: [...current.past, current.present],
              present: current.future[0],
              future: current.future.slice(1),
              lastAt: 0,
            }
          : current,
      ),
    [],
  )
  return {
    present: state.present,
    update,
    endGroup,
    reset,
    undo,
    redo,
    canUndo: !!state.past.length,
    canRedo: !!state.future.length,
  }
}

export function useDashboardHistory(initial: Dashboard) {
  const { present, ...history } = useDraftHistory(initial)
  return { dashboard: present, ...history }
}
