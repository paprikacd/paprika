import { useCallback, useState } from "react"
import type { Dashboard } from "./schema"

export function useDashboardHistory(initial: Dashboard) {
  const [state, setState] = useState({
    past: [] as Dashboard[],
    present: initial,
    future: [] as Dashboard[],
  })
  const update = useCallback((next: Dashboard | ((current: Dashboard) => Dashboard)) => {
    setState((current) => {
      const present = typeof next === "function" ? next(current.present) : next
      if (JSON.stringify(present) === JSON.stringify(current.present)) return current
      return { past: [...current.past.slice(-49), current.present], present, future: [] }
    })
  }, [])
  const reset = useCallback((present: Dashboard) => setState({ past: [], present, future: [] }), [])
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
    dashboard: state.present,
    update,
    reset,
    undo,
    redo,
    canUndo: !!state.past.length,
    canRedo: !!state.future.length,
  }
}
