import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DATA_SOURCES_QUERY_KEY, indexDataSources } from "@/lib/data-state"
import {
  DataClass,
  DataSourceStatus,
  DataState,
} from "@/gen/paprika/v1/api_pb"
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

function status(dataClass: DataClass, state: DataState, reason = "") {
  return new DataSourceStatus({
    dataClass,
    state,
    provider: "",
    observedAtUnixMs: BigInt(0),
    stalenessBudgetMs: BigInt(0),
    unavailableReason: reason,
    retentionLimit: 0,
    retentionWindowMs: BigInt(0),
  })
}

/** Nothing configured: the honest default for a bare control plane. */
const NOTHING_CONFIGURED = [
  status(DataClass.COST, DataState.NOT_CONFIGURED, "no cost source is configured"),
  status(
    DataClass.LIFECYCLE,
    DataState.NOT_CONFIGURED,
    "no delivery projection is configured",
  ),
]

/**
 * Seeds the console-wide probe cache in the shape `@/lib/data-state` stores.
 * Seeding any other shape would make every gating assertion below vacuous.
 */
function renderView(sources: DataSourceStatus[] = NOTHING_CONFIGURED) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(DATA_SOURCES_QUERY_KEY, {
    index: indexDataSources(sources),
    indexGeneration: BigInt(1),
  })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(<FleetView />, { wrapper: Wrapper })
}

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
  it("patches the canonical URL on the current route while preserving scope and selection", () => {
    navigation.params = new URLSearchParams(
      "project=tenant%2Fpayments&health=degraded&selected=apps%2Fcheckout",
    )
    renderView()

    fireEvent.click(screen.getByRole("button", { name: "Show Table view" }))

    expect(navigation.replace).toHaveBeenCalledWith(
      "/dashboard/applications?project=tenant%2Fpayments&health=degraded&view=table&selected=apps%2Fcheckout",
      { scroll: false },
    )
  })

  it("moves the row and matrix axes together when the grouping changes", () => {
    navigation.params = new URLSearchParams("view=matrix")
    renderView()

    fireEvent.click(screen.getByRole("button", { name: "Cluster" }))

    expect(navigation.replace).toHaveBeenCalledWith(
      "/dashboard/applications?view=matrix&group=cluster&rows=stage",
      { scroll: false },
    )
  })

  it("switches grouping off without inventing a query value the API has no name for", () => {
    navigation.params = new URLSearchParams("view=table")
    const apps = applicationsData([application("apps", "checkout")])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    renderView()

    expect(screen.getByRole("button", { name: "Collapse tenant/payments" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "None" }))

    expect(
      screen.queryByRole("button", { name: "Collapse tenant/payments" }),
    ).not.toBeInTheDocument()
    expect(navigation.replace).not.toHaveBeenCalled()
  })

  it("updates row selection in URL state without taking ownership of zoom", () => {
    navigation.params = new URLSearchParams("view=table&zoom=project%3Atenant%2Fpayments")
    const apps = applicationsData([application("apps", "checkout")])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    renderView()

    fireEvent.click(screen.getByRole("row", { name: "apps/checkout" }))

    expect(navigation.replace).toHaveBeenCalledWith(
      "/dashboard/applications?view=table&zoom=project%3Atenant%2Fpayments&selected=apps%2Fcheckout",
      { scroll: false },
    )
  })

  it("reconciles authorized facets, replaces once, and shows one visible notice", async () => {
    navigation.params = new URLSearchParams(
      "project=tenant-a%2Fpayments&project=tenant-b%2Fpayments&view=table",
    )
    const facets: FleetFacetBucket[] = [facet("project", "tenant-b/payments", BigInt(8))]
    const apps = applicationsData([application("apps", "payments")], facets)
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, {
        status: "ready",
        currentData: apps,
        displayData: apps,
        applicationFacets: facets,
      }),
    )
    const { rerender } = renderView()

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

  it("keeps a reconciliation notice until it is dismissed", async () => {
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
    renderView()

    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Fleet query notice" })).toBeInTheDocument(),
    )
    const dismiss = screen.getByRole("button", { name: "Dismiss fleet query notice" })
    expect(dismiss).toHaveClass("min-h-11")
    fireEvent.click(dismiss)

    expect(
      screen.queryByRole("status", { name: "Fleet query notice" }),
    ).not.toBeInTheDocument()
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

    renderView()
    await act(async () => {})

    expect(navigation.replace).not.toHaveBeenCalled()
    expect(
      screen.queryByRole("status", { name: "Fleet query notice" }),
    ).not.toBeInTheDocument()
  })
})

describe("FleetView shell", () => {
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
    const { rerender } = renderView()
    const inventory = screen.getByRole("region", { name: "Applications" })

    expect(inventory).not.toHaveAttribute("data-fleet-ready")

    overrides = { status: "ready", currentData: settledMap, displayData: settledMap }
    rerender(<FleetView />)

    expect(inventory).toHaveAttribute("data-fleet-ready", "12")
  })

  it("marks the active view and grouping for assistive technology", () => {
    navigation.params = new URLSearchParams("view=queue&group=stage")
    renderView()

    expect(screen.getByRole("group", { name: "View" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show Queue view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(screen.getByRole("button", { name: "Stage" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(screen.getByRole("button", { name: "Show Table view" })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
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

    renderView()

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

    renderView()

    expect(screen.getByRole("region", { name: "Fleet map" })).toHaveTextContent(
      "12 applications",
    )
  })
})

describe("FleetView footer", () => {
  it("counts applications loaded against applications indexed", () => {
    navigation.params = new URLSearchParams("view=table")
    const apps = applicationsData(
      Array.from({ length: 100 }, (_, index) => application("apps", `service-${index}`)),
      [],
      "next-100",
    )
    apps.total = BigInt(10_000)
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
    renderView()

    expect(screen.getByTestId("fleet-load-more-sentinel")).toHaveTextContent(
      "100 loaded / 10000 indexed",
    )
    fireEvent.click(screen.getByRole("button", { name: "Load 100 more applications" }))
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it("offers no page control for a server-aggregated presentation", () => {
    navigation.params = new URLSearchParams("view=treemap")
    const map: FleetPresentationData = { kind: "map", view: "treemap", result: mapResult() }
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: map, displayData: map }),
    )
    renderView()

    expect(screen.getByTestId("fleet-load-more-sentinel")).toHaveTextContent("12 indexed")
    expect(
      screen.queryByRole("button", { name: "Load 100 more applications" }),
    ).not.toBeInTheDocument()
  })
})

describe("FleetView presentations", () => {
  it("virtualizes deterministic rows without one node per application", () => {
    navigation.params = new URLSearchParams("view=table")
    const apps = applicationsData(
      Array.from({ length: 180 }, (_, index) => application("apps", `service-${index}`)),
      [],
      "next-100",
    )
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    renderView()

    const rows = screen
      .getAllByRole("row")
      .filter((row) => row.hasAttribute("data-row-key"))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(180)
    expect(rows[0]).toHaveAttribute("data-row-key", "apps/service-0")
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
    renderView()

    const table = screen.getByRole("table", { name: "Applications" })
    expect(table).toHaveAttribute("aria-rowcount", "201")
    expect(screen.getByRole("row", { name: "apps/checkout" })).toHaveAttribute(
      "aria-rowindex",
      "2",
    )
    expect(screen.getByRole("row", { name: "apps/payments" })).toHaveAttribute(
      "aria-rowindex",
      "3",
    )
  })

  it("asks the server for impact order in the queue rather than sorting on the client", () => {
    navigation.params = new URLSearchParams("view=queue&sort=impact&direction=desc")
    const low = application("apps", "first-from-server", { resourceCount: 1 })
    const high = application("apps", "second-from-server", { resourceCount: 900 })
    const apps = applicationsData([low, high], [], "", "queue")
    apps.total = BigInt(200)
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    renderView()

    const rows = screen
      .getAllByRole("row")
      .filter((row) => row.getAttribute("aria-rowindex") !== "1")
    expect(rows[0]).toHaveTextContent("first-from-server")
    expect(rows[1]).toHaveTextContent("second-from-server")
    expect(mockUseFleetData.mock.calls[0]?.[0]).toMatchObject({
      view: "queue",
      sort: "impact",
      direction: "desc",
    })
  })

  it("hides the cost column across the whole view when no cost source exists", () => {
    navigation.params = new URLSearchParams("view=table")
    const apps = applicationsData([application("apps", "checkout")])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    renderView()

    expect(screen.queryByRole("columnheader", { name: /cost/i })).not.toBeInTheDocument()
    const row = screen.getByRole("row", { name: "apps/checkout" })
    expect(within(row).queryByText("$0")).not.toBeInTheDocument()
    expect(within(row).queryByText("—")).not.toBeInTheDocument()
  })

  it("shows the cost column when a cost source is configured", () => {
    // The counterpart to the test above: without this one, "hides the cost
    // column" would also pass if the column simply never existed.
    navigation.params = new URLSearchParams("view=table")
    const apps = applicationsData([application("apps", "checkout")])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    renderView([status(DataClass.COST, DataState.OK)])

    expect(
      screen.getByRole("columnheader", { name: /cost/i }),
    ).toBeInTheDocument()
  })
})

describe("FleetView focus", () => {
  it("restores focus by identity and falls back to the heading with one announcement", async () => {
    navigation.params = new URLSearchParams("view=table")
    let apps = applicationsData([
      application("apps", "payments"),
      application("apps", "checkout"),
    ])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    const { rerender } = renderView()
    screen.getByRole("row", { name: "apps/checkout" }).focus()

    apps = applicationsData([application("apps", "checkout"), application("apps", "orders")])
    rerender(<FleetView />)
    await waitFor(() =>
      expect(screen.getByRole("row", { name: "apps/checkout" })).toHaveFocus(),
    )

    apps = applicationsData([application("apps", "orders")])
    rerender(<FleetView />)
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Applications" })).toHaveFocus(),
    )
    expect(screen.getByRole("status", { name: "Fleet focus updates" })).toHaveTextContent(
      "Application apps/checkout was removed from the results.",
    )
  })

  it("does not steal focus back from the search control after results update", async () => {
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
    const { rerender } = renderView()
    screen.getByRole("row", { name: "apps/checkout" }).focus()
    const control = screen.getByRole("searchbox", {
      name: "Filter applications by name, project, cluster or revision",
    })
    control.focus()

    apps = applicationsData(
      [application("apps", "checkout"), application("apps", "orders")],
      [],
      "next-100",
    )
    rerender(<FleetView />)
    await act(async () => {})

    expect(control).toHaveFocus()
  })

  it("keeps the focused row's identity while the operator changes presentation", async () => {
    navigation.params = new URLSearchParams("view=table")
    let apps = applicationsData([application("apps", "checkout")])
    mockUseFleetData.mockImplementation((state: FleetQueryState) =>
      fleetResult(state, { status: "ready", currentData: apps, displayData: apps }),
    )
    const { rerender } = renderView()
    screen.getByRole("row", { name: "apps/checkout" }).focus()
    screen.getByRole("button", { name: "Show Queue view" }).focus()

    navigation.params = new URLSearchParams("view=queue&sort=impact&direction=desc")
    apps = applicationsData([application("apps", "checkout")], [], "", "queue")
    rerender(<FleetView />)

    await waitFor(() =>
      expect(screen.getByRole("row", { name: "apps/checkout" })).toHaveFocus(),
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
