import { useCallback, useState } from "react"
import type { Dashboard } from "./schema"

/** Bounded draft history, shared by dashboard and focused widget editing. */
export function useDraftHistory<T>(initial: T) {
  const [state, setState] = useState({
    past: [] as T[],
    present: initial,
    future: [] as T[],
  })
  const update = useCallback((next: T | ((current: T) => T)) => {
    setState((current) => {
      const present = typeof next === "function" ? (next as (current: T) => T)(current.present) : next
      if (JSON.stringify(present) === JSON.stringify(current.present)) return current
      return { past: [...current.past.slice(-49), current.present], present, future: [] }
    })
  }, [])
  const reset = useCallback((present: T) => setState({ past: [], present, future: [] }), [])
  const undo = useCallback(
    () =>
      setState((current) =>
        current.past.length
          ? {
              past: current.past.slice(0, -1),
              present: current.past.at(-1)!,
              future: [current.present, ...current.future],
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
            }
          : current,
      ),
    [],
  )
  return {
    present: state.present,
    update,
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
