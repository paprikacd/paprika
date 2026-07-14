"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import type { FleetFacetBucket } from "@/lib/fleet-client"
import {
  fleetHref,
  migrateLegacyDetailIdentity,
  patchFleetSearchParams,
  type FleetDetailKind,
  type FleetIdentityAmbiguity,
} from "@/lib/fleet-navigation"
import {
  isValidNamespacedKey,
  mergeFleetQuery,
  parseFleetQuery,
  serializeFleetQuery,
  type FleetQueryNotice,
  type FleetQueryPatch,
  type FleetQueryState,
  type NamespacedKey,
} from "@/lib/fleet-query"
import {
  useFleetData,
  type FleetDataStatus,
} from "@/lib/use-fleet-data"

export type FleetScope = Pick<
  FleetQueryState,
  "projects" | "clusters" | "stages" | "namespaces"
>

export type FleetScopePatch = Partial<FleetScope>
export type FleetScopeDimension = "project" | "cluster" | "stage" | "namespace"
export type FleetScopeFacetAvailability = "available" | "unavailable" | "unknown"

export interface FleetScopeFacet {
  dimension: FleetScopeDimension
  id: string
  object?: NamespacedKey
  value?: string
  label: string
  count?: bigint
  selected: boolean
  availability: FleetScopeFacetAvailability
}

export interface FleetScopeContextValue {
  state: FleetQueryState
  scope: FleetScope
  facets: readonly FleetScopeFacet[]
  status: FleetDataStatus
  error: unknown
  notices: readonly FleetQueryNotice[]
  mutationError: FleetIdentityAmbiguity | null
  patchQuery: (patch: FleetQueryPatch) => boolean
  patchScope: (patch: FleetScopePatch) => boolean
  retry: () => Promise<void>
}

interface MutationFailure {
  routeKey: string
  error: FleetIdentityAmbiguity
}

interface PendingNavigation {
  observedRouteKey: string
  params: URLSearchParams
  semanticState: FleetQueryState
  issuedRouteKeys: Set<string>
  latestIssuedRouteKey: string | null
}

const FLEET_OWNED_QUERY_KEYS = [
  "project",
  "cluster",
  "stage",
  "namespace",
  "health",
  "sync",
  "release",
  "rollout",
  "source",
  "q",
  "sort",
  "direction",
  "view",
  "group",
  "rows",
  "columns",
  "size",
  "density",
  "labels",
  "zoom",
  "selected",
  "range",
] as const

const FleetScopeContext = createContext<FleetScopeContextValue | undefined>(
  undefined,
)

export function FleetScopeProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const rawQuery = searchParams.toString()
  const parsed = useMemo(() => parseFleetQuery(rawQuery), [rawQuery])
  const routeKey = navigationRouteKey(pathname, rawQuery)
  const pendingNavigation = useRef<PendingNavigation>({
    observedRouteKey: routeKey,
    params: new URLSearchParams(rawQuery),
    semanticState: parsed.state,
    issuedRouteKeys: new Set(),
    latestIssuedRouteKey: null,
  })
  useLayoutEffect(() => {
    synchronizePendingNavigation(
      pendingNavigation.current,
      pathname,
      rawQuery,
      parsed.state,
    )
  }, [parsed.state, pathname, rawQuery])
  const scope = useMemo<FleetScope>(
    () => ({
      projects: parsed.state.projects,
      clusters: parsed.state.clusters,
      stages: parsed.state.stages,
      namespaces: parsed.state.namespaces,
    }),
    [
      parsed.state.clusters,
      parsed.state.namespaces,
      parsed.state.projects,
      parsed.state.stages,
    ],
  )
  const facetRequestState = useMemo<FleetQueryState>(
    () => ({ ...parsed.state, view: "heatmap" }),
    [parsed.state],
  )
  const fleet = useFleetData(facetRequestState)
  const [mutationFailure, setMutationFailure] = useState<
    MutationFailure | undefined
  >()

  const authoritativeFacets = useMemo(() => {
    if (!isAuthoritativeStatus(fleet.status)) return undefined
    if (fleet.currentData?.kind !== "map") return undefined
    return fleet.currentData.result.facets
  }, [fleet.currentData, fleet.status])
  const facets = useMemo(
    () => buildScopeFacets(scope, authoritativeFacets),
    [authoritativeFacets, scope],
  )
  const mutationError =
    mutationFailure?.routeKey === routeKey ? mutationFailure.error : null

  const applyPatch = useCallback(
    (patch: FleetQueryPatch, scopeChanged: boolean): boolean => {
      const navigation = pendingNavigation.current
      synchronizePendingNavigation(
        navigation,
        pathname,
        rawQuery,
        parsed.state,
      )

      let current = new URLSearchParams(navigation.params)
      if (scopeChanged) {
        const detailKind = detailKindForPath(pathname)
        if (detailKind) {
          const migrated = migrateLegacyDetailIdentity(detailKind, current)
          if (!(migrated instanceof URLSearchParams)) {
            setMutationFailure({ routeKey, error: migrated })
            return false
          }
          current = migrated
        }
      }

      const semanticPatch = scopeChanged
        ? { ...patch, selected: null, zoom: "" }
        : patch
      const nextState = mergeFleetQuery(
        navigation.semanticState,
        semanticPatch,
      )
      let next = canonicalFleetSearchParams(current, nextState)
      if (scopeChanged) {
        next = patchFleetSearchParams(next, {}, { scopeChanged: true })
      }
      const hash = typeof window === "undefined" ? "" : window.location.hash
      const nextRouteKey = navigationRouteKey(pathname, next.toString())

      navigation.params = new URLSearchParams(next)
      navigation.semanticState = nextState
      navigation.issuedRouteKeys.add(nextRouteKey)
      navigation.latestIssuedRouteKey = nextRouteKey
      setMutationFailure(undefined)
      router.replace(fleetHref(`${pathname}${hash}`, next), { scroll: false })
      return true
    },
    [parsed.state, pathname, rawQuery, routeKey, router],
  )

  const patchQuery = useCallback(
    (patch: FleetQueryPatch) => applyPatch(patch, false),
    [applyPatch],
  )
  const patchScope = useCallback(
    (patch: FleetScopePatch) => applyPatch(patch, true),
    [applyPatch],
  )
  const retry = fleet.refresh

  const value = useMemo<FleetScopeContextValue>(
    () => ({
      state: parsed.state,
      scope,
      facets,
      status: fleet.status,
      error: fleet.error,
      notices: parsed.notices,
      mutationError,
      patchQuery,
      patchScope,
      retry,
    }),
    [
      facets,
      fleet.error,
      fleet.status,
      mutationError,
      parsed.notices,
      parsed.state,
      patchQuery,
      patchScope,
      retry,
      scope,
    ],
  )

  return (
    <FleetScopeContext.Provider value={value}>
      {children}
    </FleetScopeContext.Provider>
  )
}

export function useFleetScope(): FleetScopeContextValue {
  const value = useContext(FleetScopeContext)
  if (!value) {
    throw new Error("useFleetScope must be used within FleetScopeProvider")
  }
  return value
}

function isAuthoritativeStatus(status: FleetDataStatus): boolean {
  return status === "ready" || status === "empty" || status === "partial"
}

function buildScopeFacets(
  scope: FleetScope,
  authoritativeFacets: readonly FleetFacetBucket[] | undefined,
): FleetScopeFacet[] {
  const options = new Map<string, FleetScopeFacet>()
  const authoritative = authoritativeFacets !== undefined

  for (const facet of authoritativeFacets ?? []) {
    const option = fromFacetBucket(facet)
    if (!option) continue
    options.set(facetKey(option.dimension, option.id), option)
  }

  for (const value of scope.projects) {
    mergeSelectedObject(options, "project", value, authoritative)
  }
  for (const value of scope.clusters) {
    mergeSelectedObject(options, "cluster", value, authoritative)
  }
  for (const value of scope.stages) {
    mergeSelectedString(options, "stage", value, authoritative)
  }
  for (const value of scope.namespaces) {
    mergeSelectedString(options, "namespace", value, authoritative)
  }

  return [...options.values()].sort((left, right) => {
    const dimension = scopeDimensionOrder(left.dimension) - scopeDimensionOrder(right.dimension)
    return dimension || left.id.localeCompare(right.id)
  })
}

function fromFacetBucket(facet: FleetFacetBucket): FleetScopeFacet | undefined {
  if (facet.dimension === "project" || facet.dimension === "cluster") {
    if (!facet.object) return undefined
    const object = {
      namespace: facet.object.namespace.trim(),
      name: facet.object.name.trim(),
    }
    if (!isValidNamespacedKey(object)) return undefined
    const id = objectId(object)
    return {
      dimension: facet.dimension,
      id,
      object,
      label: facet.label.trim() || id,
      count: facet.count,
      selected: false,
      availability: "available",
    }
  }
  if (facet.dimension === "stage" || facet.dimension === "namespace") {
    const value = facet.value?.trim()
    if (!value) return undefined
    return {
      dimension: facet.dimension,
      id: value,
      value,
      label: facet.label.trim() || value,
      count: facet.count,
      selected: false,
      availability: "available",
    }
  }
  return undefined
}

function mergeSelectedObject(
  options: Map<string, FleetScopeFacet>,
  dimension: "project" | "cluster",
  value: NamespacedKey,
  authoritative: boolean,
): void {
  const id = objectId(value)
  const key = facetKey(dimension, id)
  const current = options.get(key)
  options.set(key, current
    ? { ...current, selected: true }
    : {
        dimension,
        id,
        object: { ...value },
        label: id,
        selected: true,
        availability: authoritative ? "unavailable" : "unknown",
      })
}

function mergeSelectedString(
  options: Map<string, FleetScopeFacet>,
  dimension: "stage" | "namespace",
  value: string,
  authoritative: boolean,
): void {
  const key = facetKey(dimension, value)
  const current = options.get(key)
  options.set(key, current
    ? { ...current, selected: true }
    : {
        dimension,
        id: value,
        value,
        label: value,
        selected: true,
        availability: authoritative ? "unavailable" : "unknown",
      })
}

function detailKindForPath(pathname: string): FleetDetailKind | undefined {
  switch (pathname.replace(/\/+$/, "")) {
    case "/dashboard/application":
      return "application"
    case "/dashboard/rollouts/detail":
      return "rollout"
    case "/dashboard/pipelines/detail":
      return "pipeline"
    case "/dashboard/applicationsets/detail":
      return "applicationset"
    default:
      return undefined
  }
}

function objectId(value: NamespacedKey): string {
  return `${value.namespace}/${value.name}`
}

function facetKey(dimension: FleetScopeDimension, id: string): string {
  return `${dimension}:${id}`
}

function scopeDimensionOrder(dimension: FleetScopeDimension): number {
  switch (dimension) {
    case "project":
      return 0
    case "cluster":
      return 1
    case "stage":
      return 2
    case "namespace":
      return 3
  }
}

function synchronizePendingNavigation(
  navigation: PendingNavigation,
  pathname: string,
  rawQuery: string,
  semanticState: FleetQueryState,
): void {
  const observedRouteKey = navigationRouteKey(pathname, rawQuery)
  if (navigation.observedRouteKey === observedRouteKey) return

  navigation.observedRouteKey = observedRouteKey
  if (navigation.issuedRouteKeys.has(observedRouteKey)) {
    navigation.issuedRouteKeys.delete(observedRouteKey)
    if (navigation.latestIssuedRouteKey !== observedRouteKey) return

    navigation.params = new URLSearchParams(rawQuery)
    navigation.semanticState = semanticState
    navigation.issuedRouteKeys.clear()
    navigation.latestIssuedRouteKey = null
    return
  }

  navigation.params = new URLSearchParams(rawQuery)
  navigation.semanticState = semanticState
  navigation.issuedRouteKeys.clear()
  navigation.latestIssuedRouteKey = null
}

function canonicalFleetSearchParams(
  current: URLSearchParams,
  state: FleetQueryState,
): URLSearchParams {
  const result = new URLSearchParams(current)
  for (const key of FLEET_OWNED_QUERY_KEYS) result.delete(key)
  for (const [key, value] of serializeFleetQuery(state)) {
    result.append(key, value)
  }
  return result
}

function navigationRouteKey(pathname: string, rawQuery: string): string {
  return `${pathname}?${rawQuery}`
}
