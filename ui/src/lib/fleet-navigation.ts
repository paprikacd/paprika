import type { FleetQueryState, NamespacedKey } from "@/lib/fleet-query"

export type FleetDetailKind = "application" | "rollout" | "pipeline" | "applicationset"
export type ObjectKey = NamespacedKey

export interface ResolvedFleetDetailIdentity {
  status: "resolved"
  source: "explicit" | "legacy"
  identity: ObjectKey
}

export interface MissingFleetDetailIdentity {
  status: "missing"
}

export interface FleetIdentityAmbiguity {
  status: "ambiguous"
  reason: "multiple_legacy_namespaces"
  namespaces: string[]
  name: string
}

export type DetailIdentityResult =
  | ResolvedFleetDetailIdentity
  | MissingFleetDetailIdentity
  | FleetIdentityAmbiguity

const ARRAY_PATCH_KEYS = {
  health: "health",
  sync: "sync",
  release: "release",
  rollout: "rollout",
  sources: "source",
} as const

const SCALAR_PATCH_KEYS = {
  q: "q",
  sort: "sort",
  direction: "direction",
  view: "view",
  group: "group",
  rows: "rows",
  columns: "columns",
  size: "size",
  density: "density",
  labels: "labels",
  zoom: "zoom",
  range: "range",
} as const

const SCOPE_CHANGE_TRANSIENT_KEYS = ["page", "cursor", "selected", "zoom"] as const

const DETAIL_ROUTES: Record<FleetDetailKind, string> = {
  application: "/dashboard/application",
  rollout: "/dashboard/rollouts/detail",
  pipeline: "/dashboard/pipelines/detail",
  applicationset: "/dashboard/applicationsets/detail",
}

const DETAIL_IDENTITY_KEYS: Record<
  FleetDetailKind,
  { namespace: string; name: string }
> = {
  application: { namespace: "application_namespace", name: "application_name" },
  rollout: { namespace: "rollout_namespace", name: "rollout_name" },
  pipeline: { namespace: "pipeline_namespace", name: "pipeline_name" },
  applicationset: { namespace: "applicationset_namespace", name: "applicationset_name" },
}

export function patchFleetSearchParams(
  current: URLSearchParams,
  patch: Partial<FleetQueryState>,
  options: { scopeChanged?: boolean } = {},
): URLSearchParams {
  const result = new URLSearchParams(current)

  if (Object.prototype.hasOwnProperty.call(patch, "projects")) {
    replaceValues(result, "project", encodeObjectKeys(patch.projects ?? []))
  }
  if (Object.prototype.hasOwnProperty.call(patch, "clusters")) {
    replaceValues(result, "cluster", encodeObjectKeys(patch.clusters ?? []))
  }
  if (Object.prototype.hasOwnProperty.call(patch, "stages")) {
    replaceValues(result, "stage", patch.stages ?? [])
  }
  if (Object.prototype.hasOwnProperty.call(patch, "namespaces")) {
    replaceValues(result, "namespace", patch.namespaces ?? [])
  }

  for (const field of Object.keys(ARRAY_PATCH_KEYS) as Array<keyof typeof ARRAY_PATCH_KEYS>) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue
    replaceValues(result, ARRAY_PATCH_KEYS[field], patch[field] ?? [])
  }

  for (const field of Object.keys(SCALAR_PATCH_KEYS) as Array<keyof typeof SCALAR_PATCH_KEYS>) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue
    replaceValues(result, SCALAR_PATCH_KEYS[field], [String(patch[field] ?? "")].filter(Boolean))
  }

  if (Object.prototype.hasOwnProperty.call(patch, "selected")) {
    replaceValues(result, "selected", patch.selected ? [encodeObjectKey(patch.selected)] : [])
  }

  if (options.scopeChanged) {
    for (const key of SCOPE_CHANGE_TRANSIENT_KEYS) result.delete(key)
  }

  return result
}

export function fleetHref(pathname: string, current: URLSearchParams): string {
  const { path, query, hash } = splitInternalHref(pathname)
  const result = new URLSearchParams(current)
  const routeParameters = new URLSearchParams(query)
  const routeKeys = [...new Set(routeParameters.keys())]

  for (const key of routeKeys) replaceValues(result, key, routeParameters.getAll(key))

  const serialized = result.toString()
  return `${path}${serialized ? `?${serialized}` : ""}${hash}`
}

export function fleetDetailHref(
  kind: FleetDetailKind,
  key: ObjectKey,
  current: URLSearchParams,
): string {
  const result = new URLSearchParams(current)
  const identityKeys = DETAIL_IDENTITY_KEYS[kind]
  result.set(identityKeys.namespace, key.namespace)
  result.set(identityKeys.name, key.name)
  return fleetHref(DETAIL_ROUTES[kind], result)
}

export function readFleetDetailIdentity(
  kind: FleetDetailKind,
  params: URLSearchParams,
): DetailIdentityResult {
  const keys = DETAIL_IDENTITY_KEYS[kind]
  const explicitNamespace = trimmedLast(params, keys.namespace)
  const explicitName = trimmedLast(params, keys.name)
  if (params.has(keys.namespace) || params.has(keys.name)) {
    if (explicitNamespace && explicitName) {
      return {
        status: "resolved",
        source: "explicit",
        identity: { namespace: explicitNamespace, name: explicitName },
      }
    }
    return { status: "missing" }
  }

  const legacyName = trimmedLast(params, "name")
  const legacyNamespaces = params
    .getAll("namespace")
    .map((value) => value.trim())
    .filter(Boolean)

  if (legacyName && legacyNamespaces.length > 1) {
    return {
      status: "ambiguous",
      reason: "multiple_legacy_namespaces",
      namespaces: legacyNamespaces,
      name: legacyName,
    }
  }
  if (legacyName && legacyNamespaces.length === 1) {
    return {
      status: "resolved",
      source: "legacy",
      identity: { namespace: legacyNamespaces[0], name: legacyName },
    }
  }
  return { status: "missing" }
}

export function migrateLegacyDetailIdentity(
  kind: FleetDetailKind,
  params: URLSearchParams,
): URLSearchParams | FleetIdentityAmbiguity {
  const identity = readFleetDetailIdentity(kind, params)
  if (identity.status === "ambiguous") return identity

  const result = new URLSearchParams(params)
  if (identity.status !== "resolved" || identity.source !== "legacy") return result

  const keys = DETAIL_IDENTITY_KEYS[kind]
  result.set(keys.namespace, identity.identity.namespace)
  result.set(keys.name, identity.identity.name)
  result.delete("name")
  return result
}

function encodeObjectKeys(values: readonly NamespacedKey[]): string[] {
  return values.map(encodeObjectKey)
}

function encodeObjectKey(value: NamespacedKey): string {
  return `${value.namespace}/${value.name}`
}

function replaceValues(parameters: URLSearchParams, key: string, values: readonly string[]): void {
  parameters.delete(key)
  for (const value of values) parameters.append(key, value)
}

function trimmedLast(parameters: URLSearchParams, key: string): string {
  return parameters.getAll(key).at(-1)?.trim() ?? ""
}

function splitInternalHref(href: string): { path: string; query: string; hash: string } {
  const hashIndex = href.indexOf("#")
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : ""
  const withoutHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href
  const queryIndex = withoutHash.indexOf("?")
  return {
    path: queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash,
    query: queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "",
    hash,
  }
}
