"use client"

import { createPromiseClient } from "@connectrpc/connect"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"

import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import { DataClass, DataState, type DataSourceStatus } from "@/gen/paprika/v1/api_pb"
import { createTransport } from "@/lib/transport"

export const applicationClient = createPromiseClient(PaprikaService, createTransport())
export const applicationQueryKey = (namespace: string, name: string) => ["application-detail", namespace, name] as const

function available(sources: DataSourceStatus[] | undefined, dataClass: DataClass): boolean {
  return sources?.some((source) => source.dataClass === dataClass &&
    (source.state === DataState.OK || source.state === DataState.STALE)) ?? false
}

/** Independent queries render the app immediately, retain warm visits, and deduplicate reads. */
export function useApplicationData(namespace: string, name: string, resourcesEnabled: boolean) {
  const queryClient = useQueryClient()
  const enabled = Boolean(namespace && name)
  const key = applicationQueryKey(namespace, name)
  const application = useQuery({
    queryKey: [...key, "application"], enabled, staleTime: 15_000,
    queryFn: ({ signal }) => applicationClient.getApplication({ namespace, name }, { signal }),
  })
  const releases = useQuery({
    queryKey: [...key, "releases"], enabled, staleTime: 30_000,
    queryFn: ({ signal }) => applicationClient.listReleases({ namespace, applicationName: name }, { signal }),
  })
  const tree = useQuery({
    queryKey: [...key, "tree"], enabled: enabled && resourcesEnabled, staleTime: 15_000,
    queryFn: ({ signal }) => applicationClient.getResourceTreeDetailed({ applicationNamespace: namespace, applicationName: name }, { signal }),
  })
  const sources = useQuery({
    queryKey: ["application-sources", namespace], enabled, staleTime: 5 * 60_000,
    queryFn: ({ signal }) => applicationClient.getDataSources({ namespace }, { signal }),
  })
  const ownership = useQuery({
    queryKey: [...key, "ownership"], enabled: enabled && available(sources.data?.sources, DataClass.OWNERSHIP), staleTime: 60_000,
    queryFn: ({ signal }) => applicationClient.getApplicationOwnership({ namespace, name }, { signal }),
  })
  const lifecycle = useQuery({
    queryKey: [...key, "lifecycle"], enabled: enabled && available(sources.data?.sources, DataClass.LIFECYCLE), staleTime: 15_000,
    queryFn: ({ signal }) => applicationClient.getApplicationLifecycle({ namespace, name }, { signal }),
  })
  const revision = application.data?.application?.sourceRevision ?? ""
  const commit = useQuery({
    queryKey: [...key, "commit", revision], enabled: enabled && available(sources.data?.sources, DataClass.COMMIT_METADATA), staleTime: 5 * 60_000,
    queryFn: ({ signal }) => applicationClient.getRevisionInfo({ namespace, application: name, revision }, { signal }),
  })
  // Refresh dynamic observations, preserving longer-lived metadata and capability caches.
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: applicationQueryKey(namespace, name),
      predicate: (query) => ["application", "releases", "tree", "lifecycle", "resource"].includes(String(query.queryKey[3])),
    }, { throwOnError: true })
  }, [queryClient, namespace, name])

  return { application, releases, tree, sources, ownership, lifecycle, commit, refresh }
}
