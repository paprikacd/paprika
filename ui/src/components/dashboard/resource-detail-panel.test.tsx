import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ResourceDetailPanel } from "@/components/dashboard/resource-detail-panel"

// Mock the Connect RPC client.
const mockClient = vi.hoisted(() => ({
  getResource: vi.fn(),
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

describe("ResourceDetailPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("shows loading state while fetching", () => {
    mockClient.getResource.mockReturnValue(new Promise(() => {})) // never resolves
    render(
      <ResourceDetailPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )
    // The panel should show the resource name in the header.
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

    // Wait for data to load and diff to render. Each diff line is in its own div.
    await waitFor(() => {
      expect(screen.getByText(/replicas: 1/)).toBeInTheDocument()
    })
    expect(screen.getByText(/replicas: 2/)).toBeInTheDocument()
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

    // Click the Events tab.
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
      expect(screen.getByText("Deployment")).toBeInTheDocument()
    })

    // Click the backdrop overlay (first child div).
    const backdrop = container.querySelector(".fixed.inset-0")
    await userEvent.click(backdrop!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
