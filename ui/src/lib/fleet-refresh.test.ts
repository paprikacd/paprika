import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  FLEET_REFRESH_INTERVAL_MS,
  FOCUSED_REFRESH_INTERVAL_MS,
  MAX_REFRESH_INTERVAL_MS,
  useFleetRefresh,
  useFocusedRefresh,
  useSingleFlightRefresh,
} from "@/lib/fleet-refresh"

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  })
  document.dispatchEvent(new Event("visibilitychange"))
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe("bounded fleet refresh", () => {
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

  it("refreshes fleet data immediately and every 60 seconds while visible", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useFleetRefresh(refresh))
    await flushEffects()

    expect(refresh).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLEET_REFRESH_INTERVAL_MS - 1)
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it("can treat an existing query as the initial refresh without duplicating it", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useFleetRefresh(refresh, { refreshOnMount: false }))
    await flushEffects()
    expect(refresh).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLEET_REFRESH_INTERVAL_MS)
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("refreshes focused application and pipeline data every 15 seconds", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useFocusedRefresh(refresh))
    await flushEffects()
    expect(refresh).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUSED_REFRESH_INTERVAL_MS)
    })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it("stops timers while hidden and resumes the clock without a hidden refresh", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useFleetRefresh(refresh))
    await flushEffects()
    expect(refresh).toHaveBeenCalledTimes(1)

    act(() => setVisibility("hidden"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLEET_REFRESH_INTERVAL_MS * 4)
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    act(() => setVisibility("visible"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLEET_REFRESH_INTERVAL_MS)
    })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it("performs exactly one immediate refresh when window focus returns", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useFleetRefresh(refresh))
    await flushEffects()
    expect(refresh).toHaveBeenCalledTimes(1)

    act(() => setVisibility("hidden"))
    act(() => setVisibility("visible"))
    expect(refresh).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event("focus"))
    await flushEffects()
    expect(refresh).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLEET_REFRESH_INTERVAL_MS - 1)
    })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it("backs failed focused refreshes off exponentially and caps at 120 seconds", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("offline"))

    renderHook(() => useFocusedRefresh(refresh))
    await flushEffects()
    expect(refresh).toHaveBeenCalledTimes(1)

    for (const [delay, expectedCalls] of [
      [FOCUSED_REFRESH_INTERVAL_MS * 2, 2],
      [FOCUSED_REFRESH_INTERVAL_MS * 4, 3],
      [MAX_REFRESH_INTERVAL_MS, 4],
      [MAX_REFRESH_INTERVAL_MS, 5],
    ] as const) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 1)
      })
      expect(refresh).toHaveBeenCalledTimes(expectedCalls - 1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(refresh).toHaveBeenCalledTimes(expectedCalls)
    }
  })

  it("resets backoff after a successful request and reports each outcome", async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined)
    const onRequestOutcome = vi.fn()

    renderHook(() => useFocusedRefresh(refresh, { onRequestOutcome }))
    await flushEffects()
    expect(onRequestOutcome).toHaveBeenLastCalledWith(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUSED_REFRESH_INTERVAL_MS * 2)
    })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(onRequestOutcome).toHaveBeenLastCalledWith(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUSED_REFRESH_INTERVAL_MS)
    })
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it("suppresses overlapping refreshes", async () => {
    let resolveRefresh: (() => void) | undefined
    const refresh = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveRefresh = resolve
      })
    )

    renderHook(() => useFleetRefresh(refresh))
    await flushEffects()
    expect(refresh).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event("focus"))
    window.dispatchEvent(new Event("focus"))
    expect(refresh).toHaveBeenCalledTimes(1)

    await act(async () => resolveRefresh?.())
  })

  it("does not run when disabled", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)

    renderHook(() => useFocusedRefresh(refresh, { enabled: false }))
    await flushEffects()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_REFRESH_INTERVAL_MS)
    })

    expect(refresh).not.toHaveBeenCalled()
  })

  it("shares one in-flight request across scheduled and manual callers", async () => {
    let resolveRefresh: (() => void) | undefined
    const refresh = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveRefresh = resolve
      }),
    )
    const { result } = renderHook(() => useSingleFlightRefresh(refresh))

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current()
      second = result.current()
    })
    await act(async () => Promise.resolve())
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)

    await act(async () => resolveRefresh?.())
    refresh.mockResolvedValueOnce(undefined)
    await act(async () => result.current())
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
