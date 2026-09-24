import type { NamespacedKey } from "@/lib/fleet-query"

export function applicationURL(identity: NamespacedKey, resource?: string): string {
  const params = new URLSearchParams({ namespace: identity.namespace, name: identity.name })
  // `resource` is the "Kind/name" key the resource tree uses — it deep-links
  // straight into that object's inspector.
  if (resource) params.set("resource", resource)
  return `/dashboard/application/?${params.toString()}`
}
