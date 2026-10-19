"use client"

import { Code, createPromiseClient } from "@connectrpc/connect"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"

import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import { DataClass, DataState, type DataSourceStatus } from "@/gen/paprika/v1/api_pb"
import { createTransport } from "@/lib/transport"
import { queryApplications, type FleetApplicationSummary } from "@/lib/fleet-client"
import { DEFAULT_FLEET_QUERY } from "@/lib/fleet-query"

export const applicationClient = createPromiseClient(PaprikaService, createTransport())
export const applicationQueryKey = (namespace: string, name: string) => ["application-detail", namespace, name] as const

function available(sources: DataSourceStatus[] | undefined, dataClass: DataClass): boolean {
  return sources?.some((source) => source.dataClass === dataClass &&
    (source.state === DataState.OK || source.state === DataState.STALE)) ?? false
}

export function isApplicationNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === Code.NotFound
}

/** Match an authorized indexed observation exactly, even among paginated names. */
export async function queryApplicationObservation(namespace: string, name: string, signal?: AbortSignal) {
  let cursor = ""
  const cursors = new Set<string>()
  for (;;) {
    const page = await queryApplications({ ...DEFAULT_FLEET_QUERY, namespaces: [namespace], q: name }, { cursor, signal })
    const summary = page.applications.find((application) =>
      application.identity?.namespace === namespace && application.identity.name === name)
    if (summary || !page.nextCursor) return { summary, indexGeneration: page.indexGeneration }
    if (cursors.has(page.nextCursor)) throw new Error("Application observations returned a repeated cursor")
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
}

/** Independent queries render the app immediately, retain warm visits, and deduplicate reads. */
export function useApplicationData(namespace: string, name: string, resourcesEnabled: boolean) {
  const queryClient = useQueryClient()
  const enabled = Boolean(namespace && name)
  const key = applicationQueryKey(namespace, name)
  const defaultRetry = queryClient.getDefaultOptions().queries?.retry ?? 3
  const application = useQuery({
    queryKey: [...key, "application"], enabled, staleTime: 15_000,
    retry: (failureCount, error) => {
      // A satellite-only application has no central object to retry loading.
      if (isApplicationNotFound(error)) return false
      if (typeof defaultRetry === "function") return defaultRetry(failureCount, error)
      return defaultRetry === true || (typeof defaultRetry === "number" && failureCount < defaultRetry)
    },
    queryFn: ({ signal }) => applicationClient.getApplication({ namespace, name }, { signal }),
  })
  const observation = useQuery<{ summary: FleetApplicationSummary | undefined; indexGeneration: bigint }>({
    queryKey: [...key, "fleet"], enabled, staleTime: 15_000,
    queryFn: ({ signal }) => queryApplicationObservation(namespace, name, signal),
  })
  const centralApplication = enabled && Boolean(application.data?.application)
  const releases = useQuery({
    queryKey: [...key, "releases"], enabled: centralApplication, staleTime: 30_000,
    queryFn: ({ signal }) => applicationClient.listReleases({ namespace, applicationName: name }, { signal }),
  })
  const tree = useQuery({
    queryKey: [...key, "tree"], enabled: centralApplication && resourcesEnabled, staleTime: 15_000,
    queryFn: ({ signal }) => applicationClient.getResourceTreeDetailed({ applicationNamespace: namespace, applicationName: name }, { signal }),
  })
  const sources = useQuery({
    queryKey: ["application-sources", namespace], enabled, staleTime: 5 * 60_000,
    queryFn: ({ signal }) => applicationClient.getDataSources({ namespace }, { signal }),
  })
  const ownership = useQuery({
    queryKey: [...key, "ownership"], enabled: centralApplication && available(sources.data?.sources, DataClass.OWNERSHIP), staleTime: 60_000,
    queryFn: ({ signal }) => applicationClient.getApplicationOwnership({ namespace, name }, { signal }),
  })
  const lifecycle = useQuery({
    queryKey: [...key, "lifecycle"], enabled: centralApplication && available(sources.data?.sources, DataClass.LIFECYCLE), staleTime: 15_000,
    queryFn: ({ signal }) => applicationClient.getApplicationLifecycle({ namespace, name }, { signal }),
  })
  const revision = application.data?.application?.sourceRevision ?? ""
  const commit = useQuery({
    queryKey: [...key, "commit", revision], enabled: centralApplication && available(sources.data?.sources, DataClass.COMMIT_METADATA), staleTime: 5 * 60_000,
    queryFn: ({ signal }) => applicationClient.getRevisionInfo({ namespace, application: name, revision }, { signal }),
  })
  // Refresh dynamic observations, preserving longer-lived metadata and capability caches.
  const refresh = useCallback(async () => {
    const refreshed = await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: [...applicationQueryKey(namespace, name), "application"], exact: true }, { throwOnError: true }),
      queryClient.invalidateQueries({ queryKey: applicationQueryKey(namespace, name),
        predicate: (query) => ["releases", "tree", "lifecycle", "resource", "fleet"].includes(String(query.queryKey[3])),
      }, { throwOnError: true }),
    ])
    for (const [index, result] of refreshed.entries()) {
      if (result.status === "fulfilled") continue
      if (index === 0 && isApplicationNotFound(result.reason) && observation.data?.summary && !centralApplication) continue
      throw result.reason
    }
  }, [queryClient, namespace, name, observation.data?.summary, centralApplication])

  return { application, observation, releases, tree, sources, ownership, lifecycle, commit, refresh }
}
