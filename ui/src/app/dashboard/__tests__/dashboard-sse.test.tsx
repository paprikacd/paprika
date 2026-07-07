import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, waitFor, act, screen } from "@testing-library/react"
import DashboardPage from "../page"

// === MOCK CLIENT (hoisted so vi.mock factories can reference it) ===

const mockClient = vi.hoisted(() => ({
  listPipelines: vi.fn().mockResolvedValue({ pipelines: [] }),
  listReleases: vi.fn().mockResolvedValue({ releases: [] }),
  listApplications: vi.fn().mockResolvedValue({ applications: [] }),
  listApplicationSets: vi.fn().mockResolvedValue({ applicationsets: [] }),
  listPolicies: vi.fn().mockResolvedValue({ policies: [] }),
}))

const mockSetConnected = vi.hoisted(() => vi.fn())

// === MODULE-LEVEL MOCKS ===

vi.mock("@/lib/connection-context", () => ({
  useConnection: () => ({ setConnected: mockSetConnected }),
}))

vi.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: vi.fn(() => ({})),
}))

vi.mock("@connectrpc/connect", () => ({
  createPromiseClient: vi.fn(() => mockClient),
}))

vi.mock("@/gen/paprika/v1/api_connect", () => ({
  PaprikaService: {},
}))

vi.mock("@/components/dashboard/pipeline-card", () => ({
  PipelineCard: () => <div data-testid="pipeline-card" />,
}))

vi.mock("@/components/dashboard/release-table", () => ({
  ReleaseGrid: () => <div data-testid="release-grid" />,
}))

vi.mock("@/components/dashboard/application-card", () => ({
  ApplicationCard: () => <div data-testid="application-card" />,
}))

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: any) => <div data-testid="card">{children}</div>,
  CardContent: ({ children }: any) => <div data-testid="card-content">{children}</div>,
}))

vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: () => <span data-testid="status-badge" />,
}))

vi.mock("@/components/notifications/toast-stack", () => ({
  ToastStack: () => <div data-testid="toast-stack" />,
}))

vi.mock("lucide-react", () => {
  const Icon = (props: any) => <svg data-testid="icon" {...props} />
  return {
    GitBranch: Icon,
    ListChecks: Icon,
    Layers: Icon,
    Activity: Icon,
    Rocket: Icon,
    AlertTriangle: Icon,
    Shield: Icon,
    FolderTree: Icon,
  }
})

// === HELPERS ===

function makeEventData(type: string) {
  return JSON.stringify({ type, payload: {}, timestamp: new Date().toISOString() })
}

function makeSSEEvent(type: string) {
  return { data: makeEventData(type) }
}

function makeMalformedEvent() {
  return { data: "not valid json" }
}

// === TEST SUITE ===

describe("Dashboard SSE incremental updates", () => {
  let mockEventSource: {
    onopen: ((e: any) => void) | null
    onmessage: ((e: any) => void) | null
    onerror: ((e: any) => void) | null
    close: ReturnType<typeof vi.fn>
  }

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
    globalThis.EventSource = vi.fn(function () { return mockEventSource }) as unknown as typeof globalThis.EventSource
  })

  afterEach(() => {
    globalThis.EventSource = originalEventSource
  })

  describe("EventSource lifecycle", () => {
    it("creates EventSource with dashboard topic on mount", () => {
      render(<DashboardPage />)
      expect(EventSource).toHaveBeenCalledWith("/events?topic=dashboard")
    })

    it("closes EventSource on unmount", () => {
      const { unmount } = render(<DashboardPage />)
      unmount()
      expect(mockEventSource.close).toHaveBeenCalledTimes(1)
    })
  })

  describe("initial data load", () => {
    it("calls all 5 RPCs on mount", async () => {
      render(<DashboardPage />)
      await waitFor(() => {
        expect(mockClient.listPipelines).toHaveBeenCalledTimes(1)
        expect(mockClient.listReleases).toHaveBeenCalledTimes(1)
        expect(mockClient.listApplications).toHaveBeenCalledTimes(1)
        expect(mockClient.listApplicationSets).toHaveBeenCalledTimes(1)
        expect(mockClient.listPolicies).toHaveBeenCalledTimes(1)
      })
    })

    it("calls setConnected(true) when initial load succeeds", async () => {
      render(<DashboardPage />)
      await waitFor(() => {
        expect(mockSetConnected).toHaveBeenCalledWith(true)
      })
    })

    it("renders stat cards with data after load completes", async () => {
      render(<DashboardPage />)
      await waitFor(() => {
        expect(screen.getByText("Dashboard")).toBeInTheDocument()
      })
      expect(screen.getAllByText("Pipelines").length).toBeGreaterThanOrEqual(1)
      expect(screen.getByText("Running")).toBeInTheDocument()
      expect(screen.getAllByText("Applications")).toHaveLength(2) // stat card + section heading
    })
  })

  describe("SSE event dispatch routing", () => {
    async function renderAndWaitForLoad() {
      render(<DashboardPage />)
      await waitFor(() => {
        expect(mockClient.listPipelines).toHaveBeenCalled()
      })
      vi.clearAllMocks()
    }

    async function fireSSEEvent(event: { data: string }) {
      act(() => {
        mockEventSource.onmessage!(event)
      })
      // The onmessage handler sets a 300ms debounce.
      // After the debounce fires, refetchByEvent runs, which calls client methods.
      // The client methods return mockResolvedValue, so promises resolve on next microtask.
      await waitFor(() => {
        const allMocks = [
          mockClient.listPipelines,
          mockClient.listReleases,
          mockClient.listApplications,
          mockClient.listApplicationSets,
          mockClient.listPolicies,
        ]
        const anyCalled = allMocks.some((m) => m.mock.calls.length > 0)
        expect(anyCalled).toBe(true)
      }, { timeout: 1000, interval: 50 })
    }

    it("routes application event to listApplications + listApplicationSets only", async () => {
      await renderAndWaitForLoad()
      await fireSSEEvent(makeSSEEvent("application"))
      expect(mockClient.listApplications).toHaveBeenCalled()
      expect(mockClient.listApplicationSets).toHaveBeenCalled()
      expect(mockClient.listPipelines).not.toHaveBeenCalled()
      expect(mockClient.listReleases).not.toHaveBeenCalled()
      expect(mockClient.listPolicies).not.toHaveBeenCalled()
    })

    it("routes release event to listReleases + listApplications only", async () => {
      await renderAndWaitForLoad()
      await fireSSEEvent(makeSSEEvent("release"))
      expect(mockClient.listReleases).toHaveBeenCalled()
      expect(mockClient.listApplications).toHaveBeenCalled()
      expect(mockClient.listPipelines).not.toHaveBeenCalled()
      expect(mockClient.listApplicationSets).not.toHaveBeenCalled()
      expect(mockClient.listPolicies).not.toHaveBeenCalled()
    })

    it("routes audit event to full fetchData (all 5 RPCs)", async () => {
      await renderAndWaitForLoad()
      await fireSSEEvent(makeSSEEvent("audit"))
      expect(mockClient.listPipelines).toHaveBeenCalled()
      expect(mockClient.listReleases).toHaveBeenCalled()
      expect(mockClient.listApplications).toHaveBeenCalled()
      expect(mockClient.listApplicationSets).toHaveBeenCalled()
      expect(mockClient.listPolicies).toHaveBeenCalled()
    })

    it("routes unknown event type to full fetchData (default fallback)", async () => {
      await renderAndWaitForLoad()
      await fireSSEEvent(makeSSEEvent("unknown_type_here"))
      expect(mockClient.listPipelines).toHaveBeenCalled()
      expect(mockClient.listReleases).toHaveBeenCalled()
      expect(mockClient.listApplications).toHaveBeenCalled()
      expect(mockClient.listApplicationSets).toHaveBeenCalled()
      expect(mockClient.listPolicies).toHaveBeenCalled()
    })

    it("routes malformed JSON event to full fetchData (defaults to audit)", async () => {
      await renderAndWaitForLoad()
      await fireSSEEvent(makeMalformedEvent())
      expect(mockClient.listPipelines).toHaveBeenCalled()
      expect(mockClient.listReleases).toHaveBeenCalled()
      expect(mockClient.listApplications).toHaveBeenCalled()
      expect(mockClient.listApplicationSets).toHaveBeenCalled()
      expect(mockClient.listPolicies).toHaveBeenCalled()
    })

    it("routes JSON without type field to full fetchData (typeof check fails)", async () => {
      await renderAndWaitForLoad()
      await fireSSEEvent({ data: JSON.stringify({ payload: {} }) })
      expect(mockClient.listPipelines).toHaveBeenCalled()
      expect(mockClient.listReleases).toHaveBeenCalled()
      expect(mockClient.listApplications).toHaveBeenCalled()
      expect(mockClient.listApplicationSets).toHaveBeenCalled()
      expect(mockClient.listPolicies).toHaveBeenCalled()
    })

    it("routes JSON with non-string type field to full fetchData", async () => {
      await renderAndWaitForLoad()
      await fireSSEEvent({ data: JSON.stringify({ type: 42 }) })
      expect(mockClient.listPipelines).toHaveBeenCalled()
      expect(mockClient.listReleases).toHaveBeenCalled()
      expect(mockClient.listApplications).toHaveBeenCalled()
      expect(mockClient.listApplicationSets).toHaveBeenCalled()
      expect(mockClient.listPolicies).toHaveBeenCalled()
    })
  })

  describe("debounce and throttle", () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
        now: new Date("2026-06-22T00:00:00Z"),
      })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    async function renderAndWaitForLoad() {
      render(<DashboardPage />)
      // Fire the initial setTimeout(fetchData, 0)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await vi.waitFor(() => {
        expect(mockClient.listPipelines).toHaveBeenCalled()
      })
      vi.clearAllMocks()
    }

    it("debounces rapid events into a single refetch", async () => {
      await renderAndWaitForLoad()

      // Fire two events in quick succession before debounce fires
      act(() => { mockEventSource.onmessage!(makeSSEEvent("application")) })
      act(() => { mockEventSource.onmessage!(makeSSEEvent("application")) })

      // Advance past 300ms debounce
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })

      // Only one refetch should have happened
      expect(mockClient.listApplications).toHaveBeenCalledTimes(1)
    })

    it("suppresses events within MIN_FETCH_INTERVAL (5s)", async () => {
      await renderAndWaitForLoad()

      // Fire first event at T=0 (base time)
      act(() => { mockEventSource.onmessage!(makeSSEEvent("audit")) })

      // Advance past debounce (300ms). Debounce fires, refetch runs.
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })

      // Clear mocks now that first refetch is confirmed
      vi.clearAllMocks()

      // Fire second event immediately (still T=base+300 in terms of event arrival)
      // lastFetchRef.current = base+300, now = base+300
      // 300 - 300 = 0 < 5000 → SKIP
      act(() => { mockEventSource.onmessage!(makeSSEEvent("audit")) })

      // Advance past debounce (300ms)
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })

      // No new calls because the interval check suppressed the event
      expect(mockClient.listPipelines).not.toHaveBeenCalled()
      expect(mockClient.listReleases).not.toHaveBeenCalled()
      expect(mockClient.listApplications).not.toHaveBeenCalled()
      expect(mockClient.listApplicationSets).not.toHaveBeenCalled()
      expect(mockClient.listPolicies).not.toHaveBeenCalled()
    })
  })
})
