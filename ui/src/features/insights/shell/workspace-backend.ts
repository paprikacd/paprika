import { useMemo } from "react"
import type { InsightsClient } from "../client"
import type { Dashboard } from "../schema"
import { createExampleDashboardImportClient, saveExampleWorkspace, writeExampleWorkspace } from "../example-storage"
import { createExampleSavedQueryClient } from "../saved-query-storage"
import { dashboardUsesSavedQuery } from "../saved-queries"
import { documentFingerprint } from "../fingerprint"
import { variableValueScope } from "../variable-options"
import { MANUAL_REFRESH_BYPASS_MS } from "./constants"
import type { RepositoryWorkspace } from "./lazy-panels"

/**
 * Where the workspace reads and writes: the Insights service (live) or the example fixture and this browser's storage
 * (example). The shell asks the backend instead of branching on example mode, so the two kinds differ in one place.
 * `mode` still decides what renders while the workspace loads or is unavailable.
 */
export interface WorkspaceBackend {
  readonly kind: "live" | "example"
  /** The client the builders, panels and data loaders use. An example's reads its fixture's metadata and queries. */
  readonly client: InsightsClient
  /** The query the shared scheduler runs. A live query within the bypass window of a manual refresh skips the cache. */
  scheduledQuery(refreshedAt: number): InsightsClient["query"]
  /** The cache scope of variable values: example and live values never mix, nor do two principals' values. */
  variableScope(principal: string | undefined): string
  /** Throws for a values request this backend cannot filter. The example fixture has no selectors. */
  assertSelector(selector: string | undefined): void
  /** The saved-query client. An example's library lives in this browser, seeded with the queries its dashboards use. */
  savedQueries(currentDocument: () => Dashboard): InsightsClient
  /** The client a bundle import writes dashboards through. */
  importClient(library: InsightsClient): InsightsClient

  /** Loads a dashboard to open it. The example's stored copy is the one listed. */
  load(item: Dashboard): Promise<{ dashboard: Dashboard; etag?: string }>
  /**
   * Saves the open dashboard and returns its new ETag. An example refuses a save over a stored copy that changed
   * since it was opened (`saved` is the fingerprint it was opened with).
   */
  save(document: Dashboard, context: { saved: string; dashboards: Dashboard[]; etag?: string }): Promise<string | undefined>
  /** Records the dashboard just opened. An example remembers it as the active one in this browser. */
  opened(dashboards: Dashboard[], document: Dashboard): void
  /** Deletes a dashboard. `remaining` is the list without it. */
  remove(id: string, remaining: Dashboard[], etag?: string): Promise<void>
  /** The dashboard to open after the open one is deleted; none means a new draft. */
  afterDelete(remaining: Dashboard[]): Dashboard | undefined
  /** Writes a dashboard moved to another folder and returns its new ETag. */
  move(moved: Dashboard, dashboards: Dashboard[], activeId: string, etag?: string): Promise<string | undefined>
  /** Whether the workspace keeps revision history. Sample data keeps none; an older host serves no listing. */
  readonly revisions: boolean

  /** Example flags passed to views and links. */
  readonly example: boolean
  readonly copy: {
    /** The notice after a save. */
    readonly saved: string
    /** The canvas footer's note on where queries run. */
    readonly footer: string
    /** The topbar badge. */
    readonly badge: string
    /** The sidebar's workspace name. */
    readonly environment: string
    /** The sidebar's detail line under the workspace name. */
    environmentDetail(providers: number): string
  }
}

export function liveBackend(client: InsightsClient): WorkspaceBackend {
  return {
    kind: "live",
    client,
    scheduledQuery: (refreshedAt) => (request, signal) => client.query(request, signal, { replayCapacity: false, refresh: Date.now() - refreshedAt < MANUAL_REFRESH_BYPASS_MS }),
    variableScope: (principal) => variableValueScope(false, principal),
    assertSelector: () => {},
    savedQueries: () => client,
    importClient: (library) => library,
    load: (item) => client.get(item.id),
    save: (document, { etag }) => client.save(document, etag),
    opened: () => {},
    remove: (id, _remaining, etag) => client.remove(id, etag),
    afterDelete: () => undefined,
    move: (moved, _dashboards, _activeId, etag) => client.save(moved, etag),
    revisions: !!client.listRevisions,
    example: false,
    copy: {
      saved: "Dashboard saved.",
      footer: "Provider queries run server-side",
      badge: "Live providers",
      environment: "Connected workspace",
      environmentDetail: (providers) => `${providers} configured data sources`,
    },
  }
}

export function exampleBackend(client: InsightsClient, runtime: RepositoryWorkspace, storage: Storage | undefined): WorkspaceBackend {
  const fixture = { ...client, metadata: runtime.repositoryWorkspaceMetadata, query: runtime.repositoryWorkspaceQuery }
  return {
    kind: "example",
    client: fixture,
    scheduledQuery: () => runtime.repositoryWorkspaceQuery,
    variableScope: (principal) => variableValueScope(true, principal),
    assertSelector: (selector) => {
      if (selector !== undefined) throw new Error("Selector-filtered values are not available in examples")
    },
    savedQueries: (currentDocument) => {
      if (!storage) return client
      // A draft must not hide a dependency that still exists in saved storage.
      const currentDocuments = () => [...runtime.readRepositoryExampleWorkspace(storage).dashboards, currentDocument()]
      return { ...client, ...createExampleSavedQueryClient(storage, currentDocuments, runtime.repositoryWorkspaceQueries.filter(query => currentDocuments().some(document => dashboardUsesSavedQuery(document, query.id)))), metadata: runtime.repositoryWorkspaceMetadata, query: runtime.repositoryWorkspaceQuery }
    },
    importClient: (library) => ({ ...library, ...createExampleDashboardImportClient(localStorage) }),
    load: async (item) => ({ dashboard: item, etag: undefined }),
    save: async (document, { saved, dashboards }) => {
      const persisted = runtime.readRepositoryExampleWorkspace(localStorage).dashboards.find(item => item.id === document.id)
      if (persisted && documentFingerprint(persisted) !== saved)
        throw new Error("The saved dashboard changed. Open another dashboard and return to review it before saving, or duplicate your draft to keep these edits.")
      saveExampleWorkspace(localStorage, dashboards, document)
      return undefined
    },
    opened: (dashboards, document) => saveExampleWorkspace(localStorage, dashboards, document),
    remove: async (_id, remaining) => writeExampleWorkspace(localStorage, remaining, remaining[0]?.id ?? ""),
    afterDelete: (remaining) => remaining[0],
    move: async (moved, dashboards, activeId) => {
      writeExampleWorkspace(localStorage, dashboards.map((item) => (item.id === moved.id ? moved : item)), activeId)
      return undefined
    },
    revisions: false,
    example: true,
    copy: {
      saved: "Example saved in this browser.",
      footer: "Generated sample data",
      badge: "Sample data",
      environment: "Example workspace",
      environmentDetail: () => "Sample data · stored locally",
    },
  }
}

/** The workspace's backend, rebuilt only when the client or the example runtime changes. */
export function useWorkspaceBackend(client: InsightsClient, activeExample: RepositoryWorkspace | null) {
  const backend = useMemo(
    () => activeExample ? exampleBackend(client, activeExample, typeof window === "undefined" ? undefined : localStorage) : liveBackend(client),
    [client, activeExample],
  )
  return [backend] as const
}
