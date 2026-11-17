import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render as rtlRender, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ResourceDetailPanel } from "@/components/dashboard/resource-detail-panel"
import { LogChunk } from "@/gen/paprika/v1/api_pb"

// Mock the Connect RPC client.
const mockClient = vi.hoisted(() => ({
  getResource: vi.fn(),
  getResourceLogs: vi.fn(),
  getResourceTreeDetailed: vi.fn(),
  streamResourceLogs: vi.fn(),
  investigate: vi.fn(),
  listInvestigatorPlugins: vi.fn(),
}))

// The session module is stubbed so the recovery before an Unauthenticated retry can
// be observed without a real auth configuration. The recovery mock follows the
// contract of browser-session's recoverUnauthorized: it returns the current token when
// the app already holds a token other than the rejected one, and otherwise refreshes.
const mockSession = vi.hoisted(() => ({
  ensureValidSession: vi.fn(),
  recoverUnauthorized: vi.fn(),
  getSessionSnapshot: vi.fn(),
}))
vi.mock("@/lib/browser-session", () => ({
  ensureValidSession: mockSession.ensureValidSession,
  recoverUnauthorized: mockSession.recoverUnauthorized,
  getSessionSnapshot: mockSession.getSessionSnapshot,
}))
vi.mock("@connectrpc/connect-web", () => ({ createConnectTransport: vi.fn(() => ({})) }))
vi.mock("@connectrpc/connect", () => ({ createPromiseClient: vi.fn(() => mockClient) }))
vi.mock("@/gen/paprika/v1/api_connect", () => ({ PaprikaService: {} }))

vi.mock("lucide-react", () => {
  const Icon = (p: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon" {...p} />
  return {
    X: Icon,
    FileText: Icon,
    GitCompare: Icon,
    ListChecks: Icon,
    Loader2: Icon,
    CheckCircle2: Icon,
    AlertTriangle: Icon,
    Terminal: Icon,
    RefreshCw: Icon,
    Pause: Icon,
    Play: Icon,
    Search: Icon,
    Wifi: Icon,
    WifiOff: Icon,
    Sparkles: Icon,
    Rows3: Icon,
  }
})

const resource = {
  kind: "Deployment",
  name: "demo-deploy",
  namespace: "test-ns",
  syncStatus: "Synced",
  health: "Healthy",
  healthMessage: "All good",
}

/**
 * Build an async iterable that yields the given items lazily and never
 * completes (until break). Mimics the Connect server-streaming iterable
 * shape closely enough for test purposes.
 */
function asyncIter<T>(items: T[]): AsyncIterable<T> {
  let i = 0
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (i >= items.length) {
            return new Promise<IteratorResult<T>>(() => {}) // never resolves
          }
          return Promise.resolve({ value: items[i++], done: false })
        },
        async return(): Promise<IteratorResult<T>> {
          return { value: undefined as unknown as T, done: true }
        },
      }
    },
  }
}

function emptyIter(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<never>> {
          return { value: undefined as never, done: true }
        },
        async return(): Promise<IteratorResult<never>> {
          return { value: undefined as never, done: true }
        },
      }
    },
  }
}

describe("ResourceDetailPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.investigate.mockResolvedValue({ summary: "All clear", narrator: "deterministic", findings: [] })
    mockClient.listInvestigatorPlugins.mockResolvedValue({ plugins: [] })
  })

  it("shows loading state while fetching", () => {
    mockClient.getResource.mockReturnValue(new Promise(() => {}))
    render(
      <ResourceDetailPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole("dialog", { name: /demo-deploy/ })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "demo-deploy" })).toBeInTheDocument()
    expect(screen.getByText("DEPLOYMENT")).toBeInTheDocument()
  })

  it("renders diff tab with syntax highlighting when data loads", async () => {
    mockClient.getResource.mockResolvedValue({
      kind: "Deployment",
      name: "demo-deploy",
      namespace: "test-ns",
      syncStatus: "Synced",
      healthStatus: "Healthy",
      healthMessage: "All good",
      liveManifest: "spec:\n  replicas: 2",
      desiredManifest: "spec:\n  replicas: 1",
      diff: "--- Desired\n+++ Live\n@@ -1,2 +1,2 @@\n spec:\n-  replicas: 1\n+  replicas: 2",
      apiVersion: "apps/v1",
      resource: "deployments",
      uid: "deploy-uid",
      labels: { "app.kubernetes.io/name": "demo" },
      events: [],
    })

    render(
      <ResourceDetailPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
    expect(screen.getByText(/replicas: 1/)).toBeInTheDocument()
    })
    expect(screen.getByText(/replicas: 2/)).toBeInTheDocument()
    expect(screen.getByText("apps/v1")).toBeInTheDocument()
    expect(screen.getByText("deployments")).toBeInTheDocument()
    expect(screen.getByText("deploy-uid")).toBeInTheDocument()
    expect(screen.getByText("app.kubernetes.io/name=demo")).toBeInTheDocument()
  })

  it("shows no-diff message when diff is empty", async () => {
    mockClient.getResource.mockResolvedValue({
      kind: "Deployment",
      name: "demo-deploy",
      namespace: "test-ns",
      syncStatus: "Synced",
      healthStatus: "Healthy",
      healthMessage: "",
      liveManifest: "spec:\n  replicas: 1",
      desiredManifest: "spec:\n  replicas: 1",
      diff: "",
      events: [],
    })

    render(
      <ResourceDetailPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/No differences/i)).toBeInTheDocument()
    })
  })

  it("shows a changed Secret value as marked lines, not as no differences", async () => {
    // The server marks a value-only change to a Secret on each side, so the diff is not empty.
    mockClient.getResource.mockResolvedValue({
      kind: "Secret",
      name: "shop-creds",
      namespace: "test-ns",
      syncStatus: "OutOfSync",
      healthStatus: "",
      healthMessage: "",
      liveManifest: "data:\n  password: '<redacted: live value differs>'",
      desiredManifest: "data:\n  password: '<redacted: desired value differs>'",
      diff: "--- Desired\n+++ Live\n@@ -1,2 +1,2 @@\n data:\n-  password: '<redacted: desired value differs>'\n+  password: '<redacted: live value differs>'",
      events: [],
    })

    render(
      <ResourceDetailPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getAllByText(/<redacted: desired value differs>/).length).toBeGreaterThan(0)
    })
    expect(screen.getAllByText(/<redacted: live value differs>/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/No differences/i)).not.toBeInTheDocument()
  })

  it("switches to events tab and shows k8s events", async () => {
    const user = userEvent.setup()
    mockClient.getResource.mockResolvedValue({
      kind: "Deployment",
      name: "demo-deploy",
      namespace: "test-ns",
      syncStatus: "Synced",
      healthStatus: "Healthy",
      healthMessage: "",
      liveManifest: "spec: {}",
      desiredManifest: "spec: {}",
      diff: "",
      events: [
        { type: "Warning", reason: "FailedScheduling", message: "Insufficient cpu", lastTimestamp: "2024-01-01T00:00:00Z", count: BigInt(3), involvedObjectKind: "Deployment", involvedObjectName: "demo-deploy" },
        { type: "Normal", reason: "Scheduled", message: "Successfully assigned", lastTimestamp: "2024-01-01T00:01:00Z", count: BigInt(1), involvedObjectKind: "Deployment", involvedObjectName: "demo-deploy" },
      ],
    })

    render(
      <ResourceDetailPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Diff" })).toBeInTheDocument()
    })
    await user.click(screen.getByRole("tab", { name: "Events" }))

    expect(screen.getByText("FailedScheduling")).toBeInTheDocument()
    expect(screen.getByText("Insufficient cpu")).toBeInTheDocument()
    expect(screen.getByText(/3 ×/)).toBeInTheDocument()
    expect(screen.getByText("Scheduled")).toBeInTheDocument()
  })

  it("shows error message when API call fails", async () => {
    mockClient.getResource.mockRejectedValue(new Error("permission denied"))

    render(
      <ResourceDetailPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText("permission denied")).toBeInTheDocument()
    })
  })

  it("calls onClose when close button is clicked", async () => {
    const onClose = vi.fn()
    mockClient.getResource.mockResolvedValue({
      kind: "Deployment",
      name: "demo-deploy",
      namespace: "test-ns",
      syncStatus: "Synced",
      healthStatus: "Healthy",
      healthMessage: "",
      liveManifest: "",
      desiredManifest: "",
      diff: "",
      events: [],
    })

    const { container } = render(
      <ResourceDetailPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={onClose}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "demo-deploy" })).toBeInTheDocument()
    })

    const backdrop = container.querySelector(".fixed.inset-0")
    await userEvent.click(backdrop!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("moves between tabs with the arrow keys and closes on Escape", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    mockClient.getResource.mockResolvedValue({
      kind: "Deployment",
      name: "demo-deploy",
      namespace: "test-ns",
      syncStatus: "Synced",
      healthStatus: "Healthy",
      healthMessage: "",
      liveManifest: "spec: {}",
      desiredManifest: "spec: {}",
      diff: "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b",
      events: [],
    })

    render(
      <ResourceDetailPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={onClose}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Diff" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    )

    screen.getByRole("tab", { name: "Diff" }).focus()
    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("tab", { name: "Live" })).toHaveAttribute(
      "aria-selected",
      "true",
    )

    await user.keyboard("{Escape}")
    expect(onClose).toHaveBeenCalled()
  })

  describe("LogsTab (streaming)", () => {
    beforeEach(() => {
      mockClient.getResource.mockResolvedValue({
        kind: "Deployment",
        name: "demo-deploy",
        namespace: "test-ns",
        syncStatus: "Synced",
        healthStatus: "Healthy",
        healthMessage: "",
        liveManifest: "",
        desiredManifest: "",
        diff: "",
        events: [],
      })
      // mockReset clears queued mockReturnValueOnce values, which clearAllMocks keeps,
      // so a failing test cannot leak an unused stream into the next one.
      mockClient.streamResourceLogs.mockReset()
      mockClient.streamResourceLogs.mockReturnValue(emptyIter())
      mockSession.ensureValidSession.mockReset()
      mockSession.ensureValidSession.mockResolvedValue("refreshed-token")
      // The stream opens with the rejected token, as the app holds it at open.
      mockSession.getSessionSnapshot.mockReset()
      mockSession.getSessionSnapshot.mockReturnValue({ idToken: "rejected-token" })
      mockSession.recoverUnauthorized.mockReset()
      mockSession.recoverUnauthorized.mockImplementation(async (rejected: string | null) => {
        const current = mockSession.getSessionSnapshot().idToken
        if (rejected !== current) return current
        return mockSession.ensureValidSession({ forceRefresh: true })
      })
    })

    it("subscribes to streamResourceLogs when Logs tab opens", async () => {
      const user = userEvent.setup()
      render(
        <ResourceDetailPanel
          applicationNamespace="test-ns"
          applicationName="demo-app"
          resource={resource}
          onClose={vi.fn()}
        />,
      )
      await waitFor(() =>
        expect(screen.getByRole("tab", { name: "Diff" })).toBeInTheDocument(),
      )
      await user.click(screen.getByRole("tab", { name: "Logs" }))

      expect(mockClient.streamResourceLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceKind: "Deployment",
          resourceName: "demo-deploy",
          resourceNamespace: "test-ns",
          follow: true,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })

    describe("when a stream ends with an error code", () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      // afterMs moves the clock forward before the failure, as a periodic re-check
      // does: the failure then arrives that long after the stream opened.
      function chunksThenFail(chunks: LogChunk[], code: number, afterMs = 0): AsyncIterable<LogChunk> {
        const failure = Object.assign(new Error(`[${code}] stream ended`), { code })
        let i = 0
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<LogChunk>> {
                if (i < chunks.length) return { value: chunks[i++], done: false }
                if (afterMs) vi.setSystemTime(Date.now() + afterMs)
                throw failure
              },
            }
          },
        }
      }

      function failingStream(code: number, message: string, afterMs = 0): AsyncIterable<never> {
        const failure = Object.assign(new Error(message), { code })
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<never>> {
                if (afterMs) vi.setSystemTime(Date.now() + afterMs)
                throw failure
              },
            }
          },
        } as AsyncIterable<never>
      }

      const FIVE_MINUTES_MS = 5 * 60_000

      async function openLogsTab() {
        // advanceTimers lets userEvent work while the fake clock is in use.
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
        render(
          <ResourceDetailPanel
            applicationNamespace="test-ns"
            applicationName="demo-app"
            resource={resource}
            onClose={vi.fn()}
          />,
        )
        await waitFor(() =>
          expect(screen.getByRole("tab", { name: "Diff" })).toBeInTheDocument(),
        )
        await user.click(screen.getByRole("tab", { name: "Logs" }))
      }

      it.each([
        ["InvalidArgument", 3, /nope/],
        ["PermissionDenied", 7, /nope/],
        ["Unimplemented", 12, /not available on this server/],
      ])("stops retrying a log stream that ends with %s (code %i)", async (_name, code, text) => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        mockClient.streamResourceLogs.mockReturnValue(failingStream(code, `[${code}] nope`))

        await openLogsTab()
        await waitFor(() => expect(screen.getByText(text)).toBeInTheDocument())
        await vi.advanceTimersByTimeAsync(5000)
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(1)
        expect(screen.queryByText(/reconnecting/)).not.toBeInTheDocument()
      })

      it("reconnects after InvalidArgument that arrives after a chunk", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const one = new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "chunk-before-invalid", timestampMs: BigInt(1) })
        mockClient.streamResourceLogs
          .mockReturnValueOnce(chunksThenFail([one], 3))
          .mockReturnValueOnce(asyncIter([]))

        await openLogsTab()
        await waitFor(() =>
          expect(screen.getByTestId("logs-output")).toHaveTextContent(/chunk-before-invalid/),
        )
        await waitFor(() => expect(screen.getByText(/stream ended/)).toBeInTheDocument())
        // The reconnect waits for the backoff, so the stream is not reopened at once.
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1000)
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(2)
      })

      it("ends at once when InvalidArgument arrives before the first chunk of a reopened stream", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        mockClient.streamResourceLogs
          .mockReturnValueOnce(failingStream(14, "[14] unavailable"))
          .mockReturnValueOnce(failingStream(3, "[3] invalid name"))

        await openLogsTab()
        await waitFor(() => expect(screen.getByText(/unavailable/)).toBeInTheDocument())
        await vi.advanceTimersByTimeAsync(1000)
        await waitFor(() => expect(screen.getByText(/invalid name/)).toBeInTheDocument())
        await vi.advanceTimersByTimeAsync(5000)
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(2)
        expect(screen.queryByText(/reconnecting/)).not.toBeInTheDocument()
      })

      it("reconnects when a reopened stream gets InvalidArgument before its first chunk, after an earlier stream sent lines", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const one = new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "line-before-reopen", timestampMs: BigInt(1) })
        mockClient.streamResourceLogs
          .mockReturnValueOnce(chunksThenFail([one], 14))
          .mockReturnValueOnce(failingStream(3, "[3] invalid name"))
          .mockReturnValueOnce(asyncIter([]))

        await openLogsTab()
        await waitFor(() => expect(screen.getByText(/stream ended/)).toBeInTheDocument())
        await vi.advanceTimersByTimeAsync(1000)
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(2)
        await waitFor(() => expect(screen.getByText(/invalid name/)).toBeInTheDocument())
        await vi.advanceTimersByTimeAsync(2000)
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(3)
      })

      it("reconnects once at once after Unauthenticated, after forcing a token refresh", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const chunks: LogChunk[] = [
          new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "after refresh", timestampMs: BigInt(1) }),
        ]
        mockClient.streamResourceLogs
          .mockReturnValueOnce(failingStream(16, "[16] token expired"))
          .mockReturnValueOnce(asyncIter(chunks))

        await openLogsTab()
        await waitFor(() =>
          expect(screen.getByTestId("logs-output")).toHaveTextContent(/after refresh/),
        )
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(2)
        expect(mockSession.ensureValidSession).toHaveBeenCalledWith({ forceRefresh: true })
        expect(screen.queryByText(/token expired/)).not.toBeInTheDocument()
      })

      it("recovers against the token the stream opened with, and refreshes when that token is still current", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const chunks: LogChunk[] = [
          new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "after-current", timestampMs: BigInt(1) }),
        ]
        mockClient.streamResourceLogs
          .mockReturnValueOnce(failingStream(16, "[16] token expired"))
          .mockReturnValueOnce(asyncIter(chunks))

        await openLogsTab()
        await waitFor(() =>
          expect(screen.getByTestId("logs-output")).toHaveTextContent(/after-current/),
        )
        expect(mockSession.recoverUnauthorized).toHaveBeenCalledWith("rejected-token")
        expect(mockSession.ensureValidSession).toHaveBeenCalledWith({ forceRefresh: true })
      })

      it("does not refresh again when the app already holds a newer token", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const chunks: LogChunk[] = [
          new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "after-newer", timestampMs: BigInt(1) }),
        ]
        // The app replaces the token while the stream is open, before the 16 arrives.
        const rejectedAfterReplace = {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<never>> {
                mockSession.getSessionSnapshot.mockReturnValue({ idToken: "newer-token" })
                throw Object.assign(new Error("[16] token expired"), { code: 16 })
              },
            }
          },
        } as AsyncIterable<never>
        mockClient.streamResourceLogs
          .mockReturnValueOnce(rejectedAfterReplace)
          .mockReturnValueOnce(asyncIter(chunks))

        await openLogsTab()
        await waitFor(() =>
          expect(screen.getByTestId("logs-output")).toHaveTextContent(/after-newer/),
        )
        expect(mockSession.recoverUnauthorized).toHaveBeenCalledWith("rejected-token")
        expect(mockSession.ensureValidSession).not.toHaveBeenCalled()
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(2)
      })

      it("reconnects again after a repeated 16 that arrives five minutes after open", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const chunks: LogChunk[] = [
          new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "after-second-expiry", timestampMs: BigInt(1) }),
        ]
        // The first 16 is answered with one retry. The retry is chunkless, and its
        // 16 comes five minutes later, a new expiry rather than a repeat at open.
        mockClient.streamResourceLogs
          .mockReturnValueOnce(failingStream(16, "[16] token expired"))
          .mockReturnValueOnce(failingStream(16, "[16] token expired", FIVE_MINUTES_MS))
          .mockReturnValueOnce(asyncIter(chunks))

        await openLogsTab()
        await waitFor(() =>
          expect(screen.getByTestId("logs-output")).toHaveTextContent(/after-second-expiry/),
          { timeout: 4000 },
        )
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(3)
        expect(mockSession.recoverUnauthorized).toHaveBeenCalledTimes(2)
      })

      it("keeps the one retry after each Unauthenticated that follows a chunk", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const one = new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "chunk-one", timestampMs: BigInt(1) })
        const two = new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "chunk-two", timestampMs: BigInt(2) })
        const three = new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "chunk-three", timestampMs: BigInt(3) })
        // A chunk between two 16s resets the one-retry budget, so the second 16
        // also reconnects. Without the reset it would be final after two calls.
        mockClient.streamResourceLogs
          .mockReturnValueOnce(chunksThenFail([one], 16))
          .mockReturnValueOnce(chunksThenFail([two], 16))
          .mockReturnValueOnce(asyncIter([three]))

        await openLogsTab()
        await waitFor(() =>
          expect(screen.getByTestId("logs-output")).toHaveTextContent(/chunk-three/),
        )
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(3)
        expect(mockSession.ensureValidSession).toHaveBeenCalledTimes(2)
        expect(mockSession.ensureValidSession).toHaveBeenNthCalledWith(1, { forceRefresh: true })
        expect(mockSession.ensureValidSession).toHaveBeenNthCalledWith(2, { forceRefresh: true })
        expect(screen.queryByText(/stream ended/)).not.toBeInTheDocument()
      })

      it("ends with the renewal message and does not retry when there is no session", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        mockSession.ensureValidSession.mockResolvedValue(null)
        mockClient.streamResourceLogs.mockReturnValue(failingStream(16, "[16] token expired"))

        await openLogsTab()
        await waitFor(() =>
          expect(screen.getByText(/could not be renewed/)).toBeInTheDocument(),
        )
        await vi.advanceTimersByTimeAsync(5000)
        // A retry without a session would carry no bearer, so none is made.
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(1)
      })

      it("reconnects with backoff when the forced refresh fails, then uses the still-valid token", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const chunks: LogChunk[] = [
          new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "after-failed-refresh", timestampMs: BigInt(1) }),
        ]
        mockSession.ensureValidSession.mockRejectedValueOnce(new Error("refresh endpoint down"))
        mockClient.streamResourceLogs
          .mockReturnValueOnce(failingStream(16, "[16] token expired"))
          .mockReturnValueOnce(asyncIter(chunks))

        await openLogsTab()
        await waitFor(() => expect(mockSession.ensureValidSession).toHaveBeenCalledTimes(1))
        expect(mockSession.ensureValidSession).toHaveBeenCalledWith({ forceRefresh: true })
        // The failed refresh schedules the reconnect with backoff, so the stream is
        // not reopened at once. An immediate reopen would make the second call here.
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(500)
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1000)
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(2)
        await waitFor(() =>
          expect(screen.getByTestId("logs-output")).toHaveTextContent(/after-failed-refresh/),
        )
      })

      it("ends at once with a clear message when the stream limit is reached", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        mockClient.streamResourceLogs.mockReturnValue(failingStream(8, "[8] too many"))

        await openLogsTab()
        await waitFor(() =>
          expect(screen.getByText(/Too many log streams are open/)).toBeInTheDocument(),
        )
        await vi.advanceTimersByTimeAsync(5000)
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(1)
      })

      it("ends at once when the resource or its application is not found at open", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        mockClient.streamResourceLogs.mockReturnValue(failingStream(5, "[5] application missing"))

        await openLogsTab()
        await waitFor(() =>
          expect(screen.getByText(/This resource or its application no longer exists\./)).toBeInTheDocument(),
        )
        await vi.advanceTimersByTimeAsync(5000)
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(1)
      })

      it("reconnects when the application is recreated mid-follow, so a NotFound from the re-check is not final", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const before = new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "before-recreate", timestampMs: BigInt(1) })
        const after = new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "after-recreate", timestampMs: BigInt(2) })
        // The re-check runs five minutes after open, so its NotFound is not an open failure.
        mockClient.streamResourceLogs
          .mockReturnValueOnce(chunksThenFail([before], 5, FIVE_MINUTES_MS))
          .mockReturnValueOnce(asyncIter([after]))

        await openLogsTab()
        // The reconnect waits one backoff step (1 s), so allow more than the default wait.
        await waitFor(() =>
          expect(screen.getByTestId("logs-output")).toHaveTextContent(/after-recreate/),
          { timeout: 4000 },
        )
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(2)
        expect(screen.queryByText(/This resource or its application no longer exists\./)).not.toBeInTheDocument()
      })

      it("ends at once when the resource or its application is missing at the reconnect's open", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const before = new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "before-delete", timestampMs: BigInt(1) })
        // The first stream sends a line, then the re-check finds the application gone five
        // minutes after open, so the panel reconnects once. The reconnect gets NotFound at
        // open, which is final. A stream that kept reconnecting would call again.
        mockClient.streamResourceLogs
          .mockReturnValueOnce(chunksThenFail([before], 5, FIVE_MINUTES_MS))
          .mockReturnValueOnce(failingStream(5, "[5] application missing"))

        await openLogsTab()
        // The reconnect waits one backoff step (1 s), so allow more than the default wait.
        await waitFor(() =>
          expect(screen.getByText(/This resource or its application no longer exists\./)).toBeInTheDocument(),
          { timeout: 4000 },
        )
        await vi.advanceTimersByTimeAsync(5000)
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(2)
      })

      it("reconnects once when a chunkless follow's re-check returns NotFound after five minutes", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        mockClient.streamResourceLogs
          .mockReturnValueOnce(failingStream(5, "[5] application missing", FIVE_MINUTES_MS))
          .mockReturnValueOnce(failingStream(5, "[5] application missing"))

        await openLogsTab()
        await waitFor(() => expect(screen.getByText(/This resource or its application no longer exists\./)).toBeInTheDocument(), {
          timeout: 4000,
        })
        await vi.advanceTimersByTimeAsync(5000)
        // One reconnect after the re-check, then the NotFound at open ends the follow.
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(2)
      })

      it("reconnects after each late NotFound, so a recreated application streams on the third open", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const after = new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "after-second-recreate", timestampMs: BigInt(3) })
        // Two re-checks five minutes after open each find the application missing. Each
        // reconnect opens anew, so a NotFound that arrives late is not final on its own.
        mockClient.streamResourceLogs
          .mockReturnValueOnce(failingStream(5, "[5] application missing", FIVE_MINUTES_MS))
          .mockReturnValueOnce(failingStream(5, "[5] application missing", FIVE_MINUTES_MS))
          .mockReturnValueOnce(asyncIter([after]))

        await openLogsTab()
        await waitFor(() => expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(1))
        // The first re-check fails, and the reconnect waits one backoff step (1 s).
        await vi.advanceTimersByTimeAsync(1000)
        await waitFor(() => expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(2))
        // The second re-check fails too. Nothing arrived in between to reset the
        // backoff, so its reconnect waits the next step (2 s).
        await vi.advanceTimersByTimeAsync(2000)
        await waitFor(() =>
          expect(screen.getByTestId("logs-output")).toHaveTextContent(/after-second-recreate/),
        )
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(3)
        expect(screen.queryByText(/This resource or its application no longer exists\./)).not.toBeInTheDocument()
      })

      it("stops after a second Unauthenticated in a row and shows the error", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        mockClient.streamResourceLogs.mockReturnValue(failingStream(16, "[16] token expired"))

        await openLogsTab()
        await waitFor(() => expect(screen.getByText(/token expired/)).toBeInTheDocument())
        await vi.advanceTimersByTimeAsync(5000)
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(2)
      })

      it("replaces the buffer when a reconnect replays the log, so no line shows twice", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const replayed = new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "replayed-line", timestampMs: BigInt(1) })
        const fresh = new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "fresh-line", timestampMs: BigInt(2) })
        // The first stream sends one line, then ends Unauthenticated. The reconnect
        // replays the pod log from the start, so the replayed line arrives again.
        mockClient.streamResourceLogs
          .mockReturnValueOnce(chunksThenFail([replayed], 16))
          .mockReturnValueOnce(asyncIter([replayed, fresh]))

        await openLogsTab()
        const output = await screen.findByTestId("logs-output")
        await waitFor(() => expect(output).toHaveTextContent(/fresh-line/))
        expect(mockClient.streamResourceLogs).toHaveBeenCalledTimes(2)
        expect((output.textContent ?? "").split("replayed-line")).toHaveLength(2)
      })

    })

    it("aborts the log stream when the panel unmounts", async () => {
      const user = userEvent.setup()
      const { unmount } = render(
        <ResourceDetailPanel
          applicationNamespace="test-ns"
          applicationName="demo-app"
          resource={resource}
          onClose={vi.fn()}
        />,
      )
      await waitFor(() =>
        expect(screen.getByRole("tab", { name: "Diff" })).toBeInTheDocument(),
      )
      await user.click(screen.getByRole("tab", { name: "Logs" }))
      await waitFor(() => expect(mockClient.streamResourceLogs).toHaveBeenCalled())

      const options = mockClient.streamResourceLogs.mock.calls[0][1] as { signal: AbortSignal }
      expect(options.signal.aborted).toBe(false)
      unmount()
      expect(options.signal.aborted).toBe(true)
    })

    it("renders each streamed chunk line", async () => {
      const user = userEvent.setup()
      const chunks: LogChunk[] = [
        new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "starting up", timestampMs: BigInt(1) }),
        new LogChunk({ podName: "demo-deploy-pod", containerName: "app", line: "ready", timestampMs: BigInt(2) }),
      ]
      mockClient.streamResourceLogs.mockReturnValue(asyncIter(chunks))

      render(
        <ResourceDetailPanel
          applicationNamespace="test-ns"
          applicationName="demo-app"
          resource={resource}
          onClose={vi.fn()}
        />,
      )
      await waitFor(() =>
        expect(screen.getByRole("tab", { name: "Diff" })).toBeInTheDocument(),
      )
      await user.click(screen.getByRole("tab", { name: "Logs" }))

      const output = await screen.findByTestId("logs-output")
      await waitFor(() => {
        expect(output).toHaveTextContent(/starting up/)
        expect(output).toHaveTextContent(/ready/)
      })
    })

    it("filter input narrows visible lines", async () => {
      const user = userEvent.setup()
      const chunks: LogChunk[] = [
        new LogChunk({ podName: "p", containerName: "c", line: "hello", timestampMs: BigInt(1) }),
        new LogChunk({ podName: "p", containerName: "c", line: "world", timestampMs: BigInt(2) }),
        new LogChunk({ podName: "p", containerName: "c", line: "hello again", timestampMs: BigInt(3) }),
      ]
      mockClient.streamResourceLogs.mockReturnValue(asyncIter(chunks))

      render(
        <ResourceDetailPanel
          applicationNamespace="test-ns"
          applicationName="demo-app"
          resource={resource}
          onClose={vi.fn()}
        />,
      )
      await waitFor(() =>
        expect(screen.getByRole("tab", { name: "Diff" })).toBeInTheDocument(),
      )
      await user.click(screen.getByRole("tab", { name: "Logs" }))

      await waitFor(() => expect(screen.getByTestId("logs-output")).toHaveTextContent(/again/))

      const input = screen.getByTestId("logs-filter") as HTMLInputElement
      await user.type(input, "hello")

      const output = await screen.findByTestId("logs-output")
      await waitFor(() => {
        expect(output).not.toHaveTextContent(/world/)
      })
      // The visible buffer should still contain hello-related lines, but never "world".
      expect(output).toHaveTextContent(/hello/)
    })

    it("pause toggle disables auto-scroll without interrupting stream", async () => {
      const user = userEvent.setup()
      const chunks: LogChunk[] = [new LogChunk({ podName: "p", containerName: "c", line: "one", timestampMs: BigInt(1) })]
      mockClient.streamResourceLogs.mockReturnValue(asyncIter(chunks))

      render(
        <ResourceDetailPanel
          applicationNamespace="test-ns"
          applicationName="demo-app"
          resource={resource}
          onClose={vi.fn()}
        />,
      )
      await waitFor(() =>
        expect(screen.getByRole("tab", { name: "Diff" })).toBeInTheDocument(),
      )
      await user.click(screen.getByRole("tab", { name: "Logs" }))
      await waitFor(() => expect(screen.getByTestId("logs-output")).toHaveTextContent(/one/))

      await user.click(screen.getByTestId("pause-toggle"))
      // The toggle label switches, confirming the pause state took effect.
      expect(screen.getByTestId("pause-toggle")).toHaveTextContent(/resume/i)
      // The stream is still open and the chunks are visible.
      expect(screen.getByTestId("logs-output")).toHaveTextContent(/one/)
    })
  })
})

function render(ui: React.ReactElement) {
 const client = new QueryClient({defaultOptions:{queries:{retry:false}}})
 return rtlRender(ui, {wrapper: ({children}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>})
}
