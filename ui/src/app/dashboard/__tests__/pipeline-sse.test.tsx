import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { usePipelineSSE } from "@/lib/pipeline-sse"

interface MockEvent {
  data: string
}

interface MockEventSource {
  onopen: ((e: MockEvent) => void) | null
  onmessage: ((e: MockEvent) => void) | null
  onerror: ((e: MockEvent) => void) | null
  close: ReturnType<typeof vi.fn>
}

describe("usePipelineSSE", () => {
  let mockEventSource: MockEventSource

  let originalEventSource: typeof globalThis.EventSource

  beforeEach(() => {
    vi.clearAllMocks()
    mockEventSource = {
      onopen: null,
      onmessage: null,
      onerror: null,
      close: vi.fn(),
    }
    originalEventSource = globalThis.EventSource
    globalThis.EventSource = vi.fn(function () {
      return mockEventSource
    }) as unknown as typeof globalThis.EventSource
  })

  afterEach(() => {
    globalThis.EventSource = originalEventSource
  })

  it("subscribes to per-pipeline topic and parses events", () => {
    const onEvent = vi.fn()
    renderHook(() => usePipelineSSE("ns", "pipe", onEvent))

    expect(EventSource).toHaveBeenCalledWith("/events?topic=pipeline%2Fns%2Fpipe")

    mockEventSource.onmessage?.({
      data: JSON.stringify({ type: "pipeline", name: "build", phase: "Running" }),
    })

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "pipeline", name: "build", phase: "Running" })
    )
  })

  it("ignores malformed events", () => {
    const onEvent = vi.fn()
    renderHook(() => usePipelineSSE("ns", "pipe", onEvent))

    mockEventSource.onmessage?.({ data: "not-json" })

    expect(onEvent).not.toHaveBeenCalled()
  })

  it("closes EventSource on unmount", () => {
    const { unmount } = renderHook(() => usePipelineSSE("ns", "pipe", vi.fn()))
    unmount()
    expect(mockEventSource.close).toHaveBeenCalledTimes(1)
  })

  it("parses events with timestamps", () => {
    const onEvent = vi.fn()
    renderHook(() => usePipelineSSE("ns", "pipe", onEvent))

    mockEventSource.onmessage?.({
      data: JSON.stringify({
        type: "pipeline",
        name: "build",
        phase: "Running",
        startedAt: 1000,
        completedAt: 1010,
      }),
    })

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "pipeline",
        name: "build",
        phase: "Running",
        startedAt: 1000,
        completedAt: 1010,
      })
    )
  })
})
