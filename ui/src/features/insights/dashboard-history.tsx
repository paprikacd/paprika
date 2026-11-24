import { History, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { RevisionSource, type DashboardRevision, type DashboardRevisionList } from "@/gen/paprika/insights/v1/revisions_pb"
import { InsightsHTTPError, type InsightsClient } from "./client"
import { GammaButton } from "./gamma/button"
import shared from "./insights.module.css"
import type { Dashboard, SavedQueryEntry } from "./schema"

export type HistoryClient = Pick<InsightsClient, "listRevisions" | "getRevision" | "restoreRevision">

export interface DashboardHistoryProps {
  /** The saved dashboard on the canvas. Previews are compared with it. */
  dashboard: Dashboard
  client: HistoryClient
  /** False while the canvas holds edits that a restore would replace, or a save is running. */
  canRestore: boolean
  /** Changes when the saved document changes, so the list is read again. */
  refreshKey: string
  /** The canvas now shows the restored document, with its ETag. */
  onRestored: (dashboard: Dashboard, etag: string | undefined) => void
  onClose: () => void
  /** The workspace's saved queries, so drifted queries are named rather than shown by ID. */
  savedQueries?: readonly Pick<SavedQueryEntry, "id" | "name">[]
}

interface Preview {
  number: number
  status: "loading" | "ready" | "error"
  dashboard?: Dashboard
  etag?: string
}

/** How a restore would change the canvas: widgets by ID, plus the title. Only the selected revision is read. */
export interface RevisionChanges {
  titleFrom?: string
  titleTo?: string
  added: string[]
  removed: string[]
  changed: string[]
}

export function revisionChanges(current: Dashboard, revision: Dashboard): RevisionChanges {
  const now = new Map(current.widgets.map(widget => [widget.id, JSON.stringify(widget)]))
  const then = new Map(revision.widgets.map(widget => [widget.id, JSON.stringify(widget)]))
  const titleChanged = current.title !== revision.title
  return {
    ...(titleChanged ? { titleFrom: current.title, titleTo: revision.title } : {}),
    added: revision.widgets.filter(widget => !now.has(widget.id)).map(widget => widget.title),
    removed: current.widgets.filter(widget => !then.has(widget.id)).map(widget => widget.title),
    changed: revision.widgets.filter(widget => now.has(widget.id) && now.get(widget.id) !== then.get(widget.id)).map(widget => widget.title),
  }
}

const sourceLabel = (revision: DashboardRevision) => {
  switch (revision.source) {
    case RevisionSource.UI: return "Saved in Insights"
    case RevisionSource.MCP: return "Saved through MCP"
    case RevisionSource.RESTORE: return `Restored from revision ${revision.restoredFrom}`
    case RevisionSource.BASELINE: return "Earliest saved version"
    default: return "Saved"
  }
}

const authorLabel = (revision: DashboardRevision) =>
  revision.author?.name || revision.author?.subject || (revision.source === RevisionSource.BASELINE ? "Unknown" : "Unknown author")

const whenLabel = (revision: DashboardRevision) => {
  const at = new Date(Number(revision.createdAtUnixMs))
  return Number.isNaN(at.getTime()) ? "Unknown time" : at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

// What a failed restore means to the user. A read-only account reads the history but is refused the write; the proxy
// sends no permission signal, so the refusal is the first place the panel learns it.
function restoreFailure(error: unknown, number: number) {
  if (error instanceof InsightsHTTPError && error.status === 403)
    return "Your account can view this dashboard but not change it, so nothing was restored. Ask an administrator for Insights write access."
  if (error instanceof InsightsHTTPError && error.status === 404)
    return `Revision ${number} is no longer kept, so nothing was restored. The history is reloaded.`
  return error instanceof Error ? error.message : "Could not restore this revision."
}

// A dashboard that was never saved has no history yet; the server answers 404 for it.
function listFailure(error: unknown) {
  if (error instanceof InsightsHTTPError && error.status === 404) return "This dashboard has not been saved yet. Its history starts with the first save."
  return error instanceof Error ? error.message : "Could not load the history."
}

/** The saved queries a restore left as they are now, named where the workspace knows them. */
function driftSentence(revision: DashboardRevision, names: ReadonlyMap<string, string>) {
  const drifted = revision.driftedSavedQueries
  if (revision.source !== RevisionSource.RESTORE || drifted.length === 0) return ""
  const listed = drifted.map(pin => names.get(pin.id) ?? pin.id).join(", ")
  const noun = drifted.length === 1 ? "saved query" : "saved queries"
  return `Saved queries are not restored. ${drifted.length} ${noun} changed since revision ${revision.restoredFrom}: ${listed}.`
}

function changeSentence(changes: RevisionChanges) {
  const parts = [
    changes.added.length && `add ${changes.added.length} ${changes.added.length === 1 ? "widget" : "widgets"}`,
    changes.removed.length && `remove ${changes.removed.length}`,
    changes.changed.length && `change ${changes.changed.length}`,
  ].filter(Boolean)
  return parts.length ? `Restoring would ${parts.join(", ")}.` : "This matches the dashboard on the canvas."
}

/**
 * Revision history for the open dashboard. Lists the retained revisions newest first, previews one read-only against the
 * canvas, and restores it as a new revision. A restore is a conditional write: it sends the list's current ETag, and a
 * stale one is refused, so the list is read again and the user is told.
 */
export function DashboardHistory({ dashboard, client, canRestore, refreshKey, onRestored, onClose, savedQueries }: DashboardHistoryProps) {
  const [list, setList] = useState<DashboardRevisionList>()
  const [loadError, setLoadError] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const [preview, setPreview] = useState<Preview>()
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [notice, setNotice] = useState("")
  const [restoreError, setRestoreError] = useState("")
  // The revision the last restore created. Its drifted saved queries are read from the reloaded list.
  const [restoredHead, setRestoredHead] = useState<number>()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const listRequest = useRef<AbortController>(undefined)
  const previewRequest = useRef<AbortController>(undefined)
  const dashboardId = dashboard.id
  const { listRevisions } = client

  const loadList = useCallback(async () => {
    listRequest.current?.abort()
    if (!listRevisions) return
    const controller = new AbortController()
    listRequest.current = controller
    try {
      const next = await listRevisions(dashboardId, controller.signal)
      if (controller.signal.aborted) return
      setList(next)
      setLoadError(undefined)
    } catch (error) {
      if (controller.signal.aborted) return
      setLoadError(listFailure(error))
    } finally {
      if (!controller.signal.aborted) setLoaded(true)
    }
  }, [listRevisions, dashboardId])

  const unavailable = !listRevisions
  // The list is read when the panel opens and again when the saved document changes. A stale list is never restored from:
  // the ETag it carries is only used for the restore it was read for.
  useEffect(() => {
    if (!listRevisions) return
    const controller = new AbortController()
    listRequest.current?.abort()
    listRequest.current = controller
    listRevisions(dashboardId, controller.signal).then(next => {
      if (controller.signal.aborted) return
      setList(next)
      setLoadError(undefined)
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      setLoadError(listFailure(error))
    }).finally(() => {
      if (!controller.signal.aborted) setLoaded(true)
    })
    return () => controller.abort()
  }, [listRevisions, dashboardId, refreshKey])

  useEffect(() => {
    if (confirming) cancelRef.current?.focus()
  }, [confirming])

  useEffect(() => () => previewRequest.current?.abort(), [])

  async function select(revision: DashboardRevision) {
    const number = revision.number
    setConfirming(false)
    setRestoreError("")
    setNotice("")
    setRestoredHead(undefined)
    if (!client.getRevision) return
    previewRequest.current?.abort()
    const controller = new AbortController()
    previewRequest.current = controller
    setPreview({ number, status: "loading" })
    try {
      const { dashboard: stored, etag } = await client.getRevision(dashboardId, number, controller.signal)
      if (controller.signal.aborted) return
      setPreview({ number, status: "ready", dashboard: stored, etag })
    } catch (error) {
      if (controller.signal.aborted) return
      setPreview({ number, status: "error" })
      setRestoreError(error instanceof Error ? error.message : "Could not open this revision.")
    }
  }

  const reloadAfterConflict = async () => {
    setConfirming(false)
    setPreview(undefined)
    await loadList()
  }

  async function restore(number: number) {
    // The confirm step can stay open while the canvas gains edits; a restore then would replace them.
    if (!client.restoreRevision || !list || !canRestore) return
    setRestoring(true)
    setRestoreError("")
    setNotice("")
    setRestoredHead(undefined)
    try {
      const result = await client.restoreRevision(dashboardId, number, list.currentEtag)
      setConfirming(false)
      setPreview(undefined)
      onRestored(result.dashboard, result.etag)
      setNotice(result.revision ? `Restored revision ${number} as revision ${result.revision}.` : `Restored revision ${number}.`)
      setRestoredHead(result.revision || undefined)
      await loadList()
    } catch (error) {
      if (error instanceof InsightsHTTPError && (error.status === 409 || error.status === 412)) {
        await reloadAfterConflict()
        setRestoreError("This dashboard changed on the server, so nothing was restored. The history is reloaded. Check it and restore again.")
      } else if (error instanceof InsightsHTTPError && error.status === 404) {
        await reloadAfterConflict()
        setRestoreError(restoreFailure(error, number))
      } else {
        setRestoreError(restoreFailure(error, number))
      }
    } finally {
      setRestoring(false)
    }
  }

  const revisions = list?.revisions ?? []
  const queryNames = new Map((savedQueries ?? []).map(query => [query.id, query.name]))
  const restoredRevision = restoredHead ? revisions.find(revision => revision.number === restoredHead) : undefined
  const restoredDrift = restoredRevision ? driftSentence(restoredRevision, queryNames) : ""
  const selectedRevision = preview ? revisions.find(revision => revision.number === preview.number) : undefined
  const isCurrent = !!selectedRevision && selectedRevision.etag === list?.currentEtag
  const changes = preview?.status === "ready" && preview.dashboard ? revisionChanges(dashboard, preview.dashboard) : undefined
  const changeCount = changes ? changes.added.length + changes.removed.length + changes.changed.length + (changes.titleTo !== undefined ? 1 : 0) : 0

  return (
    <section className={`${shared.inspector} flex min-h-0 flex-col gap-3`} aria-labelledby="dashboard-history-title" data-testid="dashboard-history">
      <div className={shared.panelHeading}>
        <h2 id="dashboard-history-title"><History size={18} aria-hidden="true" /> History</h2>
        <GammaButton iconOnly variant="quiet" size="sm" className={shared.iconButton} aria-label="Close history" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </GammaButton>
      </div>
      <p className="text-xs leading-relaxed text-[var(--gamma-muted)]">
        Each saved change keeps a revision. Pick one to preview it against the canvas, then restore it as a new revision.
      </p>

      {notice && <p role="status" className="rounded-md bg-[var(--gamma-success-soft)] px-3 py-2 text-xs text-[var(--gamma-ink)]">{notice}{restoredDrift && ` ${restoredDrift}`}</p>}
      {restoreError && <p role="alert" className="rounded-md bg-[var(--gamma-danger-soft)] px-3 py-2 text-xs text-[var(--gamma-status-critical-text)]">{restoreError}</p>}

      {unavailable && <p role="alert" className="text-sm text-[var(--gamma-status-critical-text)]">Revision history is not available on this server.</p>}

      {!unavailable && !loaded && <p role="status" className="text-sm text-[var(--gamma-muted)]">Loading history…</p>}

      {loaded && loadError && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-[var(--gamma-status-critical-text)]">{loadError}</p>
          <GammaButton size="sm" variant="secondary" onClick={() => { setLoaded(false); void loadList() }}>Try again</GammaButton>
        </div>
      )}

      {loaded && !loadError && list && revisions.length === 0 && (
        <p className="text-sm text-[var(--gamma-muted)]">No revisions yet. The next save creates the first one.</p>
      )}

      {loaded && !loadError && revisions.length > 0 && (
        <>
          <ol className="flex flex-col gap-1" aria-label="Revisions, newest first">
            {revisions.map(revision => {
              const current = revision.etag === list?.currentEtag
              const selected = preview?.number === revision.number
              return (
                <li key={revision.number}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-current={current ? "true" : undefined}
                    onClick={() => void select(revision)}
                    className={`flex w-full flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${selected ? "border-[var(--gamma-accent)] bg-[var(--gamma-accent-soft)]" : "border-[var(--gamma-border)] hover:bg-[var(--gamma-surface-2)]"}`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-medium text-[var(--gamma-ink)]">Revision {revision.number}{current && <span className="ml-2 text-xs font-normal text-[var(--gamma-muted)]">Current</span>}</span>
                      <span className="text-xs text-[var(--gamma-muted)]">{revision.widgetCount} {revision.widgetCount === 1 ? "widget" : "widgets"}</span>
                    </span>
                    <span className="text-xs text-[var(--gamma-muted)]">{whenLabel(revision)} · {authorLabel(revision)}</span>
                    <span className="text-xs text-[var(--gamma-muted)]">{sourceLabel(revision)}</span>
                    {revision.message && <span className="text-xs text-[var(--gamma-ink)]">{revision.message}</span>}
                    {driftSentence(revision, queryNames) && <span className="text-xs text-[var(--gamma-muted)]">{driftSentence(revision, queryNames)}</span>}
                  </button>
                </li>
              )
            })}
          </ol>

          {preview && selectedRevision && (
            <div className="flex flex-col gap-2 border-t border-[var(--gamma-border)] pt-3" aria-live="polite">
              <h3 className="text-sm font-medium text-[var(--gamma-ink)]">Preview of revision {preview.number}</h3>
              {preview.status === "loading" && <p role="status" className="text-sm text-[var(--gamma-muted)]">Loading revision…</p>}
              {preview.status === "error" && <p className="text-sm text-[var(--gamma-status-critical-text)]">This revision could not be read.</p>}
              {changes && preview.dashboard && (
                <>
                  <p className="text-sm text-[var(--gamma-muted)]">
                    {isCurrent ? "This is the current revision." : changeSentence(changes)}
                  </p>
                  {changes.titleTo !== undefined && (
                    <p className="text-xs text-[var(--gamma-muted)]">Title: {changes.titleFrom} → {changes.titleTo}</p>
                  )}
                  {changeCount > 0 && (
                    <ul className="flex flex-col gap-0.5 text-xs text-[var(--gamma-ink)]" aria-label="Widget changes">
                      {changes.added.map(title => <li key={`add-${title}`}>Added: {title}</li>)}
                      {changes.removed.map(title => <li key={`remove-${title}`}>Removed: {title}</li>)}
                      {changes.changed.map(title => <li key={`change-${title}`}>Changed: {title}</li>)}
                    </ul>
                  )}
                  <p className="text-xs text-[var(--gamma-muted)]">
                    Revision {preview.number} has {preview.dashboard.widgets.length} {preview.dashboard.widgets.length === 1 ? "widget" : "widgets"}.
                  </p>
                </>
              )}

              {!isCurrent && preview.status === "ready" && !confirming && (
                <>
                  <GammaButton
                    variant="primary"
                    size="sm"
                    disabled={!canRestore || restoring}
                    onClick={() => setConfirming(true)}
                    aria-describedby={!canRestore ? "dashboard-history-restore-hint" : undefined}
                  >
                    Restore revision {preview.number}
                  </GammaButton>
                  {!canRestore && (
                    <p id="dashboard-history-restore-hint" className="text-xs text-[var(--gamma-muted)]">
                      Save or discard your edits on the canvas before restoring.
                    </p>
                  )}
                </>
              )}

              {confirming && (
                <div role="group" aria-label="Confirm restore" className="flex flex-col gap-2 rounded-md border border-[var(--gamma-border)] p-3">
                  <p className="text-sm text-[var(--gamma-ink)]">
                    Restore revision {preview.number}? It becomes a new revision at the top of the list. Your current revision stays in the history.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <GammaButton variant="primary" size="sm" disabled={restoring || !canRestore} aria-describedby={!canRestore ? "dashboard-history-confirm-hint" : undefined} onClick={() => void restore(preview.number)}>
                      {restoring ? "Restoring…" : `Restore revision ${preview.number}`}
                    </GammaButton>
                    <GammaButton ref={cancelRef} variant="secondary" size="sm" disabled={restoring} onClick={() => setConfirming(false)}>
                      Cancel
                    </GammaButton>
                  </div>
                  {!canRestore && (
                    <p id="dashboard-history-confirm-hint" className="text-xs text-[var(--gamma-muted)]">
                      Save or discard your edits on the canvas before restoring.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
