import {
  mergeFleetQuery,
  serializeFleetQuery,
  type FleetQueryPatch,
  type FleetQueryState,
  type NamespacedKey,
} from "@/lib/fleet-query"

/**
 * Every link out of the overview keeps the operator's current scope. A reader
 * who has narrowed to one project and clicks "12 degraded" expects twelve
 * degraded applications in that project, not across the fleet.
 */
export function inventoryHref(
  state: FleetQueryState,
  patch: FleetQueryPatch = {}
): string {
  const query = serializeFleetQuery(mergeFleetQuery(state, patch)).toString()
  return query ? `/dashboard/applications/?${query}` : "/dashboard/applications/"
}

export function applicationHref(identity: NamespacedKey | undefined): string {
  if (!identity) return "/dashboard/applications/"
  return `/dashboard/application/?namespace=${encodeURIComponent(identity.namespace)}&name=${encodeURIComponent(identity.name)}`
}

export function rolloutHref(namespace: string, name: string): string {
  return `/dashboard/rollouts/detail/?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}`
}

export function diffHref(identity: NamespacedKey | undefined): string {
  if (!identity) return "/dashboard/diff/"
  return `/dashboard/diff/?namespace=${encodeURIComponent(identity.namespace)}&name=${encodeURIComponent(identity.name)}`
}

export function repositoryHref(repository: NamespacedKey | undefined): string {
  if (!repository) return "/dashboard/repositories/"
  return `/dashboard/repositories/?namespace=${encodeURIComponent(repository.namespace)}&name=${encodeURIComponent(repository.name)}`
}

export function keyOf(identity: NamespacedKey | undefined): string {
  return identity ? `${identity.namespace}/${identity.name}` : ""
}
