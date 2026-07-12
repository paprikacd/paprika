import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ResourceDetailPanel } from "@/components/dashboard/resource-detail-panel"
import type { LogChunk } from "@/gen/paprika/v1/api_pb"

// Mock the Connect RPC client.
const mockClient = vi.hoisted(() => ({
  getResource: vi.fn(),
  getResourceLogs: vi.fn(),
  getResourceTreeDetailed: vi.fn(),
  streamResourceLogs: vi.fn(),
  investigate: vi.fn(),
  listInvestigatorPlugins: vi.fn(),
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

function ResourceDetailHarness() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open resource details
      </button>
      {open && (
        <ResourceDetailPanel
          applicationNamespace="test-ns"
          applicationName="demo-app"
          resource={resource}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
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
  let consoleErrorSpy: MockInstance
  let consoleWarnSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockClient.investigate.mockResolvedValue({ summary: "All clear", narrator: "deterministic", findings: [] })
    mockClient.listInvestigatorPlugins.mockResolvedValue({ plugins: [] })
  })

  afterEach(() => {
    const consoleErrors = [...consoleErrorSpy.mock.calls]
    const consoleWarnings = [...consoleWarnSpy.mock.calls]

    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()

    expect(consoleErrors).toEqual([])
    expect(consoleWarnings).toEqual([])
  })

  it("renders through a portal as a labelled modal and initially focuses close", async () => {
    const user = userEvent.setup()
    mockClient.getResource.mockReturnValue(new Promise(() => {}))
    render(<ResourceDetailHarness />)

    await user.click(screen.getByRole("button", { name: "Open resource details" }))

    const backdrop = await screen.findByTestId("resource-detail-backdrop")
    const dialog = screen.getByRole("dialog", {
      name: "Resource details for Deployment/demo-deploy",
    })
    const close = within(dialog).getByRole("button", { name: "Close resource details" })
    const portal = document.body.querySelector("[data-base-ui-portal]")

    expect(backdrop).toBeInTheDocument()
    expect(portal).toBeInTheDocument()
    expect(portal).toContainElement(backdrop)
    expect(dialog).toHaveAttribute("aria-modal", "true")
    await waitFor(() => expect(close).toHaveFocus())
  })

  it("wraps focus and uses Base UI inert marking to recover forced outside focus", async () => {
    const user = userEvent.setup()
    mockClient.getResource.mockReturnValue(new Promise(() => {}))
    render(<ResourceDetailHarness />)

    const opener = screen.getByRole("button", { name: "Open resource details" })
    await user.click(opener)

    const dialog = await screen.findByRole("dialog", {
      name: "Resource details for Deployment/demo-deploy",
    })
    const dialogButtons = within(dialog).getAllByRole("button")
    const firstButton = dialogButtons[0]
    const lastButton = dialogButtons[dialogButtons.length - 1]
    const outsideRoot = opener.parentElement

    expect(outsideRoot).toHaveAttribute("data-base-ui-inert")

    lastButton.focus()
    await user.tab()
    expect(firstButton).toHaveFocus()

    await user.tab({ shift: true })
    expect(lastButton).toHaveFocus()

    opener.focus()
    expect(opener).toHaveFocus()
    await user.tab()
    await waitFor(() => {
      expect(opener).not.toHaveFocus()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    })
  })

  it("closes on Escape, restores opener focus, and removes its portal when unmounted", async () => {
    const user = userEvent.setup()
    mockClient.getResource.mockReturnValue(new Promise(() => {}))
    const { unmount } = render(<ResourceDetailHarness />)
    const opener = screen.getByRole("button", { name: "Open resource details" })
    const outsideRoot = opener.parentElement

    await user.click(opener)
    const dialogName = "Resource details for Deployment/demo-deploy"
    await screen.findByRole("dialog", { name: dialogName })
    expect(screen.getByTestId("resource-detail-backdrop")).toBeInTheDocument()

    await user.keyboard("{Escape}")

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: dialogName })).not.toBeInTheDocument()
      expect(screen.queryByTestId("resource-detail-backdrop")).not.toBeInTheDocument()
      expect(outsideRoot).not.toHaveAttribute("data-base-ui-inert")
      expect(opener).toHaveFocus()
    })

    await user.click(opener)
    await screen.findByRole("dialog", { name: dialogName })
    const reopenedBackdrop = screen.getByTestId("resource-detail-backdrop")
    const portal = document.body.querySelector("[data-base-ui-portal]")

    expect(portal).toBeInTheDocument()
    expect(portal).toContainElement(reopenedBackdrop)

    unmount()

    expect(screen.queryByRole("dialog", { name: dialogName })).not.toBeInTheDocument()
    expect(screen.queryByTestId("resource-detail-backdrop")).not.toBeInTheDocument()
    expect(portal).not.toBeInTheDocument()
  })

  it("stacks Investigation above Resource details and closes each modal in order", async () => {
    const user = userEvent.setup()
    mockClient.getResource.mockReturnValue(new Promise(() => {}))
    const { unmount } = render(<ResourceDetailHarness />)
    const opener = screen.getByRole("button", { name: "Open resource details" })
    const resourceDialogName = "Resource details for Deployment/demo-deploy"
    const investigationDialogName = "Investigation for Deployment/demo-deploy"

    await user.click(opener)
    const resourceDialog = await screen.findByRole("dialog", { name: resourceDialogName })
    const investigate = within(resourceDialog).getByRole("button", { name: "Investigate" })

    await user.click(investigate)

    const investigationDialog = await screen.findByRole("dialog", {
      name: investigationDialogName,
    })
    expect(resourceDialog).toBeInTheDocument()
    expect(investigationDialog).toHaveAccessibleName(investigationDialogName)
    expect(screen.getByTestId("resource-detail-backdrop")).toBeInTheDocument()
    expect(screen.getByTestId("investigation-backdrop")).toBeInTheDocument()

    await user.keyboard("{Escape}")

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: investigationDialogName })).not.toBeInTheDocument()
      expect(screen.queryByTestId("investigation-backdrop")).not.toBeInTheDocument()
      expect(screen.getByRole("dialog", { name: resourceDialogName })).toBeInTheDocument()
      expect(screen.getByTestId("resource-detail-backdrop")).toBeInTheDocument()
      expect(investigate).toHaveFocus()
    })

    await user.keyboard("{Escape}")

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: resourceDialogName })).not.toBeInTheDocument()
      expect(screen.queryByTestId("resource-detail-backdrop")).not.toBeInTheDocument()
      expect(opener).toHaveFocus()
    })

    await user.click(opener)
    const reopenedResourceDialog = await screen.findByRole("dialog", { name: resourceDialogName })
    await user.click(within(reopenedResourceDialog).getByRole("button", { name: "Investigate" }))
    await screen.findByRole("dialog", { name: investigationDialogName })

    const resourcePortal = screen
      .getByTestId("resource-detail-backdrop")
      .closest("[data-base-ui-portal]")
    const investigationPortal = screen
      .getByTestId("investigation-backdrop")
      .closest("[data-base-ui-portal]")

    expect(resourcePortal).toBeInTheDocument()
    expect(investigationPortal).toBeInTheDocument()
    expect(investigationPortal).not.toBe(resourcePortal)

    unmount()

    expect(screen.queryByRole("dialog", { name: investigationDialogName })).not.toBeInTheDocument()
    expect(screen.queryByRole("dialog", { name: resourceDialogName })).not.toBeInTheDocument()
    expect(screen.queryByTestId("investigation-backdrop")).not.toBeInTheDocument()
    expect(screen.queryByTestId("resource-detail-backdrop")).not.toBeInTheDocument()
    expect(investigationPortal).not.toBeInTheDocument()
    expect(resourcePortal).not.toBeInTheDocument()
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
    expect(screen.getByText("Deployment")).toBeInTheDocument()
    expect(screen.getByText("/demo-deploy")).toBeInTheDocument()
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
        { type: "Warning", reason: "FailedScheduling", message: "Insufficient cpu", lastTimestamp: "2024-01-01T00:00:00Z", count: 3, involvedObjectKind: "Deployment", involvedObjectName: "demo-deploy" },
        { type: "Normal", reason: "Scheduled", message: "Successfully assigned", lastTimestamp: "2024-01-01T00:01:00Z", count: 1, involvedObjectKind: "Deployment", involvedObjectName: "demo-deploy" },
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
      expect(screen.getByText("Diff")).toBeInTheDocument()
    })
    await user.click(screen.getByText("Events"))

    expect(screen.getByText("FailedScheduling")).toBeInTheDocument()
    expect(screen.getByText("Insufficient cpu")).toBeInTheDocument()
    expect(screen.getByText(/x3/)).toBeInTheDocument()
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

  it("calls onClose when the backdrop is clicked", async () => {
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

    render(
      <ResourceDetailPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={onClose}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText("Deployment")).toBeInTheDocument()
    })

    await userEvent.click(screen.getByTestId("resource-detail-backdrop"))
    expect(onClose).toHaveBeenCalledTimes(1)
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
      mockClient.streamResourceLogs.mockReturnValue(emptyIter())
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
      await waitFor(() => expect(screen.getByText("Diff")).toBeInTheDocument())
      await user.click(screen.getByText("Logs"))

      expect(mockClient.streamResourceLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceKind: "Deployment",
          resourceName: "demo-deploy",
          resourceNamespace: "test-ns",
          follow: true,
        }),
      )
    })

    it("renders each streamed chunk line", async () => {
      const user = userEvent.setup()
      const chunks: LogChunk[] = [
        { podName: "demo-deploy-pod", containerName: "app", line: "starting up", timestampMs: 1 },
        { podName: "demo-deploy-pod", containerName: "app", line: "ready", timestampMs: 2 },
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
      await waitFor(() => expect(screen.getByText("Diff")).toBeInTheDocument())
      await user.click(screen.getByText("Logs"))

      const output = await screen.findByTestId("logs-output")
      await waitFor(() => {
        expect(output).toHaveTextContent(/starting up/)
        expect(output).toHaveTextContent(/ready/)
      })
    })

    it("filter input narrows visible lines", async () => {
      const user = userEvent.setup()
      const chunks: LogChunk[] = [
        { podName: "p", containerName: "c", line: "hello", timestampMs: 1 },
        { podName: "p", containerName: "c", line: "world", timestampMs: 2 },
        { podName: "p", containerName: "c", line: "hello again", timestampMs: 3 },
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
      await waitFor(() => expect(screen.getByText("Diff")).toBeInTheDocument())
      await user.click(screen.getByText("Logs"))

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
      const chunks: LogChunk[] = [{ podName: "p", containerName: "c", line: "one", timestampMs: 1 }]
      mockClient.streamResourceLogs.mockReturnValue(asyncIter(chunks))

      render(
        <ResourceDetailPanel
          applicationNamespace="test-ns"
          applicationName="demo-app"
          resource={resource}
          onClose={vi.fn()}
        />,
      )
      await waitFor(() => expect(screen.getByText("Diff")).toBeInTheDocument())
      await user.click(screen.getByText("Logs"))
      await waitFor(() => expect(screen.getByTestId("logs-output")).toHaveTextContent(/one/))

      await user.click(screen.getByTestId("pause-toggle"))
      // The toggle label switches, confirming the pause state took effect.
      expect(screen.getByTestId("pause-toggle")).toHaveTextContent(/resume/i)
      // The stream is still open and the chunks are visible.
      expect(screen.getByTestId("logs-output")).toHaveTextContent(/one/)
    })
  })
})
