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

    expect(screen.getByRole("status")).toHaveTextContent("Showing previous fleet data")
    expect(screen.getByRole("region", { name: "Fleet map summary" })).toHaveTextContent(
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
    const header = screen.getByRole("row", { name: /authorized actions/i })
    const checkout = screen.getByRole("row", { name: /apps\/checkout/i })
    const payments = screen.getByRole("row", { name: /apps\/payments/i })
    expect(table).toHaveAttribute("aria-rowcount", "201")
    expect(table).toHaveAttribute("aria-colcount", "6")
    expect(header).toHaveAttribute("aria-rowindex", "1")
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
