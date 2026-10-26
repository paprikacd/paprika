import type { InsightsClient } from "./client"
import { documentFingerprint } from "./fingerprint"
import { dashboardSchema, type Dashboard, type Provider, type SavedQuery, type SavedQueryEntry } from "./schema"
import {
  buildDashboardBundle, parseDashboardBundle, queryImportStatus,
  remapBundleQueryReferences, savedQueryFingerprint, selectBundleDashboards,
  serializeDashboardBundle, type DashboardBundle,
} from "./workspace-transfer"
import {
  remapImportBundle, savedQueryCompatibility,
  type ImportAction, type ImportBaseline, type ImportSnapshot,
} from "./import-review"

export interface BundleImportReview {
  dashboards: ImportSnapshot<Dashboard>[]
  queries: ImportSnapshot<SavedQuery>[]
}
export interface BundleImportRequest {
  sessionId: string
  bundle: DashboardBundle
  providerMapping: Record<string, string>
  /** New query definitions omit a choice and are conditionally created. */
  queryChoices: Record<string, ImportAction | "reuse">
  dashboardChoices?: Record<string, ImportAction>
  dashboardBaselines?: Record<string, ImportBaseline>
  queryBaselines?: Record<string, ImportBaseline>
}
export interface BundleImportResult {
  added: number
  /** All completed dashboard decisions, including Keep and Replace. */
  totalAdded: number
  failed: Dashboard[]
  errors: string[]
  queriesAdded: number
  queriesReused: number
  dashboardsKept: number
  dashboardsReplaced: number
  queriesReplaced: number
  /** Copy versus existing-ID destinations cannot change after a dashboard write attempt. */
  dashboardTargetsLocked?: boolean
  complete: boolean
}
type ImportClient = Pick<InsightsClient, "list" | "listSavedQueries" | "getSavedQuery" | "saveSavedQuery" | "save" | "get">
export interface BundleImportEnvironment {
  client: ImportClient
  providers: Provider[]
  dashboards: Dashboard[]
  onQueriesChange: (queries: SavedQueryEntry[]) => void
  onDashboardSaved: (dashboard: Dashboard, etag?: string) => void
}
interface ImportSession {
  source: string
  dashboardIds: Map<string, string>
  dashboardActions: Map<string, ImportAction>
  completed: Set<string>
  queryCopies: Map<string, string>
  attempted: Set<string>
  targetsLocked: boolean
}
function message(error: unknown) { return error instanceof Error ? error.message : "Import failed." }
function referencedQueries(dashboard: Dashboard): Set<string> {
  return new Set(dashboard.widgets.flatMap(widget => [
    ...(widget.queryRef ? [widget.queryRef.id] : []),
    ...(widget.options?.tooltipView?.source?.type === "saved" ? [widget.options.tooltipView.source.ref.id] : []),
  ]))
}
function checkBaseline(name: string, fingerprint: string, etag: string | undefined, baseline: ImportBaseline | undefined, replacing = false) {
  if (!baseline || baseline.fingerprint !== fingerprint || (baseline.etag !== undefined && baseline.etag !== etag))
    throw new Error(`${name} changed after review. Refresh the comparison and choose again.`)
  if (replacing && (!baseline.etag || !etag)) throw new Error(`${name} has no saved revision. Refresh the comparison before replacing it.`)
}
/** Review saved documents rather than the current, possibly unsaved canvas. */
export async function loadBundleImportReview(bundle: DashboardBundle, client: ImportClient): Promise<BundleImportReview> {
  const usesLibrary = bundle.dashboards.some(document => referencedQueries(document).size)
  const [documents, queries] = await Promise.all([client.list(), usesLibrary ? client.listSavedQueries() : Promise.resolve([])])
  const importedIds = new Set(bundle.dashboards.map(document => document.id))
  const dashboards = await Promise.all(documents.map(async document => {
    if (!importedIds.has(document.id)) return { document }
    const fresh = await client.get(document.id)
    return { document: fresh.dashboard, etag: fresh.etag }
  }))
  return { dashboards, queries: queries.map(({ etag, ...document }) => ({ document, etag })) }
}

/** Conditional writes with stable retry identities. Completed resources are never rolled back. */
export function createBundleImporter() {
  const sessions = new Map<string, ImportSession>()
  let running = false
  return async function importBundle(request: BundleImportRequest, environment: BundleImportEnvironment): Promise<BundleImportResult> {
    if (running) throw new Error("Wait for the current import to finish.")
    if (!request.sessionId || request.sessionId.length > 128) throw new Error("Review this import again before continuing.")
    const source = serializeDashboardBundle(request.bundle, "json")
    const original = parseDashboardBundle(source, "json")
    let session = sessions.get(request.sessionId)
    if (session && session.source !== source) throw new Error("The import document changed. Review it as a new import.")
    if (!session) {
      session = { source, dashboardIds: new Map(), dashboardActions: new Map(), completed: new Set(), queryCopies: new Map(), attempted: new Set(), targetsLocked: false }
      sessions.set(request.sessionId, session)
      while (sessions.size > 8) sessions.delete(sessions.keys().next().value!)
    }
    // Once a dashboard is written, its drilldown destinations cannot change on retry.
    for (const document of original.dashboards) {
      if (session.completed.has(document.id)) continue
      const action = request.dashboardChoices && Object.hasOwn(request.dashboardChoices, document.id) ? request.dashboardChoices[document.id] : "copy"
      if (!["keep", "replace", "copy"].includes(action)) throw new Error("Choose a valid dashboard import action.")
      const previous = session.dashboardActions.get(document.id)
      if (session.targetsLocked && previous && (previous === "copy") !== (action === "copy"))
        throw new Error("Dashboard destinations are fixed after a partial import. Keep the previous copy choice or start a new review.")
      if (!session.dashboardIds.has(document.id) || (previous === "copy") !== (action === "copy"))
        session.dashboardIds.set(document.id, action === "copy" ? `dashboard-${crypto.randomUUID()}` : document.id)
      session.dashboardActions.set(document.id, action)
    }
    const pending = original.dashboards.filter(document => !session!.completed.has(document.id))
    const result: BundleImportResult = { added: 0, totalAdded: session.completed.size, failed: pending, errors: [], queriesAdded: 0, queriesReused: 0, dashboardsKept: 0, dashboardsReplaced: 0, queriesReplaced: 0, complete: !pending.length }
    if (!pending.length) return result
    running = true
    try {
      const destinations = await environment.client.list()
      const newCount = pending.filter(document => session!.dashboardActions.get(document.id) === "copy" && !destinations.some(item => item.id === session!.dashboardIds.get(document.id))).length
      if (Math.max(destinations.length, environment.dashboards.length) + newCount > 100) throw new Error("The workspace supports up to 100 dashboards. Remove unused dashboards before importing.")
      // Fail a stale dashboard review before making any query changes.
      for (const document of pending) {
        const action = session.dashboardActions.get(document.id)!
        if (action === "copy") continue
        const fresh = await environment.client.get(document.id)
        const fingerprint = documentFingerprint(fresh.dashboard)
        const acknowledged = action === "replace" && session.attempted.has(`dashboard:${document.id}:${fingerprint}`)
        if (!acknowledged) checkBaseline(`Dashboard “${document.title}”`, fingerprint, fresh.etag, request.dashboardBaselines?.[document.id], action === "replace")
      }
      const active = pending.filter(document => session!.dashboardActions.get(document.id) !== "keep")
      if (active.length) {
        const selected = selectBundleDashboards(original, active.map(document => document.id))
        const usesLibrary = selected.dashboards.some(document => referencedQueries(document).size > 0)
        let current = usesLibrary ? await environment.client.listSavedQueries() : []
        const publish = (query: SavedQuery, etag?: string) => {
          current = [...current.filter(item => item.id !== query.id), { ...query, ...(etag ? { etag } : {}) }]
          environment.onQueriesChange(current)
        }
        if (usesLibrary) environment.onQueriesChange(current)
        const keptQueries = new Map<string, SavedQuery>()
        for (const query of selected.savedQueries ?? []) {
          if (request.queryChoices[query.id] !== "keep") continue
          const fresh = await environment.client.getSavedQuery(query.id)
          checkBaseline(`Saved query “${query.name}”`, savedQueryFingerprint(fresh.query), fresh.etag, request.queryBaselines?.[query.id])
          const compatibility = savedQueryCompatibility(fresh.query, selected.dashboards)
          if (!compatibility.compatible) throw new Error(compatibility.issues[0].reason)
          keptQueries.set(query.id, fresh.query)
        }
        const mapped = remapImportBundle(selected, request.providerMapping, environment.providers, keptQueries)
        const prepared = new Map<string, SavedQuery>()
        const queryTargets = Object.create(null) as Record<string, string>
        const queryErrors = new Map<string, string>()
        for (const query of mapped.savedQueries ?? []) {
          try {
            const action = Object.hasOwn(request.queryChoices, query.id) ? request.queryChoices[query.id] : undefined
            if (action !== undefined && !["copy", "reuse", "keep", "replace"].includes(action)) throw new Error("Choose a valid saved-query conflict action.")
            let target = query
            if (action === "copy") {
              const key = `${query.id}:${savedQueryFingerprint(query)}`
              let id = session.queryCopies.get(key)
              if (!id) { id = `query-${crypto.randomUUID()}`; session.queryCopies.set(key, id) }
              target = { ...query, id }
            }
            queryTargets[query.id] = target.id
            const targetFingerprint = savedQueryFingerprint(target)
            const receipt = `query:${target.id}:${targetFingerprint}`
            const status = queryImportStatus(target, current)
            if (action === "replace") {
              const fresh = await environment.client.getSavedQuery(target.id)
              if (session.attempted.has(receipt) && savedQueryFingerprint(fresh.query) === targetFingerprint) {
                publish(fresh.query, fresh.etag)
                result.queriesReused++
              } else {
                checkBaseline(`Saved query “${query.name}”`, savedQueryFingerprint(fresh.query), fresh.etag, request.queryBaselines?.[query.id], true)
                if (fresh.query.providerId !== target.providerId || fresh.query.kind !== target.kind) throw new Error("Create a copy to change a saved query’s data source or kind.")
                const compatibility = savedQueryCompatibility(target, destinations, fresh.query)
                if (!compatibility.compatible) throw new Error(compatibility.issues[0].reason)
                session.attempted.add(receipt)
                let etag: string | undefined
                try { etag = await environment.client.saveSavedQuery(target, fresh.etag) }
                catch (writeError) {
                  let confirmed: Awaited<ReturnType<InsightsClient["getSavedQuery"]>>
                  try { confirmed = await environment.client.getSavedQuery(target.id) } catch { throw writeError }
                  if (savedQueryFingerprint(confirmed.query) !== targetFingerprint) throw writeError
                  etag = confirmed.etag
                }
                publish(target, etag)
                result.queriesReplaced++
              }
            } else if (status === "identical") {
              const fresh = await environment.client.getSavedQuery(target.id)
              if (savedQueryFingerprint(fresh.query) !== targetFingerprint) throw new Error(`Saved query “${target.id}” changed after review. Refresh the query review.`)
              publish(fresh.query, fresh.etag)
              result.queriesReused++
            } else {
              if (status === "conflict") throw new Error(`Saved query “${query.id}” already exists with a different definition. Refresh the comparison and choose Keep, Replace, or Create a copy.`)
              if (action === "reuse" || action === "keep") throw new Error(`Saved query “${query.id}” is no longer available to keep. Refresh the comparison.`)
              let etag: string | undefined
              try { etag = await environment.client.saveSavedQuery(target) }
              catch (writeError) {
                let confirmed: Awaited<ReturnType<InsightsClient["getSavedQuery"]>>
                try { confirmed = await environment.client.getSavedQuery(target.id) } catch { throw writeError }
                if (savedQueryFingerprint(confirmed.query) !== targetFingerprint) throw writeError
                etag = confirmed.etag
              }
              publish(target, etag)
              result.queriesAdded++
            }
            prepared.set(target.id, target)
          } catch (error) {
            queryErrors.set(query.id, message(error))
            result.errors.push(`${query.name}: ${message(error)}`)
          }
        }
        for (const document of mapped.dashboards) {
          if ([...referencedQueries(document)].some(id => queryErrors.has(id))) continue
          try {
            const resolved = remapBundleQueryReferences(selectBundleDashboards(mapped, [document.id]), queryTargets).dashboards[0]
            const verified: SavedQuery[] = []
            for (const id of referencedQueries(resolved)) {
              const fresh = await environment.client.getSavedQuery(id)
              const expected = prepared.get(id) ?? current.find(query => query.id === id)
              if (!expected || savedQueryFingerprint(fresh.query) !== savedQueryFingerprint(expected)) throw new Error(`Saved query “${id}” changed during import. Refresh the comparison before retrying.`)
              if (!environment.providers.some(provider => provider.id === fresh.query.providerId && provider.capabilities.includes(fresh.query.kind))) throw new Error(`Choose a compatible data source for saved query “${fresh.query.name}”.`)
              verified.push(fresh.query)
            }
            buildDashboardBundle([resolved], verified)
            const target = dashboardSchema.parse({
              ...resolved, id: session.dashboardIds.get(document.id)!,
              widgets: resolved.widgets.map(widget => ({ ...widget, ...(widget.drilldowns ? {
                drilldowns: widget.drilldowns.map(link => ({ ...link, dashboardId: session!.dashboardIds.get(link.dashboardId) ?? link.dashboardId })),
              } : {}) })),
            })
            const fingerprint = documentFingerprint(target)
            const receipt = `dashboard:${target.id}:${fingerprint}`
            const action = session.dashboardActions.get(document.id)!
            let etag: string | undefined
            let confirmedBeforeWrite = false
            if (action === "replace") {
              const fresh = await environment.client.get(target.id)
              if (session.attempted.has(receipt) && documentFingerprint(fresh.dashboard) === fingerprint) {
                etag = fresh.etag
                confirmedBeforeWrite = true
              } else {
                checkBaseline(`Dashboard “${document.title}”`, documentFingerprint(fresh.dashboard), fresh.etag, request.dashboardBaselines?.[document.id], true)
                etag = fresh.etag
              }
            }
            if (!confirmedBeforeWrite) {
              session.attempted.add(receipt)
              // Even a lost acknowledgement can leave a saved drilldown behind.
              session.targetsLocked = true
              try { etag = await environment.client.save(target, etag) }
              catch (writeError) {
                let confirmed: Awaited<ReturnType<InsightsClient["get"]>>
                try { confirmed = await environment.client.get(target.id) } catch { throw writeError }
                if (documentFingerprint(confirmed.dashboard) !== fingerprint) throw writeError
                etag = confirmed.etag
              }
            }
            session.completed.add(document.id)
            if (action === "replace") result.dashboardsReplaced++
            else result.added++
            environment.onDashboardSaved(target, etag)
          } catch (error) { result.errors.push(`${document.title}: ${message(error)}`) }
        }
      }
      // Publish Keep receipts only with a returned result. A failed preflight
      // must not silently lock a decision that the review still shows editable.
      for (const document of pending) {
        if (session.dashboardActions.get(document.id) !== "keep") continue
        session.completed.add(document.id)
        result.dashboardsKept++
      }
      result.totalAdded = session.completed.size
      result.failed = original.dashboards.filter(document => !session!.completed.has(document.id))
      result.complete = !result.failed.length
      result.dashboardTargetsLocked = session.targetsLocked
      return result
    } finally { running = false }
  }
}
