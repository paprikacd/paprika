import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useDashboardHistory } from "./history"
import type { Dashboard } from "./schema"

const initial: Dashboard = {
  schemaVersion: 1,
  id: "a",
  title: "Initial",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [],
}

describe("dashboard editing history", () => {
  it("undoes and redoes document changes", () => {
    const { result } = renderHook(() => useDashboardHistory(initial))
    act(() => result.current.update({ ...initial, title: "Changed" }))
    expect(result.current.canUndo).toBe(true)
    act(() => result.current.undo())
    expect(result.current.dashboard).toEqual(initial)
    expect(result.current.canRedo).toBe(true)
    act(() => result.current.redo())
    expect(result.current.dashboard.title).toBe("Changed")
    expect(result.current.canRedo).toBe(false)
  })

  it("drops redo when branching but preserves it for a no-op update", () => {
    const { result } = renderHook(() => useDashboardHistory(initial))
    act(() => result.current.update({ ...initial, title: "First" }))
    act(() => result.current.undo())
    act(() => result.current.update({ ...initial }))
    expect(result.current.canRedo).toBe(true)
    expect(result.current.canUndo).toBe(false)
    act(() => result.current.update((current) => ({ ...current, title: "Branch" })))
    expect(result.current.canRedo).toBe(false)
  })

  it("retains only 50 undo entries and clears both histories on dashboard change", () => {
    const { result } = renderHook(() => useDashboardHistory(initial))
    for (let index = 1; index <= 55; index++)
      act(() => result.current.update({ ...initial, title: `Change ${index}` }))
    for (let index = 0; index < 50; index++) act(() => result.current.undo())
    expect(result.current.dashboard.title).toBe("Change 5")
    expect(result.current.canUndo).toBe(false)
    act(() => result.current.reset({ ...initial, id: "another" }))
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
    expect(result.current.dashboard.id).toBe("another")
  })
})
