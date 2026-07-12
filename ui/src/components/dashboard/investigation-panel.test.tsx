import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { act, render, screen, waitFor, within } from "@testing-library/react"
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function investigationResult(summary: string, id: string) {
  return {
    summary,
    narrator: "deterministic",
    findings: [
      {
        id,
        severity: 2,
        title: summary,
        description: "",
        evidence: [],
        playbook: [],
      },
    ],
  }
}

function pluginResult(sourceCount: number, detectorCount: number) {
  return {
    plugins: [
      ...Array.from({ length: sourceCount }, (_, index) => ({
        name: `source-${index}`,
        type: "source",
      })),
      ...Array.from({ length: detectorCount }, (_, index) => ({
        name: `detector-${index}`,
        type: "detector",
      })),
    ],
  }
}

function expandableInvestigation(label: string, primaryId: string) {
  return {
    summary: `${label} result`,
    narrator: "deterministic",
    findings: [
      {
        id: primaryId,
        severity: 1,
        title: `${label} primary finding`,
        description: "",
        evidence: [],
        playbook: [],
      },
      {
        id: "shared-expanded",
        severity: 2,
        title: `${label} expandable finding`,
        description: "",
        evidence: [{ source: "events", timestamp: "", summary: `${label} evidence` }],
        playbook: [],
      },
    ],
  }
}

function InvestigationHarness() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open investigation
      </button>
      {open && (
        <InvestigationPanel
          applicationNamespace="test-ns"
          applicationName="demo-app"
          resource={resource}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

describe("InvestigationPanel", () => {
  let consoleErrorSpy: MockInstance
  let consoleWarnSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
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
    mockClient.investigate.mockReturnValue(new Promise(() => {}))
    render(<InvestigationHarness />)

    await user.click(screen.getByRole("button", { name: "Open investigation" }))

    const backdrop = await screen.findByTestId("investigation-backdrop")
    const dialog = screen.getByRole("dialog", {
      name: "Investigation for Deployment/demo-deploy",
    })
    const close = within(dialog).getByRole("button", { name: "Close investigation" })
    const portal = backdrop.closest("[data-base-ui-portal]")

    expect(portal).toBeInTheDocument()
    expect(portal).toContainElement(backdrop)
    expect(portal).toContainElement(dialog)
    expect(dialog).toHaveAttribute("aria-modal", "true")
    expect(within(dialog).getByRole("status")).toHaveTextContent("Running investigation")
    expect(within(dialog).getByRole("status")).toHaveAttribute("aria-live", "polite")
    await waitFor(() => expect(close).toHaveFocus())
  })

  it("wraps focus and uses Base UI inert marking to recover forced outside focus", async () => {
    const user = userEvent.setup()
    mockClient.investigate.mockReturnValue(new Promise(() => {}))
    render(<InvestigationHarness />)

    const opener = screen.getByRole("button", { name: "Open investigation" })
    await user.click(opener)

    const dialog = await screen.findByRole("dialog", {
      name: "Investigation for Deployment/demo-deploy",
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

    // jsdom does not enforce inert, so force focus outside and let Base UI's
    // focus guards recapture it on the next keyboard navigation.
    opener.focus()
    expect(opener).toHaveFocus()
    await user.tab()
    await waitFor(() => {
      expect(opener).not.toHaveFocus()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    })
  })

  it("closes on Escape, restores opener focus, and removes its portal after close and unmount", async () => {
    const user = userEvent.setup()
    mockClient.investigate.mockReturnValue(new Promise(() => {}))
    const { unmount } = render(<InvestigationHarness />)
    const opener = screen.getByRole("button", { name: "Open investigation" })
    const outsideRoot = opener.parentElement
    const dialogName = "Investigation for Deployment/demo-deploy"

    await user.click(opener)
    await screen.findByRole("dialog", { name: dialogName })
    const backdrop = screen.getByTestId("investigation-backdrop")
    const portal = backdrop.closest("[data-base-ui-portal]")

    expect(portal).toBeInTheDocument()
    await user.keyboard("{Escape}")

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: dialogName })).not.toBeInTheDocument()
      expect(screen.queryByTestId("investigation-backdrop")).not.toBeInTheDocument()
      expect(outsideRoot).not.toHaveAttribute("data-base-ui-inert")
      expect(portal).not.toBeInTheDocument()
      expect(opener).toHaveFocus()
    })

    await user.click(opener)
    await screen.findByRole("dialog", { name: dialogName })
    const reopenedBackdrop = screen.getByTestId("investigation-backdrop")
    const reopenedPortal = reopenedBackdrop.closest("[data-base-ui-portal]")

    expect(reopenedPortal).toBeInTheDocument()
    unmount()

    expect(screen.queryByRole("dialog", { name: dialogName })).not.toBeInTheDocument()
    expect(screen.queryByTestId("investigation-backdrop")).not.toBeInTheDocument()
    expect(reopenedPortal).not.toBeInTheDocument()
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
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
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
    expect(screen.getByText("All clear", { selector: "span" })).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Investigation complete: All clear")
  })

  it("renders per-finding cards with severity, title, playbook", async () => {
    mockClient.investigate.mockResolvedValue({
      summary: "1 critical — investigate critical issues first",
      narrator: "deterministic",
      generatedAtMs: BigInt(Date.now()),
      findings: [
        {
          id: "crash_loop_app",
          severity: 1,
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
    expect(card).toHaveTextContent("Critical")
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
    expect(screen.getByRole("status")).toHaveTextContent(
      "Investigation failed: permission denied",
    )
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

  it("aborts prop-change requests and prevents stale failure from clearing newer loading state", async () => {
    const staleInvestigation = deferred<ReturnType<typeof investigationResult>>()
    const stalePlugins = deferred<ReturnType<typeof pluginResult>>()
    const latestInvestigation = deferred<ReturnType<typeof investigationResult>>()
    const latestPlugins = deferred<ReturnType<typeof pluginResult>>()
    mockClient.investigate
      .mockReturnValueOnce(staleInvestigation.promise)
      .mockReturnValueOnce(latestInvestigation.promise)
    mockClient.listInvestigatorPlugins
      .mockReturnValueOnce(stalePlugins.promise)
      .mockReturnValueOnce(latestPlugins.promise)

    const { rerender } = render(
      <InvestigationPanel
        applicationNamespace="test-ns"
        applicationName="old-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(mockClient.investigate).toHaveBeenCalledTimes(1))

    const staleInvestigateSignal = mockClient.investigate.mock.calls[0][1]?.signal as AbortSignal
    const stalePluginSignal = mockClient.listInvestigatorPlugins.mock.calls[0][1]?.signal as AbortSignal

    rerender(
      <InvestigationPanel
        applicationNamespace="test-ns"
        applicationName="latest-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(mockClient.investigate).toHaveBeenCalledTimes(2))

    const latestSignal = mockClient.investigate.mock.calls[1][1]?.signal as AbortSignal
    expect(staleInvestigateSignal).toBe(stalePluginSignal)
    expect(staleInvestigateSignal.aborted).toBe(true)
    expect(latestSignal.aborted).toBe(false)

    await act(async () => {
      staleInvestigation.reject(new Error("stale permission failure"))
      stalePlugins.resolve(pluginResult(9, 9))
      await Promise.allSettled([staleInvestigation.promise, stalePlugins.promise])
    })

    expect(screen.queryByText("stale permission failure")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Running investigation")

    await act(async () => {
      latestInvestigation.resolve(investigationResult("Latest result", "latest-result"))
      latestPlugins.resolve(pluginResult(1, 1))
      await Promise.all([latestInvestigation.promise, latestPlugins.promise])
    })

    expect(await screen.findByTestId("finding-latest-result")).toHaveTextContent("Latest result")
    expect(screen.getByTestId("investigation-footer")).toHaveTextContent(
      "1 detectors · 1 sources",
    )
    expect(screen.getByRole("status")).toHaveTextContent(
      "Investigation complete: Latest result",
    )
  })

  it("clears identity-bound results while a new identity loads but retains them during Refresh", async () => {
    const user = userEvent.setup()
    const oldInvestigation = deferred<ReturnType<typeof expandableInvestigation>>()
    const oldPlugins = deferred<ReturnType<typeof pluginResult>>()
    const refreshInvestigation = deferred<ReturnType<typeof expandableInvestigation>>()
    const refreshPlugins = deferred<ReturnType<typeof pluginResult>>()
    const newInvestigation = deferred<ReturnType<typeof expandableInvestigation>>()
    const newPlugins = deferred<ReturnType<typeof pluginResult>>()
    mockClient.investigate
      .mockReturnValueOnce(oldInvestigation.promise)
      .mockReturnValueOnce(refreshInvestigation.promise)
      .mockReturnValueOnce(newInvestigation.promise)
    mockClient.listInvestigatorPlugins
      .mockReturnValueOnce(oldPlugins.promise)
      .mockReturnValueOnce(refreshPlugins.promise)
      .mockReturnValueOnce(newPlugins.promise)

    const onClose = vi.fn()
    const { rerender } = render(
      <InvestigationPanel
        applicationNamespace="test-ns"
        applicationName="old-app"
        resource={resource}
        onClose={onClose}
      />,
    )
    await waitFor(() => expect(mockClient.investigate).toHaveBeenCalledTimes(1))

    await act(async () => {
      oldInvestigation.resolve(expandableInvestigation("Old", "old-primary"))
      oldPlugins.resolve(pluginResult(3, 1))
      await Promise.all([oldInvestigation.promise, oldPlugins.promise])
    })

    expect(await screen.findByTestId("finding-old-primary")).toHaveTextContent(
      "Old primary finding",
    )
    const oldExpandable = screen.getByTestId("finding-shared-expanded")
    const oldEvidenceToggle = within(oldExpandable).getByRole("button", {
      name: "Evidence (1)",
    })
    await user.click(oldEvidenceToggle)
    expect(oldEvidenceToggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Old evidence")).toBeInTheDocument()
    expect(screen.getByTestId("investigation-footer")).toHaveTextContent(
      "1 detectors · 3 sources",
    )

    await user.click(screen.getByRole("button", { name: "Re-run investigation" }))
    await waitFor(() => expect(mockClient.investigate).toHaveBeenCalledTimes(2))

    expect(screen.getByTestId("finding-old-primary")).toBeInTheDocument()
    expect(screen.getByText("Old evidence")).toBeInTheDocument()
    expect(screen.getByTestId("investigation-footer")).toHaveTextContent(
      "1 detectors · 3 sources",
    )
    expect(screen.getByRole("status")).toHaveTextContent("Running investigation")

    await act(async () => {
      refreshInvestigation.reject(new Error("old refresh failed"))
      refreshPlugins.resolve(pluginResult(8, 8))
      await Promise.allSettled([refreshInvestigation.promise, refreshPlugins.promise])
    })
    expect(await screen.findByText("old refresh failed")).toBeInTheDocument()

    rerender(
      <InvestigationPanel
        applicationNamespace="new-ns"
        applicationName="new-app"
        resource={{ ...resource, name: "new-deploy", namespace: "new-ns" }}
        onClose={onClose}
      />,
    )
    await waitFor(() => expect(mockClient.investigate).toHaveBeenCalledTimes(3))

    expect(screen.queryByTestId("finding-old-primary")).not.toBeInTheDocument()
    expect(screen.queryByText("Old evidence")).not.toBeInTheDocument()
    expect(screen.queryByText("old refresh failed")).not.toBeInTheDocument()
    expect(screen.queryByTestId("investigation-footer")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Running investigation")

    await act(async () => {
      newInvestigation.resolve(expandableInvestigation("New", "new-primary"))
      newPlugins.resolve(pluginResult(1, 2))
      await Promise.all([newInvestigation.promise, newPlugins.promise])
    })

    expect(await screen.findByTestId("finding-new-primary")).toHaveTextContent(
      "New primary finding",
    )
    const newExpandable = screen.getByTestId("finding-shared-expanded")
    expect(
      within(newExpandable).getByRole("button", { name: "Evidence (1)" }),
    ).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("New evidence")).not.toBeInTheDocument()
    expect(screen.getByTestId("investigation-footer")).toHaveTextContent(
      "2 detectors · 1 sources",
    )
  })

  it("aborts a superseded refresh and ignores its late data and plugins", async () => {
    const user = userEvent.setup()
    const staleInvestigation = deferred<ReturnType<typeof investigationResult>>()
    const stalePlugins = deferred<ReturnType<typeof pluginResult>>()
    const latestInvestigation = deferred<ReturnType<typeof investigationResult>>()
    const latestPlugins = deferred<ReturnType<typeof pluginResult>>()
    mockClient.investigate
      .mockReturnValueOnce(staleInvestigation.promise)
      .mockReturnValueOnce(latestInvestigation.promise)
    mockClient.listInvestigatorPlugins
      .mockReturnValueOnce(stalePlugins.promise)
      .mockReturnValueOnce(latestPlugins.promise)

    render(
      <InvestigationPanel
        applicationNamespace="test-ns"
        applicationName="demo-app"
        resource={resource}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(mockClient.investigate).toHaveBeenCalledTimes(1))

    const staleSignal = mockClient.investigate.mock.calls[0][1]?.signal as AbortSignal
    expect(mockClient.listInvestigatorPlugins.mock.calls[0][1]?.signal).toBe(staleSignal)

    await user.click(screen.getByTestId("investigation-refresh"))
    await waitFor(() => expect(mockClient.investigate).toHaveBeenCalledTimes(2))

    expect(staleSignal.aborted).toBe(true)
    expect(mockClient.investigate.mock.calls[1][1]?.signal.aborted).toBe(false)

    await act(async () => {
      latestInvestigation.resolve(investigationResult("Newest result", "newest-result"))
      latestPlugins.resolve(pluginResult(2, 1))
      await Promise.all([latestInvestigation.promise, latestPlugins.promise])
    })
    expect(await screen.findByTestId("finding-newest-result")).toHaveTextContent("Newest result")
    expect(screen.getByTestId("investigation-footer")).toHaveTextContent(
      "1 detectors · 2 sources",
    )

    await act(async () => {
      staleInvestigation.resolve(investigationResult("Stale result", "stale-result"))
      stalePlugins.resolve(pluginResult(7, 7))
      await Promise.all([staleInvestigation.promise, stalePlugins.promise])
    })

    expect(screen.queryByTestId("finding-stale-result")).not.toBeInTheDocument()
    expect(screen.getByTestId("finding-newest-result")).toHaveTextContent("Newest result")
    expect(screen.getByTestId("investigation-footer")).toHaveTextContent(
      "1 detectors · 2 sources",
    )
  })

  it("aborts pending investigate and plugin work when Close unmounts the panel", async () => {
    const user = userEvent.setup()
    const pendingInvestigation = deferred<ReturnType<typeof investigationResult>>()
    const pendingPlugins = deferred<ReturnType<typeof pluginResult>>()
    mockClient.investigate.mockReturnValue(pendingInvestigation.promise)
    mockClient.listInvestigatorPlugins.mockReturnValue(pendingPlugins.promise)
    render(<InvestigationHarness />)

    await user.click(screen.getByRole("button", { name: "Open investigation" }))
    await waitFor(() => expect(mockClient.investigate).toHaveBeenCalledTimes(1))
    const investigateSignal = mockClient.investigate.mock.calls[0][1]?.signal as AbortSignal
    const pluginSignal = mockClient.listInvestigatorPlugins.mock.calls[0][1]?.signal as AbortSignal

    await user.click(screen.getByRole("button", { name: "Close investigation" }))

    expect(investigateSignal).toBe(pluginSignal)
    expect(investigateSignal.aborted).toBe(true)
    expect(screen.queryByTestId("investigation-panel")).not.toBeInTheDocument()

    await act(async () => {
      pendingInvestigation.resolve(investigationResult("Unmounted result", "unmounted-result"))
      pendingPlugins.resolve(pluginResult(1, 1))
      await Promise.all([pendingInvestigation.promise, pendingPlugins.promise])
    })

    expect(screen.queryByText("Unmounted result")).not.toBeInTheDocument()
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
