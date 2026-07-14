"use client"

import { Code, ConnectError } from "@connectrpc/connect"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  type FleetApplicationSummary,
  type FleetApplicationsPage,
  type FleetFacetBucket,
  type FleetMapResult,
  type FleetMatrixResult,
  type FleetRequestOptions,
  type QueryApplicationsOptions,
  queryApplications,
  queryFleetMap,
  queryFleetMatrix,
  toQueryApplicationsRequest,
  toQueryFleetMapRequest,
  toQueryFleetMatrixRequest,
} from "@/lib/fleet-client"
import {
  createFleetPageLoader,
  mergeFleetApplicationPages,
} from "@/lib/fleet-pages"
import {
  parseFleetQuery,
  serializeFleetQuery,
  type FleetQueryState,
} from "@/lib/fleet-query"

const APPLICATION_PAGE_SIZE = 100

export interface FleetDataClient {
  queryApplications: (
    state: FleetQueryState,
    options?: QueryApplicationsOptions,
  ) => Promise<FleetApplicationsPage>
  queryFleetMap: (
    state: FleetQueryState,
    options?: FleetRequestOptions,
  ) => Promise<FleetMapResult>
  queryFleetMatrix: (
    state: FleetQueryState,
    options?: FleetRequestOptions,
  ) => Promise<FleetMatrixResult>
}

export interface FleetApplicationsData {
  kind: "applications"
  view: "table" | "queue"
  pages: readonly FleetApplicationsPage[]
  applications: FleetApplicationSummary[]
  facets: FleetFacetBucket[]
  total: bigint
  indexGeneration: bigint
}

export interface FleetMapData {
  kind: "map"
  result: FleetMapResult
}

export interface FleetMatrixData {
  kind: "matrix"
  view: "matrix"
  result: FleetMatrixResult
}

export type FleetPresentationData =
  | FleetApplicationsData
  | FleetMapData
  | FleetMatrixData

export type FleetDataStatus =
  | "loading"
  | "ready"
  | "empty"
  | "stale"
  | "partial"
  | "unauthorized"
  | "unavailable"
  | "error"

export interface UseFleetDataOptions {
  client?: FleetDataClient
}

export interface UseFleetDataResult {
  state: FleetQueryState
  status: FleetDataStatus
  currentData: FleetPresentationData | undefined
  staleData: FleetPresentationData | undefined
  displayData: FleetPresentationData | undefined
  error: unknown
  applicationFacets: readonly FleetFacetBucket[]
  isLoading: boolean
  isReady: boolean
  isEmpty: boolean
  isStale: boolean
  isPartial: boolean
  isUnauthorized: boolean
  isUnavailable: boolean
  isError: boolean
  hasMore: boolean
  isLoadingMore: boolean
  loadMore: () => Promise<void>
  refresh: () => Promise<void>
}

const defaultClient: FleetDataClient = {
  queryApplications,
  queryFleetMap,
  queryFleetMatrix,
}

type FleetDataQueryKey =
  | readonly ["fleet", "applications", "table" | "queue", string]
  | readonly ["fleet", "map", string]
  | readonly ["fleet", "matrix", "matrix", string]

type ActiveRequest =
  | {
      kind: "applications"
      view: "table" | "queue"
      state: FleetQueryState
      key: FleetDataQueryKey
    }
  | {
      kind: "map"
      state: FleetQueryState
      key: FleetDataQueryKey
    }
  | {
      kind: "matrix"
      view: "matrix"
      state: FleetQueryState
      key: FleetDataQueryKey
    }

type ApplicationRequest = Extract<ActiveRequest, { kind: "applications" }>

interface ApplicationPageLoad {
  page: FleetApplicationsPage
  restarted: boolean
}

interface ApplicationLoader {
  load: (
    cursor: string,
    signal: AbortSignal,
  ) => Promise<ApplicationPageLoad>
}

interface LoadMoreOperation {
  keyId: string
  controller: AbortController
}

interface ApplicationPageBase {
  pages: readonly FleetApplicationsPage[]
  generation: bigint
  pageCount: number
  cursor: string
}

export function useFleetData(
  state: FleetQueryState,
  options: UseFleetDataOptions = {},
): UseFleetDataResult {
  const client = options.client ?? defaultClient
  const queryClient = useQueryClient()
  const canonicalState = useMemo(() => canonicalizeState(state), [state])
  const request = useMemo(
    () => activeRequest(canonicalState),
    [canonicalState],
  )
  const keyId = useMemo(() => JSON.stringify(request.key), [request.key])
  const mounted = useRef(false)
  const loadMoreOperation = useRef<LoadMoreOperation | undefined>(undefined)
  const [loadMoreError, setLoadMoreError] = useState<{
    keyId: string
    error: unknown
  }>()
  const [loadingMoreKey, setLoadingMoreKey] = useState<string>()

  const applicationLoader = useMemo<ApplicationLoader | undefined>(() => {
    if (request.kind !== "applications") return undefined

    return createApplicationLoader(
      (cursor, signal) =>
        client.queryApplications(request.state, {
          cursor,
          pageSize: APPLICATION_PAGE_SIZE,
          signal,
        }),
      () => {
        queryClient.setQueryData<FleetPresentationData>(
          request.key,
          applicationData(request.view, []),
        )
      },
    )
  }, [client, queryClient, request])

  const query = useQuery<FleetPresentationData>({
    queryKey: request.key,
    queryFn: async ({ signal }) => {
      switch (request.kind) {
        case "applications": {
          const cached = queryClient.getQueryData<FleetPresentationData>(
            request.key,
          )
          if (
            loadMoreOperation.current?.keyId === keyId &&
            cached?.kind === "applications"
          ) {
            return cached
          }
          return refreshApplicationData(
            client,
            request,
            cached?.kind === "applications" ? cached : undefined,
            signal,
          )
        }
        case "map":
          return {
            kind: "map",
            result: await client.queryFleetMap(request.state, { signal }),
          }
        case "matrix":
          return {
            kind: "matrix",
            view: "matrix",
            result: await client.queryFleetMatrix(request.state, { signal }),
          }
      }
    },
    placeholderData: (previousData) => previousData,
  })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    return () => {
      const operation = loadMoreOperation.current
      if (operation?.keyId === keyId) {
        operation.controller.abort()
        loadMoreOperation.current = undefined
        if (mounted.current) {
          setLoadingMoreKey((current) =>
            current === keyId ? undefined : current,
          )
        }
      }
    }
  }, [keyId])

  const loadMore = useCallback(async () => {
    if (request.kind !== "applications" || !applicationLoader) return
    if (loadMoreOperation.current) return

    const operation: LoadMoreOperation = {
      keyId,
      controller: new AbortController(),
    }
    loadMoreOperation.current = operation
    setLoadingMoreKey(keyId)

    try {
      await queryClient.cancelQueries({ queryKey: request.key, exact: true })
      requireActiveLoadSignal(operation.controller.signal)
      const current = queryClient.getQueryData<FleetPresentationData>(
        request.key,
      )
      if (current?.kind !== "applications") return
      const base = applicationPageBase(current)
      if (!base.cursor) return

      const loaded = await applicationLoader.load(
        base.cursor,
        operation.controller.signal,
      )
      queryClient.setQueryData<FleetPresentationData>(request.key, (latest) => {
        if (loaded.restarted) {
          return isEmptyApplicationReset(latest)
            ? applicationData(request.view, [loaded.page])
            : latest
        }
        if (!sameApplicationPageBase(latest, base)) return latest
        return applicationData(request.view, [...latest.pages, loaded.page])
      })
      if (mounted.current && !operation.controller.signal.aborted) {
        setLoadMoreError(undefined)
      }
    } catch (error) {
      if (mounted.current && !operation.controller.signal.aborted) {
        setLoadMoreError({ keyId, error })
      }
    } finally {
      if (loadMoreOperation.current === operation) {
        loadMoreOperation.current = undefined
        if (mounted.current) setLoadingMoreKey(undefined)
      }
    }
  }, [applicationLoader, keyId, queryClient, request])

  const staleData = query.isPlaceholderData ? query.data : undefined
  const currentData = query.isPlaceholderData ? undefined : query.data
  const displayData = currentData ?? staleData
  const partialError =
    loadMoreError?.keyId === keyId ? loadMoreError.error : undefined
  const status = dataStatus(query, currentData, staleData, partialError)
  const error = partialError ?? query.error ?? undefined
  const applicationFacets = presentationFacets(displayData)
  const hasMore =
    currentData?.kind === "applications" &&
    Boolean(currentData.pages.at(-1)?.nextCursor)
  const isLoadingMore = loadingMoreKey === keyId
  const refetch = query.refetch
  const refresh = useCallback(async () => {
    await refetch({ throwOnError: true })
  }, [refetch])

  return {
    state,
    status,
    currentData,
    staleData,
    displayData,
    error,
    applicationFacets,
    isLoading: status === "loading",
    isReady: status === "ready",
    isEmpty: status === "empty",
    isStale: status === "stale",
    isPartial: status === "partial",
    isUnauthorized: status === "unauthorized",
    isUnavailable: status === "unavailable",
    isError:
      status === "error" ||
      status === "unauthorized" ||
      status === "unavailable",
    hasMore,
    isLoadingMore,
    loadMore,
    refresh,
  }
}

function canonicalizeState(state: FleetQueryState): FleetQueryState {
  return parseFleetQuery(serializeFleetQuery(state)).state
}

async function refreshApplicationData(
  client: FleetDataClient,
  request: ApplicationRequest,
  cached: FleetApplicationsData | undefined,
  signal: AbortSignal,
): Promise<FleetApplicationsData> {
  requireActiveLoadSignal(signal)
  const firstPage = await client.queryApplications(request.state, {
    cursor: "",
    pageSize: APPLICATION_PAGE_SIZE,
    signal,
  })
  requireActiveLoadSignal(signal)
  const pages = canRetainLaterPages(cached, firstPage)
    ? [firstPage, ...cached.pages.slice(1)]
    : [firstPage]

  return applicationData(request.view, pages)
}

function canRetainLaterPages(
  cached: FleetApplicationsData | undefined,
  firstPage: FleetApplicationsPage,
): cached is FleetApplicationsData {
  const cachedFirstPage = cached?.pages[0]
  return (
    cached !== undefined &&
    cached.pages.length > 1 &&
    cachedFirstPage !== undefined &&
    firstPage.nextCursor.length > 0 &&
    cached.indexGeneration === firstPage.indexGeneration &&
    cachedFirstPage.indexGeneration === firstPage.indexGeneration &&
    cached.total === firstPage.total &&
    cached.pages.every(
      (page) =>
        page.indexGeneration === firstPage.indexGeneration &&
        page.total === firstPage.total,
    ) &&
    cachedFirstPage.nextCursor === firstPage.nextCursor
  )
}

function applicationPageBase(
  data: FleetApplicationsData,
): ApplicationPageBase {
  return {
    pages: data.pages,
    generation: data.indexGeneration,
    pageCount: data.pages.length,
    cursor: data.pages.at(-1)?.nextCursor ?? "",
  }
}

function sameApplicationPageBase(
  data: FleetPresentationData | undefined,
  base: ApplicationPageBase,
): data is FleetApplicationsData {
  return (
    data?.kind === "applications" &&
    data.pages === base.pages &&
    data.indexGeneration === base.generation &&
    data.pages.length === base.pageCount &&
    (data.pages.at(-1)?.nextCursor ?? "") === base.cursor
  )
}

function isEmptyApplicationReset(
  data: FleetPresentationData | undefined,
): data is FleetApplicationsData {
  return (
    data?.kind === "applications" &&
    data.pages.length === 0 &&
    data.indexGeneration === BigInt(0)
  )
}

function createApplicationLoader(
  fetchPage: (
    cursor: string,
    signal: AbortSignal,
  ) => Promise<FleetApplicationsPage>,
  resetFleetPages: () => void,
): ApplicationLoader {
  let activeSignal: AbortSignal | undefined
  let restarted = false
  const loadPage = createFleetPageLoader({
    fetchPage: (cursor) => {
      const signal = requireActiveLoadSignal(activeSignal)
      return fetchPage(cursor, signal)
    },
    resetFleetPages: () => {
      requireActiveLoadSignal(activeSignal)
      restarted = true
      resetFleetPages()
    },
  })

  return {
    load: async (cursor, signal) => {
      activeSignal = signal
      restarted = false
      requireActiveLoadSignal(signal)
      const page = await loadPage(cursor)
      return { page, restarted }
    },
  }
}

function requireActiveLoadSignal(
  signal: AbortSignal | undefined,
): AbortSignal {
  if (signal?.aborted === false) return signal
  const error = new Error("application page request was canceled")
  error.name = "AbortError"
  throw error
}

function activeRequest(state: FleetQueryState): ActiveRequest {
  switch (state.view) {
    case "table":
    case "queue": {
      const requestState =
        state.view === "queue"
          ? { ...state, sort: "impact" as const, direction: "desc" as const }
          : state
      return {
        kind: "applications",
        view: state.view,
        state: requestState,
        key: [
          "fleet",
          "applications",
          state.view,
          toQueryApplicationsRequest(requestState, {
            pageSize: APPLICATION_PAGE_SIZE,
          }).toJsonString(),
        ],
      }
    }
    case "heatmap":
    case "treemap":
      return {
        kind: "map",
        state,
        key: [
          "fleet",
          "map",
          toQueryFleetMapRequest(state).toJsonString(),
        ],
      }
    case "matrix":
      return {
        kind: "matrix",
        view: "matrix",
        state,
        key: [
          "fleet",
          "matrix",
          "matrix",
          toQueryFleetMatrixRequest(state).toJsonString(),
        ],
      }
  }
}

function applicationData(
  view: "table" | "queue",
  pages: readonly FleetApplicationsPage[],
): FleetApplicationsData {
  const first = pages[0]
  const latest = pages.at(-1)
  return {
    kind: "applications",
    view,
    pages,
    applications: mergeFleetApplicationPages(pages),
    facets: first?.facets ?? [],
    total: latest?.total ?? BigInt(0),
    indexGeneration: latest?.indexGeneration ?? BigInt(0),
  }
}

function dataStatus(
  query: {
    isPending: boolean
    isError: boolean
    error: unknown
  },
  currentData: FleetPresentationData | undefined,
  staleData: FleetPresentationData | undefined,
  partialError: unknown,
): FleetDataStatus {
  if (partialError !== undefined && currentData) return "partial"
  if (staleData) return "stale"
  if (query.isPending) return staleData ? "stale" : "loading"
  if (query.isError) return errorStatus(query.error)
  if (!currentData) return "loading"
  return isEmptyData(currentData) ? "empty" : "ready"
}

function errorStatus(error: unknown): FleetDataStatus {
  if (error instanceof ConnectError) {
    if (
      error.code === Code.Unauthenticated ||
      error.code === Code.PermissionDenied
    ) {
      return "unauthorized"
    }
    if (error.code === Code.Unavailable) return "unavailable"
  }
  return "error"
}

function isEmptyData(data: FleetPresentationData): boolean {
  switch (data.kind) {
    case "applications":
      return data.total === BigInt(0)
    case "map":
    case "matrix":
      return data.result.total === BigInt(0)
  }
}

function presentationFacets(
  data: FleetPresentationData | undefined,
): readonly FleetFacetBucket[] {
  if (!data) return []
  return data.kind === "applications" ? data.facets : data.result.facets
}
