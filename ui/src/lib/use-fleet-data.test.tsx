import { Code, ConnectError } from "@connectrpc/connect"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"

import type {
  FleetApplicationSummary,
  FleetApplicationsPage,
  FleetMapResult,
  FleetMatrixResult,
  FleetRequestOptions,
  QueryApplicationsOptions,
} from "@/lib/fleet-client"
import {
  DEFAULT_FLEET_QUERY,
  type FleetQueryState,
  type FleetView,
  type NamespacedKey,
} from "@/lib/fleet-query"
import {
  type FleetDataClient,
  type FleetPresentationData,
  useFleetData,
} from "@/lib/use-fleet-data"

function queryState(
  view: FleetView,
  patch: Partial<FleetQueryState> = {},
): FleetQueryState {
  return {
    ...DEFAULT_FLEET_QUERY,
    projects: [],
    clusters: [],
    stages: [],
    namespaces: [],
    health: [],
    sync: [],
    release: [],
    rollout: [],
    sources: [],
    selected: null,
    view,
    ...patch,
  }
}

function application(
  sourceRevision: string,
  identity?: NamespacedKey,
): FleetApplicationSummary {
  return {
    identity,
    targets: [],
    currentStage: "",
    currentClusterLabel: "",
    sourceType: "git",
    sourceRevision,
    health: "healthy",
    sync: "synced",
    driftCount: 0,
    missingResourceCount: 0,
    releaseState: "complete",
    rolloutState: "healthy",
    resourceCount: 1,
    repositoryConnection: "healthy",
    observabilityConnection: "healthy",
    blockedGateCount: 0,
    lastTransitionUnixMs: BigInt(0),
    capabilities: [],
  }
}

function applicationsPage(
  applications: FleetApplicationSummary[],
  nextCursor = "",
  indexGeneration = BigInt(7),
): FleetApplicationsPage {
  return {
    applications,
    total: BigInt(applications.length),
    nextCursor,
    indexGeneration,
    facets: [
      {
        dimension: "health",
        value: "healthy",
        label: "Healthy",
        count: BigInt(applications.length),
      },
    ],
  }
}

function mapResult(total = BigInt(1)): FleetMapResult {
  return {
    roots: [],
    total,
    indexGeneration: BigInt(7),
    facets: [{
      dimension: "health",
      value: "healthy",
      label: "Healthy",
      count: total,
    }],
  }
}

function matrixResult(total = BigInt(1)): FleetMatrixResult {
  return {
    rows: [],
    columns: [],
    cells: [],
    total,
    indexGeneration: BigInt(7),
    facets: [{
      dimension: "health",
      value: "degraded",
      label: "Degraded",
      count: total,
    }],
  }
}

interface TestCalls {
  applications: Array<{
    state: FleetQueryState
    options: QueryApplicationsOptions
  }>
  map: Array<{ state: FleetQueryState; options: FleetRequestOptions }>
  matrix: Array<{ state: FleetQueryState; options: FleetRequestOptions }>
}

function testClient(
  overrides: Partial<FleetDataClient> = {},
): { client: FleetDataClient; calls: TestCalls } {
  const calls: TestCalls = { applications: [], map: [], matrix: [] }
  const client: FleetDataClient = {
    queryApplications: async (state, options = {}) => {
      calls.applications.push({ state, options })
      return applicationsPage([
        application("initial", { namespace: "apps", name: "api" }),
      ])
    },
    queryFleetMap: async (state, options = {}) => {
      calls.map.push({ state, options })
      return mapResult()
    },
    queryFleetMatrix: async (state, options = {}) => {
      calls.matrix.push({ state, options })
      return matrixResult()
    },
    ...overrides,
  }
  return { client, calls }
}

function queryWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    )
  }
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
    },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

describe("useFleetData primary presentation", () => {
  it.each([
    ["treemap", "map"],
    ["matrix", "matrix"],
    ["table", "applications"],
    ["queue", "applications"],
  ] as const)("runs only the %s primary RPC", async (view, expected) => {
    const { client, calls } = testClient()
    const state = queryState(view, { sort: "name", direction: "asc" })
    const snapshot = structuredClone(state)
    const { result } = renderHook(() => useFleetData(state, { client }), {
      wrapper: queryWrapper(newQueryClient()),
    })

    await waitFor(() => expect(result.current.status).toBe("ready"))

    expect(calls.map).toHaveLength(expected === "map" ? 1 : 0)
    expect(calls.matrix).toHaveLength(expected === "matrix" ? 1 : 0)
    expect(calls.applications).toHaveLength(expected === "applications" ? 1 : 0)
    expect(result.current.currentData?.kind).toBe(expected)
    expect(result.current.state).toBe(state)
    expect(state).toEqual(snapshot)

    if (view === "queue") {
      expect(calls.applications[0]?.state).toMatchObject({
        sort: "impact",
        direction: "desc",
      })
    }
  })

  it("keeps the last settled presentation visible as stale while a new view loads", async () => {
    const pendingMatrix = deferred<FleetMatrixResult>()
    const { client } = testClient({
      queryFleetMatrix: async () => pendingMatrix.promise,
    })
    const queryClient = newQueryClient()
    const { result, rerender } = renderHook(
      ({ state }) => useFleetData(state, { client }),
      {
        initialProps: { state: queryState("treemap") },
        wrapper: queryWrapper(queryClient),
      },
    )
    await waitFor(() => expect(result.current.status).toBe("ready"))

    rerender({ state: queryState("matrix") })

    await waitFor(() => expect(result.current.status).toBe("stale"))
    expect(result.current.currentData).toBeUndefined()
    expect(result.current.staleData?.kind).toBe("map")
    expect(result.current.displayData?.kind).toBe("map")
    expect(result.current.isStale).toBe(true)
    expect(result.current.applicationFacets[0]).toMatchObject({
      value: "healthy",
    })

    await act(async () => pendingMatrix.resolve(matrixResult()))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.currentData?.kind).toBe("matrix")
    expect(result.current.staleData).toBeUndefined()
    expect(result.current.applicationFacets[0]).toMatchObject({
      value: "degraded",
    })
  })
})

describe("useFleetData application paging", () => {
  it("requests 100-row pages and merges identities in first-seen order", async () => {
    const firstA = application("first-a", { namespace: "apps", name: "api" })
    const missingA = application("missing-a")
    const laterA = application("later-a", { namespace: "apps", name: "api" })
    const firstB = application("first-b", { namespace: "apps", name: "worker" })
    const missingB = application("missing-b")
    const calls: QueryApplicationsOptions[] = []
    const { client } = testClient({
      queryApplications: async (_state, options = {}) => {
        calls.push(options)
        return options.cursor === "next"
          ? applicationsPage([laterA, firstB, missingB])
          : applicationsPage([firstA, missingA], "next")
      },
    })
    const { result } = renderHook(
      () => useFleetData(queryState("table"), { client }),
      { wrapper: queryWrapper(newQueryClient()) },
    )
    await waitFor(() => expect(result.current.status).toBe("ready"))

    await act(async () => result.current.loadMore())

    expect(calls.map(({ cursor, pageSize }) => ({ cursor, pageSize }))).toEqual([
      { cursor: "", pageSize: 100 },
      { cursor: "next", pageSize: 100 },
    ])
    expect(calls.every(({ signal }) => signal instanceof AbortSignal)).toBe(true)
    expect(result.current.currentData?.kind).toBe("applications")
    if (result.current.currentData?.kind === "applications") {
      expect(result.current.currentData.applications).toEqual([
        firstA,
        missingA,
        firstB,
        missingB,
      ])
    }
    expect(result.current.applicationFacets).toHaveLength(1)
    expect(result.current.hasMore).toBe(false)
  })

  it("bounds refetch to page one while retaining compatible loaded pages", async () => {
    const originalFirst = application("original-a", {
      namespace: "apps",
      name: "api",
    })
    const originalSecond = application("original-b", {
      namespace: "apps",
      name: "worker",
    })
    const refreshedFirst = application("refreshed-a", {
      namespace: "apps",
      name: "api",
    })
    const calls: string[] = []
    let firstPageRequests = 0
    const { client } = testClient({
      queryApplications: async (_state, options = {}) => {
        const cursor = options.cursor ?? ""
        calls.push(cursor)
        if (cursor === "original-next") {
          return applicationsPage([originalSecond])
        }
        firstPageRequests += 1
        return firstPageRequests === 1
          ? applicationsPage([originalFirst], "original-next")
          : applicationsPage([refreshedFirst], "original-next")
      },
    })
    const queryClient = newQueryClient()
    const { result } = renderHook(
      () => useFleetData(queryState("table"), { client }),
      { wrapper: queryWrapper(queryClient) },
    )
    await waitFor(() => expect(result.current.hasMore).toBe(true))
    await act(async () => result.current.loadMore())
    if (result.current.currentData?.kind !== "applications") {
      throw new Error("expected loaded application pages")
    }
    expect(result.current.currentData.pages).toHaveLength(2)
    const retainedSecondPage = result.current.currentData.pages[1]

    const queryKey = queryClient.getQueryCache().getAll()[0]!.queryKey
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey, exact: true })
    })

    expect(calls).toEqual(["", "original-next", ""])
    await waitFor(() => {
      if (result.current.currentData?.kind !== "applications") {
        throw new Error("expected refreshed application pages")
      }
      expect(result.current.currentData.pages).toHaveLength(2)
      expect(result.current.currentData.pages[1]).toBe(retainedSecondPage)
      expect(result.current.currentData.applications).toEqual([
        refreshedFirst,
        originalSecond,
      ])
    })
  })

  it.each([
    {
      change: "generation",
      generation: BigInt(8),
      cursor: "next",
    },
    {
      change: "first cursor",
      generation: BigInt(7),
      cursor: "changed-next",
    },
  ])("collapses safely when refetch changes the $change", async ({
    generation,
    cursor: refreshedCursor,
  }) => {
    const originalFirst = application("original-a", {
      namespace: "apps",
      name: "api",
    })
    const originalSecond = application("original-b", {
      namespace: "apps",
      name: "worker",
    })
    const refreshedFirst = application("refreshed-a", {
      namespace: "apps",
      name: "api",
    })
    const calls: string[] = []
    let firstPageRequests = 0
    const { client } = testClient({
      queryApplications: async (_state, options = {}) => {
        const requestCursor = options.cursor ?? ""
        calls.push(requestCursor)
        if (requestCursor) return applicationsPage([originalSecond])
        firstPageRequests += 1
        return firstPageRequests === 1
          ? applicationsPage([originalFirst], "next")
          : applicationsPage(
              [refreshedFirst],
              refreshedCursor,
              generation,
            )
      },
    })
    const queryClient = newQueryClient()
    const { result } = renderHook(
      () => useFleetData(queryState("table"), { client }),
      { wrapper: queryWrapper(queryClient) },
    )
    await waitFor(() => expect(result.current.hasMore).toBe(true))
    await act(async () => result.current.loadMore())

    const queryKey = queryClient.getQueryCache().getAll()[0]!.queryKey
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey, exact: true })
    })

    expect(calls).toEqual(["", "next", ""])
    await waitFor(() => {
      if (result.current.currentData?.kind !== "applications") {
        throw new Error("expected safely refreshed applications")
      }
      expect(result.current.currentData.pages).toHaveLength(1)
      expect(result.current.currentData.applications).toEqual([refreshedFirst])
    })
  })

  it.each([
    {
      incompatibility: "generation",
      middleGeneration: BigInt(8),
      middleTotal: BigInt(1),
    },
    {
      incompatibility: "total",
      middleGeneration: BigInt(7),
      middleTotal: BigInt(99),
    },
  ])("collapses when a middle cached page has an incompatible $incompatibility", async ({
    middleGeneration,
    middleTotal,
  }) => {
    const originalFirst = application("original-a", {
      namespace: "apps",
      name: "api",
    })
    const originalMiddle = application("original-b", {
      namespace: "apps",
      name: "worker",
    })
    const originalLast = application("original-c", {
      namespace: "apps",
      name: "web",
    })
    const refreshedFirst = application("refreshed-a", {
      namespace: "apps",
      name: "api",
    })
    const calls: string[] = []
    let firstPageRequests = 0
    const { client } = testClient({
      queryApplications: async (_state, options = {}) => {
        const cursor = options.cursor ?? ""
        calls.push(cursor)
        if (cursor === "middle") {
          return {
            ...applicationsPage(
              [originalMiddle],
              "last",
              middleGeneration,
            ),
            total: middleTotal,
          }
        }
        if (cursor === "last") {
          return applicationsPage([originalLast])
        }
        firstPageRequests += 1
        return firstPageRequests === 1
          ? applicationsPage([originalFirst], "middle")
          : applicationsPage([refreshedFirst], "middle")
      },
    })
    const queryClient = newQueryClient()
    const { result } = renderHook(
      () => useFleetData(queryState("table"), { client }),
      { wrapper: queryWrapper(queryClient) },
    )
    await waitFor(() => expect(result.current.hasMore).toBe(true))
    await act(async () => result.current.loadMore())
    await act(async () => result.current.loadMore())
    if (result.current.currentData?.kind !== "applications") {
      throw new Error("expected three cached application pages")
    }
    expect(result.current.currentData.pages).toHaveLength(3)

    const queryKey = queryClient.getQueryCache().getAll()[0]!.queryKey
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey, exact: true })
    })

    expect(calls).toEqual(["", "middle", "last", ""])
    await waitFor(() => {
      const data = result.current.currentData
      if (data?.kind !== "applications") {
        throw new Error("expected safely collapsed application data")
      }
      expect(data.pages).toHaveLength(1)
      expect(data.applications).toEqual([refreshedFirst])
    })
  })

  it("suppresses a racing refetch and never appends onto a changed base", async () => {
    const initial = application("initial", { namespace: "apps", name: "api" })
    const staleNext = application("stale-next", {
      namespace: "apps",
      name: "worker",
    })
    const changed = application("changed", { namespace: "apps", name: "new" })
    const pendingNext = deferred<FleetApplicationsPage>()
    const calls: string[] = []
    let firstPageRequests = 0
    const { client } = testClient({
      queryApplications: async (_state, options = {}) => {
        const cursor = options.cursor ?? ""
        calls.push(cursor)
        if (cursor === "next") return pendingNext.promise
        firstPageRequests += 1
        return firstPageRequests === 1
          ? applicationsPage([initial], "next")
          : applicationsPage([changed])
      },
    })
    const queryClient = newQueryClient()
    const { result } = renderHook(
      () => useFleetData(queryState("table"), { client }),
      { wrapper: queryWrapper(queryClient) },
    )
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    let loadPromise!: Promise<void>
    act(() => {
      loadPromise = result.current.loadMore()
    })
    await waitFor(() => expect(calls).toEqual(["", "next"]))
    const query = queryClient.getQueryCache().getAll()[0]!
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: query.queryKey,
        exact: true,
      })
    })

    const current = queryClient.getQueryData<FleetPresentationData>(
      query.queryKey,
    )
    if (current?.kind !== "applications") {
      throw new Error("expected cached application pages")
    }
    const changedPage = applicationsPage([changed])
    queryClient.setQueryData<FleetPresentationData>(query.queryKey, {
      ...current,
      pages: [changedPage],
      applications: [changed],
      facets: changedPage.facets,
      total: changedPage.total,
      indexGeneration: changedPage.indexGeneration,
    })

    await act(async () => {
      pendingNext.resolve(applicationsPage([staleNext]))
      await loadPromise
    })

    expect(calls).toEqual(["", "next"])
    if (result.current.currentData?.kind !== "applications") {
      throw new Error("expected changed application base")
    }
    expect(result.current.currentData.pages).toHaveLength(1)
    expect(result.current.currentData.applications).toEqual([changed])
  })

  it("replaces accumulated pages after one invalid-cursor restart", async () => {
    const initial = application("initial", { namespace: "apps", name: "old" })
    const replacement = application("replacement", {
      namespace: "apps",
      name: "new",
    })
    const calls: string[] = []
    let firstPageRequests = 0
    const { client } = testClient({
      queryApplications: async (_state, options = {}) => {
        const cursor = options.cursor ?? ""
        calls.push(cursor)
        if (cursor === "expired") {
          throw new ConnectError("cursor expired", Code.InvalidArgument)
        }
        firstPageRequests += 1
        return firstPageRequests === 1
          ? applicationsPage([initial], "expired")
          : applicationsPage([replacement])
      },
    })
    const state = queryState("table", { q: "payments", sort: "project" })
    const snapshot = structuredClone(state)
    const { result } = renderHook(() => useFleetData(state, { client }), {
      wrapper: queryWrapper(newQueryClient()),
    })
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    await act(async () => result.current.loadMore())

    expect(calls).toEqual(["", "expired", ""])
    expect(firstPageRequests).toBe(2)
    expect(result.current.currentData?.kind).toBe("applications")
    if (result.current.currentData?.kind === "applications") {
      expect(result.current.currentData.pages).toHaveLength(1)
      expect(result.current.currentData.applications).toEqual([replacement])
    }
    expect(result.current.status).toBe("ready")
    expect(result.current.state).toBe(state)
    expect(state).toEqual(snapshot)
  })

  it("retains accumulated pages and exposes Partial for other load-more errors", async () => {
    const initial = application("initial", { namespace: "apps", name: "api" })
    const loadError = new ConnectError("temporarily unavailable", Code.Unavailable)
    const calls: string[] = []
    const { client } = testClient({
      queryApplications: async (_state, options = {}) => {
        const cursor = options.cursor ?? ""
        calls.push(cursor)
        if (cursor) throw loadError
        return applicationsPage([initial], "next")
      },
    })
    const { result } = renderHook(
      () => useFleetData(queryState("table"), { client }),
      { wrapper: queryWrapper(newQueryClient()) },
    )
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    await act(async () => result.current.loadMore())

    expect(calls).toEqual(["", "next"])
    expect(result.current.status).toBe("partial")
    expect(result.current.isPartial).toBe(true)
    expect(result.current.error).toBe(loadError)
    if (result.current.currentData?.kind === "applications") {
      expect(result.current.currentData.applications).toEqual([initial])
    } else {
      throw new Error("expected retained application data")
    }
  })

  it("aborts an obsolete load-more request without leaving the old key busy", async () => {
    let loadSignal: AbortSignal | undefined
    const { client } = testClient({
      queryApplications: async (_state, options = {}) => {
        if (!options.cursor) {
          return applicationsPage(
            [application("initial", { namespace: "apps", name: "api" })],
            "next",
          )
        }
        loadSignal = options.signal
        return new Promise<FleetApplicationsPage>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"))
          })
        })
      },
    })
    const queryClient = newQueryClient()
    const { result, rerender } = renderHook(
      ({ state }) => useFleetData(state, { client }),
      {
        initialProps: { state: queryState("table") },
        wrapper: queryWrapper(queryClient),
      },
    )
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    act(() => {
      void result.current.loadMore()
    })
    await waitFor(() => expect(result.current.isLoadingMore).toBe(true))

    rerender({ state: queryState("treemap") })
    await waitFor(() => expect(loadSignal?.aborted).toBe(true))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    rerender({ state: queryState("table") })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.isLoadingMore).toBe(false)
  })

  it("does not reset or fetch page one when an invalid cursor arrives after abort", async () => {
    const initial = application("initial", { namespace: "apps", name: "api" })
    const calls: string[] = []
    let rejectLoad!: (reason: unknown) => void
    let loadSignal: AbortSignal | undefined
    const { client } = testClient({
      queryApplications: async (_state, options = {}) => {
        const cursor = options.cursor ?? ""
        calls.push(cursor)
        if (!cursor) return applicationsPage([initial], "expired")
        loadSignal = options.signal
        return new Promise<FleetApplicationsPage>((_resolve, reject) => {
          rejectLoad = reject
        })
      },
    })
    const queryClient = newQueryClient()
    const { result, rerender } = renderHook(
      ({ state }) => useFleetData(state, { client }),
      {
        initialProps: { state: queryState("table") },
        wrapper: queryWrapper(queryClient),
      },
    )
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    let loadPromise!: Promise<void>
    act(() => {
      loadPromise = result.current.loadMore()
    })
    await waitFor(() => expect(result.current.isLoadingMore).toBe(true))
    rerender({ state: queryState("treemap") })
    await waitFor(() => expect(loadSignal?.aborted).toBe(true))

    await act(async () => {
      rejectLoad(new ConnectError("cursor expired", Code.InvalidArgument))
      await loadPromise
    })
    rerender({ state: queryState("table") })
    await waitFor(() => expect(result.current.status).toBe("ready"))

    expect(calls).toEqual(["", "expired"])
    if (result.current.currentData?.kind === "applications") {
      expect(result.current.currentData.applications).toEqual([initial])
    } else {
      throw new Error("expected preserved application data")
    }
  })
})

describe("useFleetData error flags", () => {
  it.each([
    [Code.PermissionDenied, "unauthorized"],
    [Code.Unavailable, "unavailable"],
  ] as const)("maps Connect code %s to %s", async (code, status) => {
    const error = new ConnectError("query failed", code)
    const { client } = testClient({
      queryFleetMap: async () => {
        throw error
      },
    })
    const { result } = renderHook(
      () => useFleetData(queryState("treemap"), { client }),
      { wrapper: queryWrapper(newQueryClient()) },
    )

    await waitFor(() => expect(result.current.status).toBe(status))
    expect(result.current.error).toBe(error)
    expect(result.current.isUnauthorized).toBe(status === "unauthorized")
    expect(result.current.isUnavailable).toBe(status === "unavailable")
  })
})
