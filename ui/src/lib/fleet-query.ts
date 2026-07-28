export interface NamespacedKey {
  namespace: string
  name: string
}

export const FLEET_HEALTH_VALUES = [
  "healthy",
  "progressing",
  "degraded",
  "failed",
  "unknown",
  "missing",
] as const
export type FleetHealth = (typeof FLEET_HEALTH_VALUES)[number]

export const FLEET_SYNC_VALUES = ["synced", "out_of_sync", "unknown"] as const
export type FleetSync = (typeof FLEET_SYNC_VALUES)[number]

export const FLEET_RELEASE_VALUES = [
  "pending",
  "promoting",
  "canarying",
  "verifying",
  "complete",
  "failed",
  "rolled_back",
  "superseded",
  "awaiting_approval",
] as const
export type FleetRelease = (typeof FLEET_RELEASE_VALUES)[number]

export const FLEET_ROLLOUT_VALUES = [
  "pending",
  "progressing",
  "paused",
  "healthy",
  "degraded",
  "failed",
  "rolled_back",
  "aborted",
] as const
export type FleetRollout = (typeof FLEET_ROLLOUT_VALUES)[number]

export const FLEET_SOURCE_VALUES = ["git", "helm", "kustomize", "s3", "oci", "inline"] as const
export type FleetSource = (typeof FLEET_SOURCE_VALUES)[number]

export const FLEET_SORT_VALUES = [
  "name",
  "project",
  "cluster",
  "stage",
  "health",
  "sync",
  "release",
  "rollout",
  "resource_count",
  "last_transition",
  "impact",
  "relevance",
] as const
export type FleetSort = (typeof FLEET_SORT_VALUES)[number]

export const FLEET_DIRECTION_VALUES = ["asc", "desc"] as const
export type FleetDirection = (typeof FLEET_DIRECTION_VALUES)[number]

export const FLEET_VIEW_VALUES = ["treemap", "matrix", "table", "queue"] as const
export type FleetView = (typeof FLEET_VIEW_VALUES)[number]

export const FLEET_GROUP_VALUES = ["project", "cluster", "stage", "health"] as const
export type FleetGroup = (typeof FLEET_GROUP_VALUES)[number]

export const FLEET_SIZE_VALUES = ["resource_count", "request_rate"] as const
export type FleetSize = (typeof FLEET_SIZE_VALUES)[number]

export const FLEET_RANGE_VALUES = ["15m", "30m", "1h", "2h", "6h", "12h", "24h", "3d", "7d"] as const
export type FleetRange = (typeof FLEET_RANGE_VALUES)[number]

export interface FleetQueryState {
  projects: NamespacedKey[]
  clusters: NamespacedKey[]
  stages: string[]
  namespaces: string[]
  health: FleetHealth[]
  sync: FleetSync[]
  release: FleetRelease[]
  rollout: FleetRollout[]
  sources: FleetSource[]
  q: string
  sort: FleetSort
  direction: FleetDirection
  view: FleetView
  group: FleetGroup
  rows: FleetGroup
  columns: FleetGroup
  size: FleetSize
  zoom: string
  selected: NamespacedKey | null
  range: FleetRange
}

export type FleetQueryPatch = Partial<FleetQueryState>

export type FleetQueryField =
  | "project"
  | "cluster"
  | "stage"
  | "namespace"
  | "health"
  | "sync"
  | "release"
  | "rollout"
  | "source"
  | "sort"
  | "direction"
  | "view"
  | "group"
  | "rows"
  | "columns"
  | "size"
  | "selected"
  | "range"

export interface FleetQueryNotice {
  field: FleetQueryField
  value: string
  reason: "invalid" | "not_available"
  message: string
}

export interface ParsedFleetQuery {
  state: FleetQueryState
  notices: FleetQueryNotice[]
}

export interface FleetFacetAvailability {
  projects?: readonly NamespacedKey[]
  clusters?: readonly NamespacedKey[]
  stages?: readonly string[]
  namespaces?: readonly string[]
  health?: readonly FleetHealth[]
  sync?: readonly FleetSync[]
  release?: readonly FleetRelease[]
  rollout?: readonly FleetRollout[]
  sources?: readonly FleetSource[]
}

export const DEFAULT_FLEET_QUERY: FleetQueryState = {
  projects: [],
  clusters: [],
  stages: [],
  namespaces: [],
  health: [],
  sync: [],
  release: [],
  rollout: [],
  sources: [],
  q: "",
  sort: "name",
  direction: "asc",
  view: "treemap",
  group: "project",
  rows: "project",
  columns: "cluster",
  size: "resource_count",
  zoom: "",
  selected: null,
  range: "2h",
}

interface QueryParameters {
  get(name: string): string | null
  getAll(name: string): string[]
}

const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/

export function parseFleetQuery(input: string | QueryParameters): ParsedFleetQuery {
  const parameters = typeof input === "string" ? new URLSearchParams(input) : input
  const notices: FleetQueryNotice[] = []
  const projects = parseNamespacedValues(parameters, "project", notices)
  const clusters = parseNamespacedValues(parameters, "cluster", notices)
  const stages = parseStringValues(parameters, "stage", notices)
  const namespaces = parseStringValues(parameters, "namespace", notices)
  const health = parseEnumValues(parameters, "health", FLEET_HEALTH_VALUES, notices)
  const sync = parseEnumValues(parameters, "sync", FLEET_SYNC_VALUES, notices)
  const release = parseEnumValues(parameters, "release", FLEET_RELEASE_VALUES, notices)
  const rollout = parseEnumValues(parameters, "rollout", FLEET_ROLLOUT_VALUES, notices)
  const sources = parseEnumValues(parameters, "source", FLEET_SOURCE_VALUES, notices)

  const state = canonicalizeFleetQuery({
    projects,
    clusters,
    stages,
    namespaces,
    health,
    sync,
    release,
    rollout,
    sources,
    q: lastTrimmed(parameters, "q"),
    sort: parseScalarEnum(parameters, "sort", FLEET_SORT_VALUES, DEFAULT_FLEET_QUERY.sort, notices),
    direction: parseScalarEnum(
      parameters,
      "direction",
      FLEET_DIRECTION_VALUES,
      DEFAULT_FLEET_QUERY.direction,
      notices,
    ),
    view: parseScalarEnum(parameters, "view", FLEET_VIEW_VALUES, DEFAULT_FLEET_QUERY.view, notices),
    group: parseScalarEnum(parameters, "group", FLEET_GROUP_VALUES, DEFAULT_FLEET_QUERY.group, notices),
    rows: parseScalarEnum(parameters, "rows", FLEET_GROUP_VALUES, DEFAULT_FLEET_QUERY.rows, notices),
    columns: parseScalarEnum(
      parameters,
      "columns",
      FLEET_GROUP_VALUES,
      DEFAULT_FLEET_QUERY.columns,
      notices,
    ),
    size: parseScalarEnum(parameters, "size", FLEET_SIZE_VALUES, DEFAULT_FLEET_QUERY.size, notices),
    zoom: lastTrimmed(parameters, "zoom"),
    selected: parseSelected(parameters, notices),
    range: parseScalarEnum(parameters, "range", FLEET_RANGE_VALUES, DEFAULT_FLEET_QUERY.range, notices),
  })
  return { state, notices }
}

export function serializeFleetQuery(input: FleetQueryState): URLSearchParams {
  const state = canonicalizeFleetQuery(input)
  const parameters = new URLSearchParams()
  appendNamespaced(parameters, "project", state.projects)
  appendNamespaced(parameters, "cluster", state.clusters)
  appendValues(parameters, "stage", state.stages)
  appendValues(parameters, "namespace", state.namespaces)
  appendValues(parameters, "health", state.health)
  appendValues(parameters, "sync", state.sync)
  appendValues(parameters, "release", state.release)
  appendValues(parameters, "rollout", state.rollout)
  appendValues(parameters, "source", state.sources)
  appendNonDefault(parameters, "q", state.q, DEFAULT_FLEET_QUERY.q)
  appendNonDefault(parameters, "sort", state.sort, DEFAULT_FLEET_QUERY.sort)
  appendNonDefault(parameters, "direction", state.direction, DEFAULT_FLEET_QUERY.direction)
  appendNonDefault(parameters, "view", state.view, DEFAULT_FLEET_QUERY.view)
  appendNonDefault(parameters, "group", state.group, DEFAULT_FLEET_QUERY.group)
  appendNonDefault(parameters, "rows", state.rows, DEFAULT_FLEET_QUERY.rows)
  appendNonDefault(parameters, "columns", state.columns, DEFAULT_FLEET_QUERY.columns)
  appendNonDefault(parameters, "size", state.size, DEFAULT_FLEET_QUERY.size)
  appendNonDefault(parameters, "zoom", state.zoom, DEFAULT_FLEET_QUERY.zoom)
  if (state.selected) parameters.set("selected", namespacedKey(state.selected))
  appendNonDefault(parameters, "range", state.range, DEFAULT_FLEET_QUERY.range)
  return parameters
}

export function mergeFleetQuery(current: FleetQueryState, patch: FleetQueryPatch): FleetQueryState {
  return canonicalizeFleetQuery({ ...current, ...patch })
}

export function reconcileFleetQuery(
  current: FleetQueryState,
  available: FleetFacetAvailability,
): ParsedFleetQuery {
  const state = canonicalizeFleetQuery(current)
  const notices: FleetQueryNotice[] = []
  const projects = reconcileNamespaced(state.projects, available.projects, "project", notices)
  const clusters = reconcileNamespaced(state.clusters, available.clusters, "cluster", notices)
  const stages = reconcileValues(state.stages, available.stages, "stage", notices)
  const namespaces = reconcileValues(state.namespaces, available.namespaces, "namespace", notices)
  const health = reconcileValues(state.health, available.health, "health", notices)
  const sync = reconcileValues(state.sync, available.sync, "sync", notices)
  const release = reconcileValues(state.release, available.release, "release", notices)
  const rollout = reconcileValues(state.rollout, available.rollout, "rollout", notices)
  const sources = reconcileValues(state.sources, available.sources, "source", notices)
  return {
    state: { ...state, projects, clusters, stages, namespaces, health, sync, release, rollout, sources },
    notices,
  }
}

function defaultFleetQuery(): FleetQueryState {
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
  }
}

function canonicalizeFleetQuery(input: FleetQueryState): FleetQueryState {
  const defaults = defaultFleetQuery()
  return {
    projects: canonicalNamespaced(input.projects),
    clusters: canonicalNamespaced(input.clusters),
    stages: canonicalStrings(input.stages),
    namespaces: canonicalStrings(input.namespaces),
    health: canonicalEnums(input.health, FLEET_HEALTH_VALUES),
    sync: canonicalEnums(input.sync, FLEET_SYNC_VALUES),
    release: canonicalEnums(input.release, FLEET_RELEASE_VALUES),
    rollout: canonicalEnums(input.rollout, FLEET_ROLLOUT_VALUES),
    sources: canonicalEnums(input.sources, FLEET_SOURCE_VALUES),
    q: input.q.trim(),
    sort: oneOf(input.sort, FLEET_SORT_VALUES) ? input.sort : defaults.sort,
    direction: oneOf(input.direction, FLEET_DIRECTION_VALUES) ? input.direction : defaults.direction,
    view: oneOf(input.view, FLEET_VIEW_VALUES) ? input.view : defaults.view,
    group: oneOf(input.group, FLEET_GROUP_VALUES) ? input.group : defaults.group,
    rows: oneOf(input.rows, FLEET_GROUP_VALUES) ? input.rows : defaults.rows,
    columns: oneOf(input.columns, FLEET_GROUP_VALUES) ? input.columns : defaults.columns,
    size: oneOf(input.size, FLEET_SIZE_VALUES) ? input.size : defaults.size,
    zoom: input.zoom.trim(),
    selected: input.selected && validNamespacedKey(input.selected) ? { ...input.selected } : null,
    range: oneOf(input.range, FLEET_RANGE_VALUES) ? input.range : defaults.range,
  }
}

function parseNamespacedValues(
  parameters: QueryParameters,
  field: "project" | "cluster",
  notices: FleetQueryNotice[],
): NamespacedKey[] {
  const values: NamespacedKey[] = []
  for (const rawValue of parameters.getAll(field)) {
    const value = rawValue.trim()
    const parsed = parseNamespacedKey(value)
    if (parsed) values.push(parsed)
    else notices.push(invalidNotice(field, value))
  }
  return canonicalNamespaced(values)
}

function parseStringValues(
  parameters: QueryParameters,
  field: "stage" | "namespace",
  notices: FleetQueryNotice[],
): string[] {
  const values: string[] = []
  for (const rawValue of parameters.getAll(field)) {
    const value = rawValue.trim()
    if (value) values.push(value)
    else notices.push(invalidNotice(field, value))
  }
  return canonicalStrings(values)
}

function parseEnumValues<const T extends readonly string[]>(
  parameters: QueryParameters,
  field: "health" | "sync" | "release" | "rollout" | "source",
  allowed: T,
  notices: FleetQueryNotice[],
): T[number][] {
  const values: T[number][] = []
  for (const rawValue of parameters.getAll(field)) {
    const value = rawValue.trim()
    if (oneOf(value, allowed)) values.push(value)
    else notices.push(invalidNotice(field, value))
  }
  return canonicalEnums(values, allowed)
}

function parseScalarEnum<const T extends readonly string[]>(
  parameters: QueryParameters,
  field: Extract<FleetQueryField, "sort" | "direction" | "view" | "group" | "rows" | "columns" | "size" | "range">,
  allowed: T,
  fallback: T[number],
  notices: FleetQueryNotice[],
): T[number] {
  let result = fallback
  for (const rawValue of parameters.getAll(field)) {
    const value = rawValue.trim()
    if (oneOf(value, allowed)) result = value
    else notices.push(invalidNotice(field, value))
  }
  return result
}

function parseSelected(parameters: QueryParameters, notices: FleetQueryNotice[]): NamespacedKey | null {
  let selected: NamespacedKey | null = null
  for (const rawValue of parameters.getAll("selected")) {
    const value = rawValue.trim()
    const parsed = parseNamespacedKey(value)
    if (parsed) selected = parsed
    else notices.push(invalidNotice("selected", value))
  }
  return selected
}

function parseNamespacedKey(value: string): NamespacedKey | null {
  const parts = value.split("/")
  if (parts.length !== 2) return null
  const [namespace, name] = parts
  const key = { namespace, name }
  return validNamespacedKey(key) ? key : null
}

function validNamespacedKey(value: NamespacedKey): boolean {
  return (
    value.namespace.length > 0 &&
    value.namespace.length <= 63 &&
    dnsLabel.test(value.namespace) &&
    value.name.length > 0 &&
    value.name.length <= 253 &&
    value.name.split(".").every((part) => part.length <= 63 && dnsLabel.test(part))
  )
}

function canonicalNamespaced(values: readonly NamespacedKey[]): NamespacedKey[] {
  const unique = new Map<string, NamespacedKey>()
  for (const value of values) {
    if (validNamespacedKey(value)) unique.set(namespacedKey(value), { ...value })
  }
  return [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value)
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
}

function canonicalEnums<const T extends readonly string[]>(values: readonly string[], allowed: T): T[number][] {
  return canonicalStrings(values).filter((value): value is T[number] => oneOf(value, allowed))
}

function oneOf<const T extends readonly string[]>(value: string, allowed: T): value is T[number] {
  return (allowed as readonly string[]).includes(value)
}

function lastTrimmed(parameters: QueryParameters, field: "q" | "zoom"): string {
  const values = parameters.getAll(field)
  return values.length === 0 ? "" : values.at(-1)!.trim()
}

function appendNamespaced(parameters: URLSearchParams, field: string, values: readonly NamespacedKey[]): void {
  for (const value of values) parameters.append(field, namespacedKey(value))
}

function appendValues(parameters: URLSearchParams, field: string, values: readonly string[]): void {
  for (const value of values) parameters.append(field, value)
}

function appendNonDefault(parameters: URLSearchParams, field: string, value: string, fallback: string): void {
  if (value !== fallback) parameters.set(field, value)
}

function namespacedKey(value: NamespacedKey): string {
  return `${value.namespace}/${value.name}`
}

function reconcileNamespaced(
  selected: NamespacedKey[],
  available: readonly NamespacedKey[] | undefined,
  field: "project" | "cluster",
  notices: FleetQueryNotice[],
): NamespacedKey[] {
  if (available === undefined) return selected
  const allowed = new Set(canonicalNamespaced(available).map(namespacedKey))
  return selected.filter((value) => {
    const key = namespacedKey(value)
    if (allowed.has(key)) return true
    notices.push(notAvailableNotice(field, key))
    return false
  })
}

function reconcileValues<T extends string>(
  selected: T[],
  available: readonly T[] | undefined,
  field: Extract<FleetQueryField, "stage" | "namespace" | "health" | "sync" | "release" | "rollout" | "source">,
  notices: FleetQueryNotice[],
): T[] {
  if (available === undefined) return selected
  const allowed = new Set(available)
  return selected.filter((value) => {
    if (allowed.has(value)) return true
    notices.push(notAvailableNotice(field, value))
    return false
  })
}

function invalidNotice(field: FleetQueryField, value: string): FleetQueryNotice {
  return {
    field,
    value,
    reason: "invalid",
    message: `Dropped invalid ${field} value “${value || "(empty)"}”.`,
  }
}

function notAvailableNotice(field: FleetQueryField, value: string): FleetQueryNotice {
  return {
    field,
    value,
    reason: "not_available",
    message: `Removed unavailable ${field} value “${value}”.`,
  }
}
