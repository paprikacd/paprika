import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  FleetApplicationSummary,
  FleetApplicationsPage,
  FleetFacetBucket,
  FleetMapResult,
} from "@/lib/fleet-client"
import type { FleetQueryState } from "@/lib/fleet-query"
import type {
  FleetApplicationsData,
  FleetPresentationData,
  UseFleetDataResult,
} from "@/lib/use-fleet-data"

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  pathname: "/dashboard/applications",
  replace: vi.fn(),
}))
const mockUseFleetData = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => navigation.params,
}))

vi.mock("@/lib/use-fleet-data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/use-fleet-data")>(
    "@/lib/use-fleet-data",
  )
  return { ...actual, useFleetData: mockUseFleetData }
})

import { FleetView } from "@/components/fleet/fleet-view"

beforeEach(() => {
  navigation.params = new URLSearchParams()
  navigation.pathname = "/dashboard/applications"
  navigation.replace.mockReset()
  mockUseFleetData.mockReset()
  mockUseFleetData.mockImplementation((state: FleetQueryState) =>
    fleetResult(state, { status: "loading" }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("FleetView URL state", () => {
  it("patches the canonical URL on the current route while preserving scope and selection", async () => {
    navigation.params = new URLSearchParams(
      "project=tenant%2Fpayments&health=degraded&selected=apps%2Fcheckout",
    )
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "loading" }),
    )
    render(<FleetView />)

    fireEvent.click(screen.getByRole("button", { name: "Show Table view" }))

    expect(navigation.replace).toHaveBeenCalledWith(
      "/dashboard/applications?project=tenant%2Fpayments&health=degraded&view=table&selected=apps%2Fcheckout",
      { scroll: false },
    )
  })

  it("updates row selection in URL state without taking ownership of zoom", () => {
    navigation.params = new URLSearchParams("view=table&zoom=project%3Atenant%2Fpayments")
    const apps = applicationsData([application("apps", "checkout")])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    render(<FleetView />)

    fireEvent.click(screen.getByRole("row", { name: /apps\/checkout/i }))

    expect(navigation.replace).toHaveBeenCalledWith(
      "/dashboard/applications?view=table&zoom=project%3Atenant%2Fpayments&selected=apps%2Fcheckout",
      { scroll: false },
    )
  })

  it("reconciles authorized facets, replaces once, and shows one visible notice", async () => {
    navigation.params = new URLSearchParams(
      "project=tenant-a%2Fpayments&project=tenant-b%2Fpayments&view=table",
    )
    const facets: FleetFacetBucket[] = [
      facet("project", "tenant-b/payments", BigInt(8)),
    ]
    const apps = applicationsData([application("apps", "payments")], facets)
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, {
        status: "ready",
        currentData: apps,
        displayData: apps,
        applicationFacets: facets,
      }),
    )
    const { rerender } = render(<FleetView />)

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledTimes(1))
    expect(navigation.replace).toHaveBeenCalledWith(
      "/dashboard/applications?project=tenant-b%2Fpayments&view=table",
      { scroll: false },
    )
    expect(screen.getByRole("status", { name: "Fleet query notice" })).toHaveTextContent(
      "Removed unavailable project value “tenant-a/payments”.",
    )

    rerender(<FleetView />)
    await act(async () => {})
    expect(navigation.replace).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole("status", { name: "Fleet query notice" })).toHaveLength(1)
  })

  it("keeps a reconciliation notice after navigation advances until it is dismissed", async () => {
    navigation.params = new URLSearchParams(
      "project=tenant-a%2Fpayments&project=tenant-b%2Fpayments&view=table",
    )
    const facets = [facet("project", "tenant-b/payments", BigInt(8))]
    const apps = applicationsData([application("apps", "payments")], facets)
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, {
        status: "ready",
        currentData: apps,
        displayData: apps,
        applicationFacets: facets,
      }),
    )
    const { rerender } = render(<FleetView />)

    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Fleet query notice" })).toBeInTheDocument(),
    )
    navigation.params = new URLSearchParams("project=tenant-b%2Fpayments&view=table")
    rerender(<FleetView />)

    expect(screen.getByRole("status", { name: "Fleet query notice" })).toHaveTextContent(
      "tenant-a/payments",
    )
    const dismiss = screen.getByRole("button", { name: "Dismiss fleet query notice" })
    expect(dismiss).toHaveClass("min-h-11")
    fireEvent.click(dismiss)
    expect(screen.queryByRole("status", { name: "Fleet query notice" })).not.toBeInTheDocument()
  })

  it("never reconciles a new scope against stale presentation facets", async () => {
    navigation.params = new URLSearchParams("project=tenant-new%2Fpayments&view=table")
    const staleFacets = [facet("project", "tenant-old/payments", BigInt(8))]
    const stale = applicationsData([application("apps", "payments")], staleFacets)
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, {
        status: "stale",
        staleData: stale,
        displayData: stale,
        applicationFacets: staleFacets,
      }),
    )

    render(<FleetView />)
    await act(async () => {})

    expect(navigation.replace).not.toHaveBeenCalled()
    expect(screen.queryByRole("status", { name: "Fleet query notice" })).not.toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "Project tenant-old/payments" })).toBeInTheDocument()
  })

  it("treats a settled complete empty facet set as no authorized values", async () => {
    navigation.params = new URLSearchParams("project=tenant%2Fpayments&view=table")
    const settled = applicationsData([])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, {
        status: "ready",
        currentData: settled,
        displayData: settled,
        applicationFacets: [],
      }),
    )

    render(<FleetView />)

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        "/dashboard/applications?view=table",
        { scroll: false },
      ),
    )
    expect(screen.getByRole("status", { name: "Fleet query notice" })).toHaveTextContent(
      "Removed unavailable project value “tenant/payments”.",
    )
  })
})

describe("FleetView states", () => {
  it("exposes the authorized total only after the current fleet snapshot settles", () => {
    const settledMap: FleetPresentationData = {
      kind: "map",
      view: "treemap",
      result: mapResult(),
    }
    let overrides: Partial<UseFleetDataResult> = {
      status: "stale",
      staleData: settledMap,
      displayData: settledMap,
    }
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, overrides),
    )
    const { rerender } = render(<FleetView />)
    const inventory = screen.getByRole("region", { name: "Applications" })

    expect(inventory).not.toHaveAttribute("data-fleet-ready")

    overrides = {
      status: "ready",
      currentData: settledMap,
      displayData: settledMap,
    }
    rerender(<FleetView />)

    expect(inventory).toHaveAttribute("data-fleet-ready", "12")
  })

  it.each([
    ["loading", "Loading fleet data", "status"],
    ["empty", "No applications match this scope", "status"],
    ["unauthorized", "You do not have access to this fleet scope", "alert"],
    ["unavailable", "Fleet index unavailable", "alert"],
    ["error", "Fleet query failed", "alert"],
  ] as const)("renders the %s state in a live region", (status, message, role) => {
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status }),
    )

    render(<FleetView />)

    expect(screen.getByRole(role)).toHaveTextContent(message)
  })

  it("keeps the prior presentation rendered while marking it stale", () => {
    const priorMap: FleetPresentationData = {
      kind: "map",
      view: "treemap",
      result: mapResult(),
    }
    navigation.params = new URLSearchParams("view=matrix")
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, {
        status: "stale",
        staleData: priorMap,
        displayData: priorMap,
      }),
    )

    render(<FleetView />)

    expect(screen.getByText("Showing previous fleet data").closest('[role="status"]')).toHaveTextContent(
      "Showing previous fleet data",
    )
    expect(screen.getByRole("region", { name: "Fleet map" })).toHaveTextContent(
      "12 applications",
    )
  })

  it("renders loaded rows with a distinct partial-results warning", () => {
    navigation.params = new URLSearchParams("view=table")
    const apps = applicationsData([application("apps", "checkout")])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, {
        status: "partial",
        currentData: apps,
        displayData: apps,
      }),
    )

    render(<FleetView />)

    expect(screen.getByRole("status")).toHaveTextContent(
      "Some applications could not be loaded",
    )
    expect(screen.getByRole("row", { name: /apps\/checkout/i })).toBeInTheDocument()
  })
})

describe("FleetView application presentations", () => {
  it("virtualizes deterministic rows and exposes an explicit 100-row page control", () => {
    navigation.params = new URLSearchParams("view=table")
    const apps = applicationsData(
      Array.from({ length: 180 }, (_, index) => application("apps", `service-${index}`)),
      [],
      "next-100",
    )
    const loadMore = vi.fn().mockResolvedValue(undefined)
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, {
        status: "ready",
        currentData: apps,
        displayData: apps,
        hasMore: true,
        loadMore,
      }),
    )
    render(<FleetView />)

    const rows = screen.getAllByRole("row").slice(1)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(180)
    expect(rows[0]).toHaveAttribute("data-row-key", "apps/service-0")

    fireEvent.click(screen.getByRole("button", { name: "Load 100 more applications" }))
    expect(loadMore).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("fleet-load-more-sentinel")).toBeInTheDocument()
  })

  it("renders the queue in server order and never performs an impact join or client sort", () => {
    navigation.params = new URLSearchParams("view=queue&sort=impact&direction=desc")
    const low = application("apps", "first-from-server", { resourceCount: 1 })
    const high = application("apps", "second-from-server", { resourceCount: 900 })
    const apps = applicationsData([low, high], [], "", "queue")
    apps.total = BigInt(200)
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    render(<FleetView />)

    const items = screen.getAllByRole("listitem")
    expect(items[0]).toHaveTextContent("first-from-server")
    expect(items[1]).toHaveTextContent("second-from-server")
    expect(mockUseFleetData.mock.calls[0]?.[0]).toMatchObject({
      view: "queue",
      sort: "impact",
      direction: "desc",
    })
    expect(items[0]).toHaveAttribute("aria-posinset", "1")
    expect(items[0]).toHaveAttribute("aria-setsize", "200")
    expect(items[1]).toHaveAttribute("aria-posinset", "2")
  })

  it("keeps each compact attention item in one named, keyboard-selectable DOM row", () => {
    navigation.params = new URLSearchParams("view=queue&sort=impact&direction=desc")
    const apps = applicationsData(
      [
        application("delivery", "checkout", {
          currentClusterLabel: "omega",
          currentStage: "canary",
          health: "failed",
          sync: "out_of_sync",
          driftCount: 7,
          resourceCount: 42,
          blockedGateCount: 2,
          capabilities: [
            "application_sync",
            "release_rollback",
            "gate_approve",
            "pipeline_retry",
          ],
        }),
        application("platform", "orders", { health: "degraded" }),
      ],
      [],
      "",
      "queue",
    )
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    render(<FleetView />)

    const scroll = screen.getByTestId("attention-queue-scroll")
    expect(within(scroll).getAllByTestId("attention-row-delivery-checkout")).toHaveLength(1)
    expect(within(scroll).getAllByTestId("attention-row-platform-orders")).toHaveLength(1)
    const fallbackRow = within(scroll).getByTestId("attention-row-platform-orders")
    const fallbackReason = within(fallbackRow).getByRole("group", {
      name: "Attention reason Degraded health",
    })
    expect(fallbackReason).toHaveTextContent("Degraded health")

    const row = within(scroll).getByTestId("attention-row-delivery-checkout")
    expect(row).toHaveTextContent("delivery/checkout")
    expect(row).toHaveAttribute("tabindex", "0")
    const rank = within(row).getByRole("group", { name: "Queue rank 01" })
    const reason = within(row).getByRole("group", {
      name: "Attention reason Failed health",
    })
    const target = within(row).getByRole("group", { name: "Target omega" })
    const stage = within(row).getByRole("group", { name: "Stage canary" })
    const health = within(row).getByRole("group", { name: "Health status failed" })
    const sync = within(row).getByRole("group", { name: "Sync status out of sync" })
    const resources = within(row).getByRole("group", { name: "Resource count 42" })
    const drift = within(row).getByRole("group", { name: "Drift count 7" })
    const blocked = within(row).getByRole("group", { name: "Blocked gate count 2" })
    expect(within(rank).getByText("Queue rank")).toHaveClass("xl:sr-only")
    expect(within(reason).getByText("Attention reason")).toHaveClass("xl:sr-only")
    expect(within(target).getByText("Target")).toHaveClass("xl:sr-only")
    expect(within(stage).getByText("Stage")).toHaveClass("xl:sr-only")
    expect(within(health).getByText("Health status")).toHaveClass("xl:sr-only")
    expect(within(sync).getByText("Sync status")).toHaveClass("xl:sr-only")
    expect(within(resources).getByText("Resource count")).toHaveClass("xl:sr-only")
    expect(within(drift).getByText("Drift count")).toHaveClass("xl:sr-only")
    expect(within(blocked).getByText("Blocked gate count")).toHaveClass("xl:sr-only")
    expect(within(row).getByText("Authorized actions")).toHaveClass("xl:sr-only")

    const factIds = Array.from(scroll.querySelectorAll<HTMLElement>('[id^="attention-fact-"]'))
      .map((element) => element.id)
    expect(new Set(factIds).size).toBe(factIds.length)
    expect(within(row).queryByRole("link")).not.toBeInTheDocument()
    expect(within(row).getByRole("button", { name: "Sync delivery/checkout" })).toBeDisabled()
    expect(within(row).getByRole("button", { name: "Rollback delivery/checkout" })).toBeDisabled()
    expect(within(row).getByRole("button", { name: "Approve gate for delivery/checkout" })).toBeDisabled()
    expect(within(row).getByRole("button", { name: "Retry pipeline for delivery/checkout" })).toBeDisabled()
    expect(
      scroll.querySelectorAll('[tabindex="0"], a[href], button:not(:disabled)'),
    ).toHaveLength(2)
    expect(row).toHaveClass(
      "xl:grid-cols-[3rem_minmax(16rem,1fr)_minmax(12rem,0.8fr)_minmax(10rem,1fr)]",
    )

    row.focus()
    navigation.replace.mockClear()
    fireEvent.keyDown(row, { key: "Enter" })
    expect(row).toHaveFocus()
    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/dashboard/applications?sort=impact&direction=desc&view=queue&selected=delivery%2Fcheckout",
      { scroll: false },
    )

    navigation.replace.mockClear()
    fireEvent.keyDown(row, { key: " " })
    expect(row).toHaveFocus()
    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/dashboard/applications?sort=impact&direction=desc&view=queue&selected=delivery%2Fcheckout",
      { scroll: false },
    )
  })

  it.each<{
    caseName: string
    overrides: Partial<FleetApplicationSummary>
    expected: string
  }>([
    {
      caseName: "failed health before gates",
      overrides: { health: "failed", blockedGateCount: 3 },
      expected: "Failed health",
    },
    {
      caseName: "degraded health before gates",
      overrides: { health: "degraded", blockedGateCount: 3 },
      expected: "Degraded health",
    },
    {
      caseName: "missing health before gates",
      overrides: { health: "missing", blockedGateCount: 3 },
      expected: "Missing health",
    },
    {
      caseName: "progressing health before gates",
      overrides: { health: "progressing", blockedGateCount: 3 },
      expected: "Progressing health",
    },
    {
      caseName: "unknown health before gates",
      overrides: { health: "unknown", blockedGateCount: 3 },
      expected: "Unknown health",
    },
    {
      caseName: "unspecified health before gates",
      overrides: { health: "unspecified", blockedGateCount: 3 },
      expected: "Unspecified health",
    },
    {
      caseName: "blocked gates after healthy health",
      overrides: { health: "healthy", blockedGateCount: 3 },
      expected: "3 blocked gates",
    },
    {
      caseName: "pending release",
      overrides: { health: "healthy", releaseState: "pending" },
      expected: "Active release pending",
    },
    {
      caseName: "promoting release",
      overrides: { health: "healthy", releaseState: "promoting" },
      expected: "Active release promoting",
    },
    {
      caseName: "canarying release",
      overrides: { health: "healthy", releaseState: "canarying" },
      expected: "Active release canarying",
    },
    {
      caseName: "verifying release",
      overrides: { health: "healthy", releaseState: "verifying" },
      expected: "Active release verifying",
    },
    {
      caseName: "release awaiting approval",
      overrides: { health: "healthy", releaseState: "awaiting_approval" },
      expected: "Active release awaiting approval",
    },
    {
      caseName: "pending rollout",
      overrides: { health: "healthy", releaseState: "complete", rolloutState: "pending" },
      expected: "Active rollout pending",
    },
    {
      caseName: "progressing rollout",
      overrides: { health: "healthy", releaseState: "complete", rolloutState: "progressing" },
      expected: "Active rollout progressing",
    },
    {
      caseName: "paused rollout",
      overrides: { health: "healthy", releaseState: "complete", rolloutState: "paused" },
      expected: "Active rollout paused",
    },
    {
      caseName: "release before rollout when both are active",
      overrides: { health: "healthy", releaseState: "verifying", rolloutState: "paused" },
      expected: "Active release verifying",
    },
    {
      caseName: "neutral when only non-impact signals are present",
      overrides: {
        health: "healthy",
        sync: "out_of_sync",
        releaseState: "failed",
        rolloutState: "degraded",
        repositoryConnection: "unhealthy",
        observabilityConnection: "disabled",
        targets: [{
          stableId: "target:omega",
          stage: "production",
          ring: 0,
          clusterLabel: "omega",
          health: "failed",
          clusterConnection: "unhealthy",
          unmanagedInlineCluster: false,
        }],
      },
      expected: "No active attention signal",
    },
  ])("describes $caseName using backend impact precedence", ({ overrides, expected }) => {
    navigation.params = new URLSearchParams("view=queue&sort=impact&direction=desc")
    const apps = applicationsData(
      [application("apps", "signal", overrides)],
      [],
      "",
      "queue",
    )
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    render(<FleetView />)

    const row = screen.getByTestId("attention-row-apps-signal")
    expect(within(row).getByRole("group", {
      name: `Attention reason ${expected}`,
    })).toHaveTextContent(expected)
  })

  it("reports virtual table positions against the complete result set", () => {
    navigation.params = new URLSearchParams("view=table")
    const apps = applicationsData([
      application("apps", "checkout"),
      application("apps", "payments"),
    ])
    apps.total = BigInt(200)
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    render(<FleetView />)

    const table = screen.getByRole("table", { name: "Applications" })
    const header = screen.getByRole("row", {
      name: "Application Target Health Sync Resources Authorized actions",
    })
    const checkout = screen.getByRole("row", { name: /apps\/checkout/i })
    const payments = screen.getByRole("row", { name: /apps\/payments/i })
    expect(table).toHaveAttribute("aria-rowcount", "201")
    expect(table).toHaveAttribute("aria-colcount", "6")
    expect(header).toHaveAttribute("aria-rowindex", "1")
    expect(header.parentElement).toHaveClass("hidden", "xl:block")
    expect(header).toHaveClass("px-4", "sm:px-6", "xl:grid")
    expect(header).not.toHaveClass("sr-only")
    expect(header).not.toHaveClass("xl:not-sr-only")
    expect(within(header).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Application",
      "Target",
      "Health",
      "Sync",
      "Resources",
      "Authorized actions",
    ])
    expect(checkout).toHaveAttribute("aria-rowindex", "2")
    expect(payments).toHaveAttribute("aria-rowindex", "3")
  })

  it("measures capability-rich virtual rows so later rows cannot overlap", async () => {
    const defaultRect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const key = this.getAttribute("data-row-key")
      if (key === "apps/authorized") return rectangle(1120, 132)
      if (key) return rectangle(1120, 76)
      if (this.getAttribute("role") === "table") return rectangle(1120, 560)
      return defaultRect.call(this)
    })
    navigation.params = new URLSearchParams("view=table")
    const apps = applicationsData([
      application("apps", "authorized", {
        capabilities: [
          "application_sync",
          "release_rollback",
          "gate_approve",
          "pipeline_retry",
        ],
      }),
      application("apps", "plain"),
    ])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    render(<FleetView />)

    const second = screen.getByRole("row", { name: /apps\/plain/i })
    await waitFor(() =>
      expect(Number(second.getAttribute("data-virtual-start"))).toBeGreaterThanOrEqual(132),
    )
  })

  it("measures capability-rich queue items so later items cannot overlap", async () => {
    const defaultRect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const key = this.getAttribute("data-row-key")
      if (key === "apps/authorized") return rectangle(1120, 164)
      if (key) return rectangle(1120, 116)
      return defaultRect.call(this)
    })
    navigation.params = new URLSearchParams("view=queue&sort=impact&direction=desc")
    const apps = applicationsData([
      application("apps", "authorized", {
        capabilities: [
          "application_sync",
          "release_rollback",
          "gate_approve",
          "pipeline_retry",
        ],
      }),
      application("apps", "plain"),
    ], [], "", "queue")
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    render(<FleetView />)

    const second = screen.getByRole("listitem", { name: /apps\/plain/i })
    await waitFor(() =>
      expect(Number(second.getAttribute("data-virtual-start"))).toBeGreaterThanOrEqual(164),
    )
  })

  it("renders only server-derived capability actions", () => {
    navigation.params = new URLSearchParams("view=table")
    const authorized = application("apps", "authorized", {
      capabilities: [
        "application_sync",
        "release_rollback",
        "gate_approve",
        "pipeline_retry",
      ],
    })
    const readOnly = application("apps", "read-only")
    const apps = applicationsData([authorized, readOnly])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    render(<FleetView />)

    const authorizedRow = screen.getByRole("row", { name: /apps\/authorized/i })
    expect(within(authorizedRow).getByRole("button", { name: "Sync apps/authorized" })).toBeDisabled()
    expect(within(authorizedRow).getByRole("button", { name: "Rollback apps/authorized" })).toBeDisabled()
    expect(within(authorizedRow).getByRole("button", { name: "Approve gate for apps/authorized" })).toBeDisabled()
    expect(within(authorizedRow).getByRole("button", { name: "Retry pipeline for apps/authorized" })).toBeDisabled()

    const readOnlyRow = screen.getByRole("row", { name: /apps\/read-only/i })
    expect(within(readOnlyRow).queryByRole("button")).not.toBeInTheDocument()
  })

  it("keeps each compact application row in one DOM subtree with named facts and drill-down", () => {
    navigation.params = new URLSearchParams(
      "project=team-b%2Fpayments&project=team-a%2Fcheckout" +
        "&cluster=platform%2Fstaging&cluster=platform%2Fprod" +
        "&stage=production&stage=canary&namespace=platform&namespace=apps" +
        "&q=checkout+api&health=degraded&sync=out_of_sync&release=failed" +
        "&rollout=paused&source=git&view=table&group=namespace&rows=3&columns=4" +
        "&size=comfortable&density=compact&labels=all&sort=impact&direction=desc" +
        "&zoom=team&range=24h&tab=resources&selected=delivery%2Fcheckout" +
        "&page=4&cursor=next&unknown=one&unknown=two&name=legacy-name",
    )
    const scopedFacets = [
      facet("project", "team-a/checkout", BigInt(1)),
      facet("project", "team-b/payments", BigInt(1)),
      facet("cluster", "platform/prod", BigInt(1)),
      facet("cluster", "platform/staging", BigInt(1)),
      facet("stage", "canary", BigInt(1)),
      facet("stage", "production", BigInt(1)),
      facet("namespace", "apps", BigInt(1)),
      facet("namespace", "platform", BigInt(1)),
    ]
    const apps = applicationsData(
      [
        application("delivery", "checkout", {
          health: "degraded",
          sync: "out_of_sync",
          resourceCount: 42,
          capabilities: [
            "application_sync",
            "release_rollback",
            "gate_approve",
            "pipeline_retry",
          ],
        }),
        application("platform", "orders"),
      ],
      scopedFacets,
    )
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, {
        status: "ready",
        currentData: apps,
        displayData: apps,
        applicationFacets: scopedFacets,
      }),
    )
    render(<FleetView />)

    const scroll = screen.getByTestId("application-table-scroll")
    const rows = within(scroll).getAllByTestId("application-row-delivery-checkout")
    expect(rows).toHaveLength(1)

    const row = rows[0]
    expect(row).toHaveTextContent("delivery/checkout")
    const target = within(row).getByRole("group", { name: "Target omega" })
    const stage = within(row).getByRole("group", { name: "Stage production" })
    const health = within(row).getByRole("cell", { name: "Health status degraded" })
    const sync = within(row).getByRole("cell", { name: "Sync status out of sync" })
    const resources = within(row).getByRole("cell", { name: "Resource count 42" })
    expect(within(target).getByText("Target")).toHaveClass("xl:sr-only")
    expect(within(stage).getByText("Stage")).toHaveClass("xl:sr-only")
    expect(within(health).getByText("Health status")).toHaveClass("xl:sr-only")
    expect(within(sync).getByText("Sync status")).toHaveClass("xl:sr-only")
    expect(within(resources).getByText("Resource count")).toHaveClass("xl:sr-only")
    expect(within(row).getByText("Authorized actions")).toHaveClass("xl:sr-only")
    const factIds = Array.from(scroll.querySelectorAll<HTMLElement>('[id^="application-fact-"]'))
      .map((element) => element.id)
    expect(new Set(factIds).size).toBe(factIds.length)
    expect(within(row).getByRole("button", { name: "Sync delivery/checkout" })).toBeDisabled()
    expect(within(row).getByRole("button", { name: "Rollback delivery/checkout" })).toBeDisabled()
    expect(within(row).getByRole("button", { name: "Approve gate for delivery/checkout" })).toBeDisabled()
    expect(within(row).getByRole("button", { name: "Retry pipeline for delivery/checkout" })).toBeDisabled()

    const open = within(row).getByRole("link", {
      name: "Open application delivery/checkout",
    })
    const expectedParameters = new URLSearchParams(navigation.params)
    expectedParameters.set("application_namespace", "delivery")
    expectedParameters.set("application_name", "checkout")
    expect(open).toHaveAttribute(
      "href",
      `/dashboard/application?${expectedParameters.toString()}`,
    )
    const destination = new URL(open.getAttribute("href")!, "http://localhost")
    expect(destination.searchParams.getAll("namespace")).toEqual(["platform", "apps"])
    expect(destination.searchParams.getAll("unknown")).toEqual(["one", "two"])
    expect(destination.searchParams.get("tab")).toBe("resources")
    expect(destination.searchParams.get("selected")).toBe("delivery/checkout")
    expect(destination.searchParams.get("zoom")).toBe("team")
    expect(destination.searchParams.get("name")).toBe("legacy-name")
    navigation.replace.mockClear()
    open.focus()
    fireEvent.keyDown(open, { key: "Enter" })
    expect(open).toHaveFocus()
    expect(navigation.replace).not.toHaveBeenCalled()

    expect(scroll).not.toHaveClass("min-w-[58rem]")
    expect(row).toHaveClass("xl:grid-cols-[minmax(15rem,1.5fr)_minmax(9rem,1fr)_8rem_8rem_7rem_minmax(10rem,1fr)]")
  })

  it("restores focus by identity and falls back to the heading with one removal announcement", async () => {
    navigation.params = new URLSearchParams("view=table")
    let apps = applicationsData([
      application("apps", "payments"),
      application("apps", "checkout"),
    ])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    const { rerender } = render(<FleetView />)
    const checkout = screen.getByRole("row", { name: /apps\/checkout/i })
    checkout.focus()

    apps = applicationsData([
      application("apps", "checkout"),
      application("apps", "orders"),
    ])
    rerender(<FleetView />)
    await waitFor(() =>
      expect(screen.getByRole("row", { name: /apps\/checkout/i })).toHaveFocus(),
    )

    apps = applicationsData([application("apps", "orders")])
    rerender(<FleetView />)
    await waitFor(() => expect(screen.getByRole("heading", { name: "Applications" })).toHaveFocus())
    expect(screen.getByRole("status", { name: "Fleet focus updates" })).toHaveTextContent(
      "Application apps/checkout was removed from the results.",
    )

    rerender(<FleetView />)
    expect(screen.getAllByText("Application apps/checkout was removed from the results.")).toHaveLength(1)
  })

  it.each(["search", "load more"] as const)(
    "does not steal focus back from the %s control after results update",
    async (destination) => {
      navigation.params = new URLSearchParams("view=table")
      let apps = applicationsData(
        [application("apps", "checkout"), application("apps", "payments")],
        [],
        "next-100",
      )
      mockUseFleetData.mockImplementation((state: FleetQueryState) =>
        fleetResult(state, {
          status: "ready",
          currentData: apps,
          displayData: apps,
          hasMore: true,
        }),
      )
      const { rerender } = render(<FleetView />)
      screen.getByRole("row", { name: /apps\/checkout/i }).focus()
      const control = destination === "search"
        ? screen.getByRole("searchbox", { name: "Search applications" })
        : screen.getByRole("button", { name: "Load 100 more applications" })
      control.focus()

      apps = applicationsData(
        [application("apps", "checkout"), application("apps", "orders")],
        [],
        "next-100",
      )
      rerender(<FleetView />)
      await act(async () => {})

      expect(control).toHaveFocus()
    },
  )

  it("preserves row identity when focus moves to a presentation toggle", async () => {
    navigation.params = new URLSearchParams("view=table")
    let apps = applicationsData([application("apps", "checkout")])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    const { rerender } = render(<FleetView />)
    screen.getByRole("row", { name: /apps\/checkout/i }).focus()
    const queueToggle = screen.getByRole("button", { name: "Show Queue view" })
    expect(queueToggle).toHaveAttribute("data-preserve-fleet-focus", "true")
    queueToggle.focus()

    navigation.params = new URLSearchParams("view=queue&sort=impact&direction=desc")
    apps = applicationsData([application("apps", "checkout")], [], "", "queue")
    rerender(<FleetView />)

    await waitFor(() =>
      expect(screen.getByRole("listitem", { name: /apps\/checkout/i })).toHaveFocus(),
    )
  })
})

function fleetResult(
  state: FleetQueryState,
  overrides: Partial<UseFleetDataResult>,
): UseFleetDataResult {
  const status = overrides.status ?? "ready"
  return {
    state,
    status,
    currentData: undefined,
    staleData: undefined,
    displayData: undefined,
    error: undefined,
    applicationFacets: [],
    isLoading: status === "loading",
    isReady: status === "ready",
    isEmpty: status === "empty",
    isStale: status === "stale",
    isPartial: status === "partial",
    isUnauthorized: status === "unauthorized",
    isUnavailable: status === "unavailable",
    isError: ["unauthorized", "unavailable", "error"].includes(status),
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function application(
  namespace: string,
  name: string,
  overrides: Partial<FleetApplicationSummary> = {},
): FleetApplicationSummary {
  return {
    identity: { namespace, name },
    project: { namespace: "tenant", name: "payments" },
    targets: [],
    currentStage: "production",
    currentClusterLabel: "omega",
    sourceType: "git",
    sourceRevision: "f8a31b2",
    health: "healthy",
    sync: "synced",
    driftCount: 0,
    missingResourceCount: 0,
    releaseState: "complete",
    rolloutState: "healthy",
    resourceCount: 12,
    repositoryConnection: "healthy",
    observabilityConnection: "healthy",
    blockedGateCount: 0,
    lastTransitionUnixMs: BigInt(1_725_000_000_000),
    capabilities: [],
    ...overrides,
  }
}

function applicationsData(
  applications: FleetApplicationSummary[],
  facets: FleetFacetBucket[] = [],
  nextCursor = "",
  view: "table" | "queue" = "table",
): FleetApplicationsData {
  const page: FleetApplicationsPage = {
    applications,
    total: BigInt(applications.length),
    nextCursor,
    indexGeneration: BigInt(7),
    facets,
  }
  return {
    kind: "applications",
    view,
    pages: [page],
    applications,
    facets,
    total: page.total,
    indexGeneration: page.indexGeneration,
  }
}

function facet(
  dimension: FleetFacetBucket["dimension"],
  value: string,
  count: bigint,
): FleetFacetBucket {
  const [namespace, name] = value.split("/")
  const objectDimension = dimension === "project" || dimension === "cluster"
  return {
    dimension,
    object: objectDimension ? { namespace, name } : undefined,
    value: objectDimension ? undefined : value,
    label: value,
    count,
  }
}

function mapResult(): FleetMapResult {
  return {
    roots: [
      {
        stableId: "project:tenant/payments",
        kind: "group",
        label: "payments",
        applicationCount: BigInt(12),
        targetCount: BigInt(18),
        health: [{ health: "healthy", count: BigInt(11) }],
        resourceWeight: BigInt(120),
        requestRateWeight: 0,
        effectiveWeight: 120,
        usedResourceFallback: false,
        children: [],
      },
    ],
    total: BigInt(12),
    indexGeneration: BigInt(7),
    facets: [],
  }
}

function rectangle(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  }
}
