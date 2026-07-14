"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

interface ScopeIntent {
  scope: FleetScope
  pendingRouteKey: string | null
}

type NavigationSynchronization =
  | "unchanged"
  | "intermediate"
  | "latest"
  | "external"

type FacetSource = {
  facets: readonly FleetFacetBucket[]
  availability: "available" | "unknown"
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
  const observedScope = useMemo(
    () => scopeFromState(parsed.state),
    [parsed.state],
  )
  const pendingNavigation = useRef<PendingNavigation>({
    observedRouteKey: routeKey,
    params: new URLSearchParams(rawQuery),
    semanticState: parsed.state,
    issuedRouteKeys: new Set(),
    latestIssuedRouteKey: null,
  })
  const [scopeIntent, setScopeIntent] = useState<ScopeIntent>(() => ({
    scope: observedScope,
    pendingRouteKey: null,
  }))
  const scopeIntentRef = useRef(scopeIntent)
  const [externalNavigationRevision, setExternalNavigationRevision] =
    useState(0)
  const handledExternalNavigationRevision = useRef(0)
  const publishScopeIntent = useCallback((next: ScopeIntent) => {
    scopeIntentRef.current = next
    setScopeIntent((current) =>
      sameScopeIntent(current, next) ? current : next,
    )
  }, [])

  useEffect(() => {
    function invalidatePendingIntent() {
      setExternalNavigationRevision((revision) => revision + 1)
    }

    window.addEventListener("popstate", invalidatePendingIntent)
    return () =>
      window.removeEventListener("popstate", invalidatePendingIntent)
  }, [])

  useLayoutEffect(() => {
    const forceExternal =
      handledExternalNavigationRevision.current !==
      externalNavigationRevision
    handledExternalNavigationRevision.current = externalNavigationRevision
    const synchronization = synchronizePendingNavigation(
      pendingNavigation.current,
      pathname,
      rawQuery,
      parsed.state,
      forceExternal,
    )
    if (synchronization === "latest" || synchronization === "external") {
      publishScopeIntent({ scope: observedScope, pendingRouteKey: null })
      return
    }
    if (synchronization === "intermediate") {
      const current = scopeIntentRef.current
      publishScopeIntent({
        scope: current.scope,
        pendingRouteKey:
          current.pendingRouteKey !== null ||
          !sameFleetScope(current.scope, observedScope)
            ? pendingNavigation.current.latestIssuedRouteKey
            : null,
      })
    }
  }, [
    externalNavigationRevision,
    observedScope,
    parsed.state,
    pathname,
    publishScopeIntent,
    rawQuery,
  ])
  const scope = scopeIntent.scope
  const scopePending =
    scopeIntent.pendingRouteKey !== null ||
    !sameFleetScope(scope, observedScope)
  const facetRequestState = useMemo<FleetQueryState>(
    () => ({ ...parsed.state, view: "heatmap" }),
    [parsed.state],
  )
  const fleet = useFleetData(facetRequestState)
  const [mutationFailure, setMutationFailure] = useState<
    MutationFailure | undefined
  >()

  const facetSource = useMemo<FacetSource | undefined>(() => {
    if (scopePending) {
      if (fleet.displayData?.kind !== "map") return undefined
      return {
        facets: fleet.displayData.result.facets,
        availability: "unknown",
      }
    }
    if (!isAuthoritativeStatus(fleet.status)) return undefined
    if (fleet.currentData?.kind !== "map") return undefined
    return {
      facets: fleet.currentData.result.facets,
      availability: "available",
    }
  }, [fleet.currentData, fleet.displayData, fleet.status, scopePending])
  const facets = useMemo(
    () =>
      buildScopeFacets(
        scope,
        facetSource?.facets,
        facetSource?.availability,
      ),
    [facetSource, scope],
  )
  const scopeStatus: FleetDataStatus = scopePending ? "loading" : fleet.status
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
      const nextScope = scopeFromState(nextState)
      publishScopeIntent({
        scope: nextScope,
        pendingRouteKey: sameFleetScope(nextScope, observedScope)
          ? null
          : nextRouteKey,
      })
      setMutationFailure(undefined)
      router.replace(fleetHref(`${pathname}${hash}`, next), { scroll: false })
      return true
    },
    [
      observedScope,
      parsed.state,
      pathname,
      publishScopeIntent,
      rawQuery,
      routeKey,
      router,
    ],
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
      status: scopeStatus,
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
      mutationError,
      parsed.notices,
      parsed.state,
      patchQuery,
      patchScope,
      retry,
      scope,
      scopeStatus,
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

function scopeFromState(state: FleetQueryState): FleetScope {
  return {
    projects: state.projects,
    clusters: state.clusters,
    stages: state.stages,
    namespaces: state.namespaces,
  }
}

function sameScopeIntent(left: ScopeIntent, right: ScopeIntent): boolean {
  return (
    left.pendingRouteKey === right.pendingRouteKey &&
    sameFleetScope(left.scope, right.scope)
  )
}

function sameFleetScope(left: FleetScope, right: FleetScope): boolean {
  return (
    sameNamespacedKeys(left.projects, right.projects) &&
    sameNamespacedKeys(left.clusters, right.clusters) &&
    sameStrings(left.stages, right.stages) &&
    sameStrings(left.namespaces, right.namespaces)
  )
}

function sameNamespacedKeys(
  left: readonly NamespacedKey[],
  right: readonly NamespacedKey[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.namespace === right[index]?.namespace &&
        value.name === right[index]?.name,
    )
  )
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function buildScopeFacets(
  scope: FleetScope,
  facetBuckets: readonly FleetFacetBucket[] | undefined,
  facetAvailability: "available" | "unknown" | undefined,
): FleetScopeFacet[] {
  const options = new Map<string, FleetScopeFacet>()
  const authoritative =
    facetBuckets !== undefined && facetAvailability === "available"

  for (const facet of facetBuckets ?? []) {
    const option = fromFacetBucket(facet, facetAvailability ?? "unknown")
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

function fromFacetBucket(
  facet: FleetFacetBucket,
  availability: "available" | "unknown",
): FleetScopeFacet | undefined {
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
      count: availability === "available" ? facet.count : undefined,
      selected: false,
      availability,
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
      count: availability === "available" ? facet.count : undefined,
      selected: false,
      availability,
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
  forceExternal = false,
): NavigationSynchronization {
  const observedRouteKey = navigationRouteKey(pathname, rawQuery)
  if (!forceExternal && navigation.observedRouteKey === observedRouteKey) {
    return "unchanged"
  }

  navigation.observedRouteKey = observedRouteKey
  if (!forceExternal && navigation.issuedRouteKeys.has(observedRouteKey)) {
    navigation.issuedRouteKeys.delete(observedRouteKey)
    if (navigation.latestIssuedRouteKey !== observedRouteKey) {
      return "intermediate"
    }

    navigation.params = new URLSearchParams(rawQuery)
    navigation.semanticState = semanticState
    navigation.issuedRouteKeys.clear()
    navigation.latestIssuedRouteKey = null
    return "latest"
  }

  navigation.params = new URLSearchParams(rawQuery)
  navigation.semanticState = semanticState
  navigation.issuedRouteKeys.clear()
  navigation.latestIssuedRouteKey = null
  return "external"
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
