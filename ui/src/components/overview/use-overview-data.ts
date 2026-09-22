"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useMemo } from "react"

import {
  DataClass,
  GetDataSourcesRequest,
  GetSystemStatusRequest,
  ListClustersRequest,
  ListRolloutHistoryRequest,
  ListRolloutsRequest,
  ListSourceEventsRequest,
  type Cluster,
  type GetDataSourcesResponse,
  type GetSystemStatusResponse,
  type ListRolloutHistoryResponse,
  type ListClustersResponse,
  type ListRolloutsResponse,
  type ListSourceEventsResponse,
  type QueryApplicationsResponse,
  type Rollout,
} from "@/gen/paprika/v1/api_pb"
import { getFleetClient, toQueryApplicationsRequest } from "@/lib/fleet-client"
import {
  mergeFleetQuery,
  serializeFleetQuery,
  type FleetQueryState,
} from "@/lib/fleet-query"

import {
  DATA_SOURCES_QUERY_KEY,
  indexDataSources,
  surfaceExists,
  type DataSourceIndex,
} from "@/lib/data-state"

/** Nothing probed yet reads as nothing configured: boards stay hidden. */
const EMPTY_INDEX: DataSourceIndex = new Map()

/**
 * How much of the fleet the overview reads.
 *
 * The heatmap and the lifecycle roll-up are drawn from one bounded, impact
 * sorted page rather than the whole index, so the page cost and the DOM size
 * are the same at fifty applications as at fifty thousand. Both surfaces state
 * the sample they were drawn from.
 */
export const OVERVIEW_SAMPLE_SIZE = 60
export const ATTENTION_LIMIT = 12
const RECENT_ROLLOUT_LIMIT = 8
const SOURCE_EVENT_LIMIT = 8
const CLUSTER_LIMIT = 24
const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const SOURCE_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The RPCs the overview needs, narrowed to plain arguments so a test can stand
 * in for the transport without constructing protobuf requests.
 */
export interface OverviewClient {
  getDataSources(signal?: AbortSignal): Promise<GetDataSourcesResponse>
  getSystemStatus(
    attentionLimit: number,
    signal?: AbortSignal
  ): Promise<GetSystemStatusResponse>
  queryApplications(
    state: FleetQueryState,
    pageSize: number,
    signal?: AbortSignal
  ): Promise<QueryApplicationsResponse>
  listRollouts(signal?: AbortSignal): Promise<ListRolloutsResponse>
  listRolloutHistory(
    sinceUnixMs: bigint,
    pageSize: number,
    signal?: AbortSignal
  ): Promise<ListRolloutHistoryResponse>
  listSourceEvents(
    sinceUnixMs: bigint,
    pageSize: number,
    signal?: AbortSignal
  ): Promise<ListSourceEventsResponse>
  listClusters(pageSize: number, signal?: AbortSignal): Promise<ListClustersResponse>
}

export const defaultOverviewClient: OverviewClient = {
  getDataSources: (signal) =>
    getFleetClient().getDataSources(new GetDataSourcesRequest({}), { signal }),
  getSystemStatus: (attentionLimit, signal) =>
    getFleetClient().getSystemStatus(
      new GetSystemStatusRequest({ attentionLimit }),
      { signal }
    ),
  queryApplications: (state, pageSize, signal) =>
    getFleetClient().queryApplications(
      toQueryApplicationsRequest(state, { pageSize }),
      { signal }
    ),
  listRollouts: (signal) =>
    getFleetClient().listRollouts(new ListRolloutsRequest({}), { signal }),
  listRolloutHistory: (sinceUnixMs, pageSize, signal) =>
    getFleetClient().listRolloutHistory(
      new ListRolloutHistoryRequest({ sinceUnixMs, pageSize }),
      { signal }
    ),
  listSourceEvents: (sinceUnixMs, pageSize, signal) =>
    getFleetClient().listSourceEvents(
      new ListSourceEventsRequest({ sinceUnixMs, pageSize }),
      { signal }
    ),
  listClusters: (pageSize, signal) =>
    getFleetClient().listClusters(
      new ListClustersRequest({ pageSize, includeCapacity: true }),
      { signal }
    ),
}

export interface OverviewData {
  sources: DataSourceIndex
  sourcesResolved: boolean
  systemStatus: GetSystemStatusResponse | undefined
  applications: QueryApplicationsResponse | undefined
  rollouts: readonly Rollout[]
  rolloutHistory: ListRolloutHistoryResponse | undefined
  sourceEvents: ListSourceEventsResponse | undefined
  clusters: readonly Cluster[]
  isLoading: boolean
  isRefreshing: boolean
  refreshedAt: number | undefined
  indexGeneration: bigint | undefined
  refresh: () => Promise<void>
}

/**
 * One boot-time capability probe, then only the RPCs whose data class exists.
 *
 * Gating the fetches on `GetDataSources` rather than firing them all and
 * discarding empty results is the whole point of the probe: a console that
 * never asks for source events on a control plane that records none cannot
 * accidentally render a board for them.
 */
export function useOverviewData(
  state: FleetQueryState,
  client: OverviewClient = defaultOverviewClient
): OverviewData {
  const queryClient = useQueryClient()
  const sampleState = useMemo(
    () =>
      mergeFleetQuery(state, {
        view: "table",
        sort: "impact",
        direction: "desc",
      }),
    [state]
  )
  const scopeKey = useMemo(
    () => serializeFleetQuery(sampleState).toString(),
    [sampleState]
  )

  // The console-wide capability probe. One query key for every view, so the
  // probe is fetched once per session however the operator got here.
  const sources = useQuery({
    queryKey: DATA_SOURCES_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const response = await client.getDataSources(signal)
      return {
        index: indexDataSources(response.sources),
        indexGeneration: response.indexGeneration ?? BigInt(0),
      }
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  const index = sources.data?.index ?? EMPTY_INDEX
  const sourcesResolved = sources.isSuccess || sources.isError
  const has = useCallback(
    (dataClass: DataClass) => surfaceExists(index.get(dataClass)?.state),
    [index]
  )

  const systemStatus = useQuery({
    queryKey: ["overview", "system-status", scopeKey],
    queryFn: ({ signal }) => client.getSystemStatus(ATTENTION_LIMIT, signal),
  })

  const applications = useQuery({
    queryKey: ["overview", "applications", scopeKey],
    queryFn: ({ signal }) =>
      client.queryApplications(sampleState, OVERVIEW_SAMPLE_SIZE, signal),
  })

  const rollouts = useQuery({
    queryKey: ["overview", "rollouts"],
    queryFn: ({ signal }) => client.listRollouts(signal),
  })

  const historyEnabled = sourcesResolved && has(DataClass.ROLLOUT_HISTORY)
  const rolloutHistory = useQuery({
    queryKey: ["overview", "rollout-history"],
    queryFn: ({ signal }) =>
      client.listRolloutHistory(
        BigInt(Date.now() - HISTORY_WINDOW_MS),
        RECENT_ROLLOUT_LIMIT,
        signal
      ),
    enabled: historyEnabled,
  })

  const eventsEnabled = sourcesResolved && has(DataClass.SOURCE_EVENTS)
  const sourceEvents = useQuery({
    queryKey: ["overview", "source-events"],
    queryFn: ({ signal }) =>
      client.listSourceEvents(
        BigInt(Date.now() - SOURCE_EVENT_WINDOW_MS),
        SOURCE_EVENT_LIMIT,
        signal
      ),
    enabled: eventsEnabled,
  })

  const clustersEnabled =
    sourcesResolved &&
    (has(DataClass.CLUSTER_INVENTORY) || has(DataClass.CLUSTER_CAPACITY))
  const clusters = useQuery({
    queryKey: ["overview", "clusters"],
    queryFn: ({ signal }) => client.listClusters(CLUSTER_LIMIT, signal),
    enabled: clustersEnabled,
  })

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["overview"] })
  }, [queryClient])

  const updatedAt = Math.max(
    systemStatus.dataUpdatedAt,
    applications.dataUpdatedAt
  )

  return {
    sources: index,
    sourcesResolved,
    systemStatus: systemStatus.data,
    applications: applications.data,
    rollouts: rollouts.data?.rollouts ?? [],
    rolloutHistory: historyEnabled ? rolloutHistory.data : undefined,
    sourceEvents: eventsEnabled ? sourceEvents.data : undefined,
    clusters: clustersEnabled ? (clusters.data?.clusters ?? []) : [],
    isLoading: sources.isPending || systemStatus.isPending,
    isRefreshing:
      sources.isFetching ||
      systemStatus.isFetching ||
      applications.isFetching ||
      rollouts.isFetching,
    refreshedAt: updatedAt > 0 ? updatedAt : undefined,
    indexGeneration:
      applications.data?.indexGeneration ?? systemStatus.data?.indexGeneration,
    refresh,
  }
}
