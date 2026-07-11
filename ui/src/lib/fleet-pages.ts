import { Code, ConnectError } from "@connectrpc/connect"

import type {
  FleetApplicationSummary,
  FleetApplicationsPage,
} from "@/lib/fleet-client"

export interface FleetPageLoaderDependencies<TPage> {
  fetchPage: (cursor: string) => Promise<TPage>
  resetFleetPages: () => void | Promise<void>
}

export type FleetPageLoader<TPage> = (cursor?: string) => Promise<TPage>

export function mergeFleetApplicationPages(
  pages: readonly FleetApplicationsPage[],
): FleetApplicationSummary[] {
  const applications: FleetApplicationSummary[] = []
  const seenIdentities = new Set<string>()

  for (const page of pages) {
    for (const application of page.applications) {
      const identity = application.identity
      if (!identity) {
        applications.push(application)
        continue
      }

      const key = JSON.stringify([identity.namespace, identity.name])
      if (seenIdentities.has(key)) {
        continue
      }

      seenIdentities.add(key)
      applications.push(application)
    }
  }

  return applications
}

export function createFleetPageLoader<TPage>(
  dependencies: FleetPageLoaderDependencies<TPage>,
): FleetPageLoader<TPage> {
  const recoveredCursors = new Set<string>()

  return async (cursor = "") => {
    try {
      const page = await dependencies.fetchPage(cursor)
      recoveredCursors.delete(cursor)
      return page
    } catch (error) {
      const canRecover =
        cursor.length > 0 &&
        error instanceof ConnectError &&
        error.code === Code.InvalidArgument &&
        !recoveredCursors.has(cursor)

      if (!canRecover) {
        throw error
      }

      recoveredCursors.add(cursor)
    }

    try {
      await dependencies.resetFleetPages()
    } catch (error) {
      recoveredCursors.delete(cursor)
      throw error
    }
    return dependencies.fetchPage("")
  }
}
