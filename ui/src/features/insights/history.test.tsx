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

describe("grouped draft history", () => {
  const titled = (title: string) => ({ ...initial, title })

  it("merges a typing burst into one undo step", () => {
    const { result } = renderHook(() => useDashboardHistory(initial))
    act(() => result.current.update(titled("A"), { group: "dashboard:title", now: 0 }))
    act(() => result.current.update(titled("Ab"), { group: "dashboard:title", now: 100 }))
    act(() => result.current.update(titled("Abc"), { group: "dashboard:title", now: 200 }))
    expect(result.current.dashboard.title).toBe("Abc")
    act(() => result.current.undo())
    expect(result.current.dashboard).toEqual(initial)
    expect(result.current.canUndo).toBe(false)
  })

  it("starts a new step for another group or after a 1000 ms pause", () => {
    const { result } = renderHook(() => useDashboardHistory(initial))
    act(() => result.current.update(titled("A"), { group: "dashboard:title", now: 0 }))
    act(() => result.current.update({ ...titled("A"), description: "d" }, { group: "dashboard:description", now: 100 }))
    act(() => result.current.undo())
    expect(result.current.dashboard).toEqual(titled("A"))
    act(() => result.current.undo())
    expect(result.current.dashboard).toEqual(initial)

    const paused = renderHook(() => useDashboardHistory(initial))
    act(() => paused.result.current.update(titled("A"), { group: "dashboard:title", now: 0 }))
    act(() => paused.result.current.update(titled("Ab"), { group: "dashboard:title", now: 1200 }))
    act(() => paused.result.current.undo())
    expect(paused.result.current.dashboard).toEqual(titled("A"))
    expect(paused.result.current.canUndo).toBe(true)
  })

  it("ends the burst on endGroup so the next keystroke starts a new step", () => {
    const { result } = renderHook(() => useDashboardHistory(initial))
    act(() => result.current.update(titled("A"), { group: "dashboard:title", now: 0 }))
    act(() => result.current.endGroup())
    act(() => result.current.update(titled("Ab"), { group: "dashboard:title", now: 100 }))
    act(() => result.current.undo())
    expect(result.current.dashboard).toEqual(titled("A"))
    expect(result.current.canUndo).toBe(true)
  })

  it("keeps earlier layout steps undoable after a long title edit", () => {
    const { result } = renderHook(() => useDashboardHistory(initial))
    act(() => result.current.update({ ...initial, timeRange: "6h" }))
    for (let index = 1; index <= 60; index++)
      act(() => result.current.update((current) => ({ ...current, title: "T".repeat(index) }), { group: "dashboard:title", now: index * 10 }))
    act(() => result.current.undo())
    expect(result.current.dashboard).toEqual({ ...initial, timeRange: "6h" })
    act(() => result.current.undo())
    expect(result.current.dashboard).toEqual(initial)
    expect(result.current.canUndo).toBe(false)
  })

  it("removes a no-op burst instead of leaving an empty step", () => {
    const { result } = renderHook(() => useDashboardHistory(initial))
    act(() => result.current.update(titled("X"), { group: "dashboard:title", now: 0 }))
    act(() => result.current.update(titled("Initial"), { group: "dashboard:title", now: 100 }))
    expect(result.current.canUndo).toBe(false)
    act(() => result.current.update(titled("Y"), { group: "dashboard:title", now: 200 }))
    act(() => result.current.undo())
    expect(result.current.dashboard).toEqual(initial)
    expect(result.current.canUndo).toBe(false)
  })
})
