import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { SVGProps } from "react"
import { DashboardCommandCenter } from "@/components/dashboard/dashboard-command-center"
import type { Application, Pipeline, Release, Rollout } from "@/gen/paprika/v1/api_pb"

vi.mock("lucide-react", () => {
  const Icon = (props: SVGProps<SVGSVGElement>) => <svg data-testid="icon" {...props} />
  return {
    AlertCircle: Icon,
    ArrowUpRight: Icon,
    Boxes: Icon,
    CheckCircle2: Icon,
    CircleDot: Icon,
    Clock3: Icon,
    GitBranch: Icon,
    History: Icon,
    Layers: Icon,
    Search: Icon,
    Shield: Icon,
    Workflow: Icon,
  }
})

function makeApp(partial: Partial<Application>): Application {
  return {
    name: "",
    namespace: "default",
    phase: "Healthy",
    currentStage: "",
    revision: "",
    synced: true,
    templateRef: "",
    pipelineRef: "",
    releaseRef: "",
    stages: [],
    strategy: "",
    syncPolicy: "",
    parameters: {},
    sourceHash: "",
    sourceRevision: "",
    health: "",
    healthChecks: [],
    resources: [],
    resourceHealth: [],
    outOfSync: 0,
    prunedResources: 0,
    gates: [],
    project: "",
    conditions: [],
    analysisResults: [],
    ...partial,
  } as Application
}

const applications = [
  makeApp({
    name: "checkout-api",
    namespace: "prod",
    health: "Degraded",
    phase: "Progressing",
    currentStage: "canary",
    releaseRef: "checkout-api-release",
    outOfSync: 2,
    resourceHealth: [
      { kind: "Deployment", name: "checkout-api", namespace: "prod", health: "Degraded", message: "1 pod crash looping" },
      { kind: "Service", name: "checkout-api", namespace: "prod", health: "Healthy", message: "" },
    ],
  }),
  makeApp({
    name: "ledger-worker",
    namespace: "finance",
    health: "Healthy",
    phase: "Healthy",
    currentStage: "stable",
    releaseRef: "ledger-worker-release",
  }),
  makeApp({
    name: "catalog",
    namespace: "prod",
    health: "Progressing",
    phase: "Canarying",
    currentStage: "canary",
  }),
]

const pipelines = [{ name: "checkout-build", namespace: "prod", phase: "Running" }] as Pipeline[]
const releases = [{ name: "checkout-api-release", namespace: "prod", phase: "Canarying", application: "checkout-api" }] as Release[]
const rollouts = [{ name: "checkout-api-rollout", namespace: "prod", phase: "Progressing" }] as Rollout[]

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeRelease(name: string, namespace = "team-06", phase = "Complete") {
  return {
    name,
    namespace,
    phase,
    application: name.replace(/-release.*$/, ""),
    pipeline: "delivery",
    target: "production",
    currentStage: "production",
  } as Release
}

function renderCommandCenter({
  initialApplications = applications,
  initialReleases = releases,
  applicationTotal,
  searchReleases,
  releaseQuery = "",
}: {
  initialApplications?: Application[]
  initialReleases?: Release[]
  applicationTotal?: bigint
  searchReleases?: (query: string, signal: AbortSignal) => Promise<Release[]>
  releaseQuery?: string
} = {}) {
  return render(
    <DashboardCommandCenter
      applications={initialApplications}
      applicationTotal={applicationTotal}
      pipelines={pipelines}
      releases={initialReleases}
      rollouts={rollouts}
      applicationSets={[]}
      policies={[]}
      loading={false}
      searchReleases={searchReleases}
      releaseQuery={releaseQuery}
    />,
  )
}

describe("DashboardCommandCenter", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("searches across cluster objects and remembers selected searches", async () => {
    const user = userEvent.setup()
    renderCommandCenter({ releaseQuery: "namespace=platform&view=heatmap&unknown=kept" })

    expect(screen.getByRole("heading", { name: /cluster command center/i })).toBeInTheDocument()

    await user.type(screen.getByRole("searchbox", { name: /search operations/i }), "checkout")

    const results = screen.getByRole("list", { name: /search results/i })
    expect(within(results).getByRole("link", { name: /Application checkout-api/i })).toHaveAttribute(
      "href",
      "/dashboard/application?namespace=platform&view=heatmap&unknown=kept&application_namespace=prod&application_name=checkout-api",
    )
    expect(within(results).getByRole("link", { name: /Pipeline checkout-build/i })).toBeInTheDocument()
    expect(within(results).getByRole("link", { name: /Rollout checkout-api-rollout/i })).toBeInTheDocument()

    await user.click(within(results).getByRole("link", { name: /Application checkout-api/i }))

    expect(localStorage.getItem("paprika-dashboard-recent-searches")).toContain("checkout")
    expect(screen.getByRole("button", { name: /recent search checkout/i })).toBeInTheDocument()
  })

  it("filters the app health heatmap and links tiles to app drilldown", async () => {
    const user = userEvent.setup()
    renderCommandCenter({ releaseQuery: "namespace=platform&unknown=kept" })

    expect(screen.getByRole("link", { name: /checkout-api Degraded/i })).toHaveAttribute(
      "href",
      "/dashboard/application?namespace=platform&unknown=kept&application_namespace=prod&application_name=checkout-api",
    )
    expect(screen.getByRole("link", { name: /ledger-worker Healthy/i })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /show degraded applications/i }))

    expect(screen.getByRole("link", { name: /checkout-api Degraded/i })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /ledger-worker Healthy/i })).not.toBeInTheDocument()
    expect(screen.getByText("ns/prod")).toBeInTheDocument()
    expect(screen.getByText(/1 pod crash looping/i)).toBeInTheDocument()
  })

  it("integrates the bounded health map with the indexed application total", () => {
    renderCommandCenter({ applicationTotal: 250n })

    expect(screen.getByText("3 of 3 loaded · 250 indexed")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "View all applications as treemap" })).toHaveAttribute(
      "href",
      "/dashboard/applications?view=treemap",
    )
  })

  it("waits the full 250ms before finding a release outside the initial dashboard data", async () => {
    vi.useFakeTimers()
    const searchReleases = vi.fn().mockResolvedValue([
      makeRelease("application-00246-release-v1"),
    ])
    renderCommandCenter({
      initialReleases: [],
      searchReleases,
      releaseQuery: "namespace=team-06&view=queue&selected=team-06%2Fapplication-00246",
    })

    fireEvent.change(screen.getByRole("searchbox", { name: /search operations/i }), {
      target: { value: "application-00246-release-v1" },
    })
    expect(screen.getByRole("status")).toHaveTextContent("Searching releases…")

    await act(async () => vi.advanceTimersByTime(249))
    expect(searchReleases).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(searchReleases).toHaveBeenCalledTimes(1)
    expect(searchReleases.mock.calls[0][0]).toBe("application-00246-release-v1")
    expect(searchReleases.mock.calls[0][1]).toBeInstanceOf(AbortSignal)
    expect(
      screen.getByRole("link", { name: /Release application-00246-release-v1/i }),
    ).toHaveAttribute(
      "href",
      "/dashboard/releases?view=queue&namespace=team-06&q=application-00246-release-v1",
    )
  })

  it("aborts replaced searches and ignores stale success and failure completions", async () => {
    vi.useFakeTimers()
    const oldRequest = deferred<Release[]>()
    const newRequest = deferred<Release[]>()
    const searchReleases = vi
      .fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise)
    renderCommandCenter({ initialReleases: [], searchReleases })
    const searchbox = screen.getByRole("searchbox", { name: /search operations/i })

    fireEvent.change(searchbox, { target: { value: "old-release" } })
    await act(async () => vi.advanceTimersByTime(250))
    const oldSignal = searchReleases.mock.calls[0][1] as AbortSignal
    expect(oldSignal.aborted).toBe(false)

    fireEvent.change(searchbox, { target: { value: "new-release" } })
    expect(oldSignal.aborted).toBe(true)
    await act(async () => vi.advanceTimersByTime(250))

    await act(async () => newRequest.resolve([makeRelease("new-release")]))
    expect(screen.getByRole("link", { name: /Release new-release/i })).toBeInTheDocument()

    await act(async () => oldRequest.resolve([makeRelease("old-release")]))
    expect(screen.queryByRole("link", { name: /Release old-release/i })).not.toBeInTheDocument()
    expect(screen.queryByText("Release search unavailable")).not.toBeInTheDocument()
  })

  it("ignores a late result after the command query is cleared", async () => {
    vi.useFakeTimers()
    const request = deferred<Release[]>()
    const searchReleases = vi.fn().mockReturnValue(request.promise)
    renderCommandCenter({ initialReleases: [], searchReleases })
    const searchbox = screen.getByRole("searchbox", { name: /search operations/i })

    fireEvent.change(searchbox, { target: { value: "late-release" } })
    await act(async () => vi.advanceTimersByTime(250))
    const signal = searchReleases.mock.calls[0][1] as AbortSignal
    fireEvent.change(searchbox, { target: { value: "" } })
    expect(signal.aborted).toBe(true)

    await act(async () => request.resolve([makeRelease("late-release")]))
    expect(screen.queryByRole("link", { name: /Release late-release/i })).not.toBeInTheDocument()
    expect(screen.queryByText("Searching releases…")).not.toBeInTheDocument()
  })

  it("keeps local results usable when on-demand release search fails", async () => {
    vi.useFakeTimers()
    const searchReleases = vi.fn().mockRejectedValue(new Error("release API unavailable"))
    renderCommandCenter({ searchReleases })

    fireEvent.change(screen.getByRole("searchbox", { name: /search operations/i }), {
      target: { value: "checkout" },
    })
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText("Release search unavailable")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Release search unavailable")
    const results = screen.getByRole("list", { name: /search results/i })
    expect(within(results).getByRole("link", { name: /Application checkout-api/i })).toBeInTheDocument()
    expect(within(results).getByRole("link", { name: /Pipeline checkout-build/i })).toBeInTheDocument()
  })

  it("deduplicates releases by namespace and name, preserves distinct namespaces, and caps all ranked results", async () => {
    vi.useFakeTimers()
    const local = makeRelease("release-00", "apps")
    const remote = [
      makeRelease("release-00", "apps", "Verifying"),
      makeRelease("release-00", "platform"),
      ...Array.from({ length: 10 }, (_, index) => makeRelease(`release-${index + 10}`, `ns-${index}`)),
    ]
    const searchReleases = vi.fn().mockResolvedValue(remote)
    renderCommandCenter({
      initialReleases: [local],
      searchReleases,
      releaseQuery:
        "project=team%2Fpayments&cluster=platform%2Fprod&stage=production&namespace=team-06&group=health",
    })

    fireEvent.change(screen.getByRole("searchbox", { name: /search operations/i }), {
      target: { value: "release" },
    })
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
      await Promise.resolve()
    })

    const results = screen.getByRole("list", { name: /search results/i })
    const links = within(results).getAllByRole("link")
    expect(links).toHaveLength(8)
    expect(within(results).getAllByRole("link", { name: /Release release-00/i })).toHaveLength(2)
    for (const link of links) {
      const href = new URL(link.getAttribute("href")!, "https://paprika.invalid")
      expect(href.pathname).toBe("/dashboard/releases")
      expect(href.searchParams.getAll("project")).toEqual(["team/payments"])
      expect(href.searchParams.getAll("cluster")).toEqual(["platform/prod"])
      expect(href.searchParams.getAll("stage")).toEqual(["production"])
      expect(href.searchParams.getAll("namespace")).toContain("team-06")
      expect(href.searchParams.get("q")).toMatch(/^release-/)
    }
  })

  it("ranks an exact normalized release name ahead of enough local prefixes to fill the result cap", async () => {
    vi.useFakeTimers()
    const searchReleases = vi.fn().mockResolvedValue([makeRelease("checkout")])
    renderCommandCenter({
      initialApplications: Array.from({ length: 9 }, (_, index) =>
        makeApp({ name: `checkout-${index}`, namespace: "apps" }),
      ),
      initialReleases: [],
      searchReleases,
    })

    fireEvent.change(screen.getByRole("searchbox", { name: /search operations/i }), {
      target: { value: "  CHECKOUT  " },
    })
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
      await Promise.resolve()
    })

    const results = screen.getByRole("list", { name: /search results/i })
    const links = within(results).getAllByRole("link")
    expect(links).toHaveLength(8)
    expect(links[0]).toHaveAccessibleName(/Release checkout/i)
    expect(links[0]).toHaveAttribute(
      "href",
      "/dashboard/releases?namespace=team-06&q=checkout",
    )
  })

  it("adds a release namespace to repeated scope without dropping or duplicating namespaces", async () => {
    vi.useFakeTimers()
    const searchReleases = vi.fn().mockResolvedValue([
      makeRelease("scoped-release", "platform"),
      makeRelease("scoped-release", "team-06"),
    ])
    renderCommandCenter({
      initialReleases: [],
      searchReleases,
      releaseQuery: "namespace=platform&namespace=apps&namespace=platform&view=queue",
    })

    fireEvent.change(screen.getByRole("searchbox", { name: /search operations/i }), {
      target: { value: "scoped-release" },
    })
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
      await Promise.resolve()
    })

    const hrefs = screen
      .getAllByRole("link", { name: /Release scoped-release/i })
      .map((link) => link.getAttribute("href"))
    expect(hrefs).toEqual([
      "/dashboard/releases?view=queue&namespace=platform&namespace=apps&q=scoped-release",
      "/dashboard/releases?view=queue&namespace=platform&namespace=apps&namespace=team-06&q=scoped-release",
    ])
  })

  it("keys remote results by both the typed query and release-search scope", async () => {
    vi.useFakeTimers()
    const initialSearch = vi.fn().mockResolvedValue([makeRelease("shared-query", "scope-a")])
    const oldRequest = deferred<Release[]>()
    const oldSearch = vi.fn().mockReturnValue(oldRequest.promise)
    const newRequest = deferred<Release[]>()
    const newSearch = vi.fn().mockReturnValue(newRequest.promise)
    const baseProps = {
      applications,
      pipelines,
      releases: [] as Release[],
      rollouts,
      applicationSets: [],
      policies: [],
      loading: false,
    }
    const { rerender } = render(
      <DashboardCommandCenter
        {...baseProps}
        searchReleases={initialSearch}
        releaseQuery="namespace=scope-a"
      />,
    )
    const searchbox = screen.getByRole("searchbox", { name: /search operations/i })
    fireEvent.change(searchbox, { target: { value: "shared-query" } })
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole("link", { name: /Release shared-query/i })).toHaveAttribute(
      "href",
      "/dashboard/releases?namespace=scope-a&q=shared-query",
    )

    rerender(
      <DashboardCommandCenter
        {...baseProps}
        searchReleases={oldSearch}
        releaseQuery="namespace=scope-a"
      />,
    )
    expect(screen.queryByRole("link", { name: /Release shared-query/i })).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Searching releases…")
    await act(async () => vi.advanceTimersByTime(250))
    expect(oldSearch).toHaveBeenCalledTimes(1)

    rerender(
      <DashboardCommandCenter
        {...baseProps}
        searchReleases={newSearch}
        releaseQuery="namespace=scope-b"
      />,
    )
    expect(screen.getByRole("status")).toHaveTextContent("Searching releases…")
    await act(async () => vi.advanceTimersByTime(250))
    expect(newSearch).toHaveBeenCalledTimes(1)

    await act(async () => oldRequest.reject(new Error("stale scope failed")))
    expect(screen.queryByRole("link", { name: /Release shared-query/i })).not.toBeInTheDocument()
    expect(screen.queryByText("Release search unavailable")).not.toBeInTheDocument()

    await act(async () => newRequest.resolve([makeRelease("shared-query", "scope-b")]))
    expect(screen.getByRole("link", { name: /Release shared-query/i })).toHaveAttribute(
      "href",
      "/dashboard/releases?namespace=scope-b&q=shared-query",
    )
  })
})
