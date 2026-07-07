import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InvestigationPanel } from "@/components/dashboard/investigation-panel"

const mockClient = vi.hoisted(() => ({
  investigate: vi.fn(),
  listInvestigatorPlugins: vi.fn(),
}))

vi.mock("@connectrpc/connect-web", () => ({ createConnectTransport: vi.fn(() => ({})) }))
vi.mock("@connectrpc/connect", () => ({ createPromiseClient: vi.fn(() => mockClient) }))
vi.mock("@/gen/paprika/v1/api_connect", () => ({ PaprikaService: {} }))

vi.mock("lucide-react", () => {
  const Icon = (p: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon" {...p} />
  return {
    AlertTriangle: Icon,
    CheckCircle2: Icon,
    ChevronRight: Icon,
    Loader2: Icon,
    RefreshCw: Icon,
    Sparkles: Icon,
    Terminal: Icon,
    X: Icon,
  }
})

const resource = {
  kind: "Deployment",
  name: "demo-deploy",
  namespace: "test-ns",
}

describe("InvestigationPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.listInvestigatorPlugins.mockResolvedValue({ plugins: [] })
  })

  it("calls the Investigate RPC on mount", async () => {
    mockClient.investigate.mockResolvedValue({
      summary: "All clear",
      narrator: "deterministic",
      findings: [],
      generatedAtMs: 1,
    })

    render(
      <InvestigationPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(mockClient.investigate).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceKind: "Deployment",
          resourceName: "demo-deploy",
          applicationNamespace: "test-ns",
          applicationName: "demo-app",
        }),
      )
    })
  })

  it("renders 'All clear' empty state when no findings", async () => {
    mockClient.investigate.mockResolvedValue({
      summary: "All clear",
      narrator: "deterministic",
      findings: [],
    })
    render(
      <InvestigationPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId("investigation-empty")).toBeInTheDocument()
    })
    expect(screen.getByText("No issues detected")).toBeInTheDocument()
    expect(screen.getByText(/All clear/)).toBeInTheDocument()
  })

  it("renders per-finding cards with severity, title, playbook", async () => {
    mockClient.investigate.mockResolvedValue({
      summary: "1 critical — investigate critical issues first",
      narrator: "deterministic",
      generatedAtMs: BigInt(Date.now()),
      findings: [
        {
          id: "crash_loop_app",
          severity: "CRITICAL",
          title: "CrashLoopBackOff detected",
          description: "Container app has restarted 5 times",
          evidence: [
            { source: "manifest", timestamp: "", summary: "container waiting reason: CrashLoopBackOff" },
          ],
          playbook: [
            "Open the Logs tab",
            "Verify the image tag is correct",
          ],
          narrator: "deterministic",
        },
      ],
    })

    render(
      <InvestigationPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )

    const card = await screen.findByTestId("finding-crash_loop_app")
    expect(card).toHaveTextContent("CrashLoopBackOff detected")
    expect(card).toHaveTextContent(/Open the Logs tab/)
    expect(card).toHaveTextContent(/Verify the image tag is correct/)
  })

  it("renders error message when RPC fails", async () => {
    mockClient.investigate.mockRejectedValue(new Error("permission denied"))
    render(
      <InvestigationPanel
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
    mockClient.investigate.mockResolvedValue({
      summary: "All clear",
      narrator: "deterministic",
      findings: [],
    })
    render(
      <InvestigationPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={onClose}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("investigation-panel")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("investigation-close"))
    expect(onClose).toHaveBeenCalled()
  })

  it("Refresh button re-runs investigation", async () => {
    mockClient.investigate.mockResolvedValue({
      summary: "All clear",
      narrator: "deterministic",
      findings: [],
    })
    render(
      <InvestigationPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(mockClient.investigate).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByTestId("investigation-refresh"))
    await waitFor(() => expect(mockClient.investigate).toHaveBeenCalledTimes(2))
  })

  it("renders the footer plugin count when findings exist", async () => {
    mockClient.investigate.mockResolvedValue({
      summary: "1 warning — investigate",
      narrator: "deterministic",
      findings: [
        {
          id: "config_drift_demo-deploy",
          severity: "WARNING",
          title: "Config drift",
          description: "drift",
          evidence: [],
          playbook: [],
        },
      ],
    })
    mockClient.listInvestigatorPlugins.mockResolvedValue({
      plugins: [
        { name: "manifest", type: "source" },
        { name: "events", type: "source" },
        { name: "logs", type: "source" },
        { name: "config_drift", type: "detector" },
        { name: "deterministic", type: "narrator" },
      ],
    })

    render(
      <InvestigationPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId("investigation-footer")).toHaveTextContent("1 detectors")
    })
    expect(screen.getByTestId("investigation-footer")).toHaveTextContent("3 sources")
  })
})
