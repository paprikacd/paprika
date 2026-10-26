import { act, fireEvent, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { useWorkspaceRefresh, WORKSPACE_REFRESH_INTERVAL } from "./use-workspace-refresh"

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it("refreshes visible tabs on the interval and focus without overlapping requests", async () => {
  vi.useFakeTimers()
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false)
  let finish!: () => void
  const refresh = vi.fn((_signal: AbortSignal) => new Promise<void>(resolve => { void _signal; finish = resolve }))
  const view = renderHook(() => useWorkspaceRefresh(true, refresh))
  await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_INTERVAL) })
  expect(refresh).toHaveBeenCalledOnce()
  const firstSignal = refresh.mock.calls[0][0]
  fireEvent.focus(window)
  await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_INTERVAL) })
  expect(refresh).toHaveBeenCalledOnce()
  hidden.mockReturnValue(true)
  fireEvent(document, new Event("visibilitychange"))
  expect(firstSignal.aborted).toBe(true)
  await act(async () => finish())
  await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_REFRESH_INTERVAL) })
  expect(refresh).toHaveBeenCalledOnce()
  hidden.mockReturnValue(false)
  fireEvent(document, new Event("visibilitychange"))
  expect(refresh).toHaveBeenCalledTimes(2)
  const secondSignal = refresh.mock.calls[1][0]
  view.unmount()
  expect(secondSignal.aborted).toBe(true)
})

it("uses the latest callback and recovers a background refresh error", async () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(false)
  const first = vi.fn().mockRejectedValue(new Error("Sign in to access your dashboards."))
  const second = vi.fn().mockResolvedValue(undefined)
  const view = renderHook(({ refresh }) => useWorkspaceRefresh(true, refresh), { initialProps: { refresh: first } })
  await act(async () => fireEvent.focus(window))
  expect(view.result.current).toMatch(/Sign in/)
  view.rerender({ refresh: second })
  await act(async () => fireEvent.focus(window))
  expect(second).toHaveBeenCalledOnce()
  expect(view.result.current).toBe("")
})
