import type { NamespacedKey } from "@/lib/fleet-query"

export function applicationURL(identity: NamespacedKey): string {
  return `/dashboard/application/?${new URLSearchParams({ namespace: identity.namespace, name: identity.name }).toString()}`
}
