"use client"

import { useQuery } from "@tanstack/react-query"

import type {
  AbortRolloutResponse,
  GetDataSourcesResponse,
  GetRolloutResponse,
  HoldRolloutResponse,
  ListAnalysisRunsResponse,
  ListRolloutHistoryResponse,
  ListRolloutsResponse,
  PromoteRolloutResponse,
  ResumeRolloutResponse,
} from "@/gen/paprika/v1/api_pb"
import {
  useDataSourceIndex,
  type DataSourcesClient,
} from "@/lib/data-state"
import { getFleetClient } from "@/lib/fleet-client"
import {
  FLEET_REFRESH_INTERVAL_MS,
  FOCUSED_REFRESH_INTERVAL_MS,
} from "@/lib/fleet-refresh"

/**
 * The slice of the API the rollout views use. Naming it keeps the views
 * testable without a transport and makes the call surface auditable: these
 * nine RPCs and nothing else.
 */
export interface RolloutConsoleClient {
  getDataSources(request: Record<string, never>): Promise<GetDataSourcesResponse>
  listRollouts(request: {
    namespace?: string
    project?: string
  }): Promise<ListRolloutsResponse>
  getRollout(request: {
    namespace: string
    name: string
  }): Promise<GetRolloutResponse>
  listAnalysisRuns(request: {
    namespace?: string
  }): Promise<ListAnalysisRunsResponse>
  listRolloutHistory(request: {
    namespace?: string
    sinceUnixMs?: bigint
    pageSize?: number
  }): Promise<ListRolloutHistoryResponse>
  promoteRollout(request: {
    namespace: string
    name: string
  }): Promise<PromoteRolloutResponse>
  abortRollout(request: {
    namespace: string
    name: string
  }): Promise<AbortRolloutResponse>
  holdRollout(request: {
    namespace: string
    name: string
    reason?: string
  }): Promise<HoldRolloutResponse>
  resumeRollout(request: {
    namespace: string
    name: string
    reason?: string
  }): Promise<ResumeRolloutResponse>
}

export function defaultRolloutClient(): RolloutConsoleClient {
  return getFleetClient()
}

export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const HISTORY_PAGE_SIZE = 100

/**
 * The boot-time capability probe, shared with the whole console through
 * `@/lib/data-state`: which boards exist is not something to re-ask per route.
 */
export function useDataSources(client: RolloutConsoleClient) {
  return useDataSourceIndex(client as unknown as DataSourcesClient)
}

export function useRolloutList(
  client: RolloutConsoleClient,
  namespace: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ["rollouts", "list", namespace],
    queryFn: () =>
      client.listRollouts(namespace ? { namespace } : {}),
    enabled,
    refetchInterval: FLEET_REFRESH_INTERVAL_MS,
  })
}

/**
 * The window is a length, not an instant. Keying on the length keeps the cache
 * entry stable across renders, and the instant is read where reading a clock is
 * allowed — inside the fetch, not during render.
 */
export function useRolloutHistory(
  client: RolloutConsoleClient,
  namespace: string,
  windowMs: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["rollouts", "history", namespace, windowMs],
    queryFn: () =>
      client.listRolloutHistory({
        ...(namespace ? { namespace } : {}),
        sinceUnixMs: BigInt(Date.now() - windowMs),
        pageSize: HISTORY_PAGE_SIZE,
      }),
    enabled,
    refetchInterval: FLEET_REFRESH_INTERVAL_MS,
  })
}

export function useRollout(
  client: RolloutConsoleClient,
  namespace: string,
  name: string,
) {
  return useQuery({
    queryKey: ["rollouts", "detail", namespace, name],
    queryFn: () => client.getRollout({ namespace, name }),
    enabled: Boolean(namespace && name),
    refetchInterval: FOCUSED_REFRESH_INTERVAL_MS,
  })
}

/**
 * Analysis runs are namespace-scoped rather than filtered by application
 * server-side, because a rollout is linked to its run by name and the console
 * has to try both the rollout's own name and its target's.
 */
export function useAnalysisRuns(
  client: RolloutConsoleClient,
  namespace: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["rollouts", "analysis-runs", namespace],
    queryFn: () => client.listAnalysisRuns(namespace ? { namespace } : {}),
    enabled: enabled && Boolean(namespace),
    refetchInterval: FOCUSED_REFRESH_INTERVAL_MS,
  })
}
