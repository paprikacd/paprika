import {
  DEFAULT_FLEET_QUERY,
  parseFleetQuery,
  serializeFleetQuery,
  type NamespacedKey,
} from "@/lib/fleet-query"

export const RELEASE_PAGE_SIZE = 24
export const RELEASE_MAX_OFFSET = 1_000_000

const RELEASE_MAX_PAGE = Math.floor(RELEASE_MAX_OFFSET / RELEASE_PAGE_SIZE) + 1
const SCOPE_PARAMETERS = ["project", "cluster", "stage", "namespace"] as const

export interface ReleaseQueryState {
  projects: NamespacedKey[]
  clusters: NamespacedKey[]
  stages: string[]
  namespaces: string[]
  q: string
  page: number
}

export type ReleaseQueryPatch = Partial<ReleaseQueryState>

export interface ParsedReleaseQuery {
  state: ReleaseQueryState
  needsCanonicalReplace: boolean
}

interface QueryParameters {
  get(name: string): string | null
  getAll(name: string): string[]
  toString(): string
}

type ReleaseQueryInput = string | QueryParameters | ReleaseQueryState

export function parseReleaseQuery(input: string | QueryParameters): ParsedReleaseQuery {
  const parameters = copyQueryParameters(input)
  const fleet = parseFleetQuery(parameters).state
  const state = canonicalizeReleaseQuery({
    projects: fleet.projects,
    clusters: fleet.clusters,
    stages: fleet.stages,
    namespaces: fleet.namespaces,
    q: fleet.q,
    page: parsePage(parameters),
  })

  return {
    state,
    needsCanonicalReplace: parameters.toString() !== serializeReleaseQuery(state).toString(),
  }
}

export function serializeReleaseQuery(input: ReleaseQueryState): URLSearchParams {
  const state = canonicalizeReleaseQuery(input)
  const parameters = new URLSearchParams()
  copyScopeParameters(state, parameters)
  if (state.q) parameters.set("q", state.q)
  if (state.page !== 1) parameters.set("page", String(state.page))
  return parameters
}

export function mergeReleaseQuery(
  current: ReleaseQueryState,
  patch: ReleaseQueryPatch,
): ReleaseQueryState {
  const state = canonicalizeReleaseQuery(current)
  const q = (patch.q ?? state.q).trim()
  const qChanged = Object.prototype.hasOwnProperty.call(patch, "q") && q !== state.q

  return canonicalizeReleaseQuery({
    ...state,
    ...patch,
    q,
    page: qChanged ? 1 : (patch.page ?? state.page),
  })
}

export function releaseURL(current: ReleaseQueryInput, patch: ReleaseQueryPatch = {}): string {
  const state = mergeReleaseQuery(releaseQueryState(current), patch)
  const query = serializeReleaseQuery(state).toString()
  return query ? `/dashboard/releases?${query}` : "/dashboard/releases"
}

export function applicationURL(current: ReleaseQueryInput, identity: NamespacedKey): string {
  return detailURL("/dashboard/application", current, "application", identity)
}

export function rolloutURL(current: ReleaseQueryInput, identity: NamespacedKey): string {
  return detailURL("/dashboard/rollouts/detail", current, "rollout", identity)
}

function canonicalizeReleaseQuery(input: ReleaseQueryState): ReleaseQueryState {
  const scope = new URLSearchParams()
  copyScopeParameters(input, scope)
  const fleet = parseFleetQuery(scope).state

  return {
    projects: fleet.projects,
    clusters: fleet.clusters,
    stages: fleet.stages,
    namespaces: fleet.namespaces,
    q: input.q.trim(),
    page: validPage(input.page) ? input.page : 1,
  }
}

function releaseQueryState(input: ReleaseQueryInput): ReleaseQueryState {
  return isReleaseQueryState(input)
    ? canonicalizeReleaseQuery(input)
    : parseReleaseQuery(input).state
}

function isReleaseQueryState(input: ReleaseQueryInput): input is ReleaseQueryState {
  return typeof input !== "string" && "projects" in input
}

function parsePage(parameters: QueryParameters): number {
  const values = parameters.getAll("page")
  if (values.length === 0) return 1
  const value = values.at(-1)!
  if (!/^[1-9]\d*$/.test(value)) return 1
  const page = Number(value)
  return validPage(page) ? page : 1
}

function validPage(page: number): boolean {
  return Number.isSafeInteger(page) && page >= 1 && page <= RELEASE_MAX_PAGE
}

function copyQueryParameters(input: string | QueryParameters): URLSearchParams {
  return new URLSearchParams(typeof input === "string" ? input : input.toString())
}

function copyScopeParameters(
  scope: Pick<ReleaseQueryState, "projects" | "clusters" | "stages" | "namespaces">,
  target: URLSearchParams,
): void {
  const canonical = serializeFleetQuery({
    ...DEFAULT_FLEET_QUERY,
    projects: scope.projects,
    clusters: scope.clusters,
    stages: scope.stages,
    namespaces: scope.namespaces,
  })

  for (const parameter of SCOPE_PARAMETERS) {
    for (const value of canonical.getAll(parameter)) target.append(parameter, value)
  }
}

function detailURL(
  route: string,
  current: ReleaseQueryInput,
  identityPrefix: "application" | "rollout",
  identity: NamespacedKey,
): string {
  const state = releaseQueryState(current)
  const parameters = new URLSearchParams()
  copyScopeParameters(state, parameters)
  parameters.set(`${identityPrefix}_namespace`, identity.namespace)
  parameters.set(`${identityPrefix}_name`, identity.name)
  return `${route}?${parameters.toString()}`
}
