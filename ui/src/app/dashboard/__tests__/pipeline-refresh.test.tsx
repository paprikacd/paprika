import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FOCUSED_REFRESH_INTERVAL_MS } from "@/lib/fleet-refresh"
import { usePipelineRefresh } from "@/lib/pipeline-refresh"

describe("usePipelineRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("refreshes a focused pipeline immediately and every 15 seconds", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => usePipelineRefresh("ns", "pipe", refresh))
    await act(async () => Promise.resolve())
    expect(refresh).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUSED_REFRESH_INTERVAL_MS)
    })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it("waits until both pipeline identity fields are available", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const { rerender } = renderHook(
      ({ namespace, name }) => usePipelineRefresh(namespace, name, refresh),
      { initialProps: { namespace: "", name: "" } }
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUSED_REFRESH_INTERVAL_MS)
    })
    expect(refresh).not.toHaveBeenCalled()

    rerender({ namespace: "ns", name: "pipe" })
    await act(async () => Promise.resolve())
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
