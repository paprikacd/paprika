"use client"

import { useId, useMemo, useRef, useState } from "react"
import { Check, Copy, Sparkles, X } from "lucide-react"
import { parseDocument } from "yaml"
import { copyToClipboard } from "@/lib/clipboard"
import type { CheckReport } from "@/gen/paprika/insights/v1/checks_pb"
import { MAX_DOCUMENT_BYTES, dashboardSchema, parseDashboard, type Dashboard, type Provider } from "./schema"
import { buildAIContext, parseOpenUIDashboard, validateAIProviders } from "./openui"
import styles from "./ai.module.css"
import { GammaButton } from "./gamma/button"
import { GammaTextarea } from "./gamma/input"
import { useSavedQueryLibrary } from "./saved-query-context"
import { documentChangeSummary, documentChangeText } from "./document-change"
import { ChangeReview } from "./change-review"
import { applyDashboardPatch, documentChanges, readDashboardPatchSource, type DocumentChanges, type JSONObject, type Placement } from "./dashboard-patch"
import { dashboardAsSent } from "./layout-compaction"
import { ChecksList, CHECK_TIMEOUT_MS, errorCountText, hasErrors, withTimeout, type DocumentValidator } from "./checks-list"
import { buildAgentHandoff } from "./agent-handoff"
import { GammaDisclosure } from "./gamma/disclosure"

export { buildAIContext, dashboardToOpenUI, insightsLibrary, parseOpenUIDashboard } from "./openui"

export type ApplyMode = "document" | "edits"

interface AIBuilderProps {
  dashboard: Dashboard
  providers: Provider[]
  /** "document" replaces the draft with a whole dashboard; "edits" applies widget_edits to the current draft. */
  onApply: (dashboard: Dashboard, mode: ApplyMode) => void
  onClose: () => void
  /** Dry-run checks for a reviewed definition. Error findings block Apply; a failed check does not. */
  checkDocument?: DocumentValidator
  /** Focuses or scrolls to a widget on the canvas, for a finding's or change's "Show widget" action. */
  onFocusWidget?: (widgetId: string) => void
  /** The Observe MCP endpoint. Without it, the handoff omits the setup command. */
  observeEndpoint?: string
  /** The draft has changes that are not saved. The handoff then hands the agent the draft itself. */
  unsaved?: boolean
}

interface Reviewed {
  document: Dashboard
  base: string
  mode: ApplyMode
  placements: Placement[]
  changes: DocumentChanges | null
  report?: CheckReport
  checkFailed?: string
}

/** Parses JSON or YAML text the way the source editor does: strict keys, no aliases, size-bounded. */
function readSource(source: string, format: "json" | "yaml"): unknown {
  if (new TextEncoder().encode(source).byteLength > MAX_DOCUMENT_BYTES) throw new Error("Dashboard documents must be smaller than 256 KiB")
  if (format === "json") return JSON.parse(source)
  const document = parseDocument(source, { uniqueKeys: true, merge: false })
  if (document.errors.length) throw new Error(document.errors[0].message)
  return document.toJS({ maxAliasCount: 0 })
}

/** The dashboard as a save would write it, for comparing two drafts. Null when either side cannot be read. */
function changesBetween(before: Dashboard, after: Dashboard): DocumentChanges | null {
  try {
    return documentChanges(dashboardAsSent(before) as unknown as JSONObject, dashboardAsSent(after) as unknown as JSONObject)
  } catch {
    return null
  }
}

export function AIBuilder({ dashboard, providers, onApply, onClose, checkDocument, onFocusWidget, observeEndpoint, unsaved = false }: AIBuilderProps) {
  const id = useId()
  const library = useSavedQueryLibrary()
  const [request, setRequest] = useState("")
  const [source, setSource] = useState("")
  const [format, setFormat] = useState<"openui" | "json" | "yaml">("openui")
  const [reviewed, setReviewed] = useState<Reviewed | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  // Each edit of the source or format starts a new pass; a review that finishes after one is stale and dropped.
  const pass = useRef(0)
  const currentBase = JSON.stringify(dashboard)
  const isCurrent = reviewed?.base === currentBase
  const usesSaved = (document: Dashboard) => document.widgets.some(widget => widget.queryRef || widget.options?.tooltipView?.source?.type === "saved")
  const savedLibraryBlocked = !!(library.loading || library.error)
  const blockedByErrors = !!reviewed?.report && hasErrors(reviewed.report)
  function ensureLibrary(document: Dashboard) {
    if (usesSaved(document) && savedLibraryBlocked)
      throw new Error(library.loading ? "Saved queries are still loading. Review again when the library is ready." : `Saved queries could not be loaded: ${library.error}. Reload the query library before reviewing this definition.`)
  }

  const handoff = useMemo(
    () => buildAgentHandoff({ id: dashboard.id, title: dashboard.title, request, endpoint: observeEndpoint, draft: unsaved ? dashboard : undefined }),
    [dashboard, request, observeEndpoint, unsaved],
  )

  async function copyAgentText(text: string, success: string) {
    try {
      await copyToClipboard(text)
      setNotice(success)
      setError("")
    } catch {
      setError("The text could not be copied. Allow clipboard access and try again.")
    }
  }

  function copyInstructions() {
    // The agent's reply is a JSON object, so the review switches to JSON before the reply is pasted.
    pass.current++
    setFormat("json")
    setReviewed(null)
    void copyAgentText(handoff.text, "Instructions copied. Paste the agent’s JSON reply below.")
  }

  async function copyContext() {
    try {
      await copyToClipboard(buildAIContext(dashboard, providers, request, library.queries))
      setNotice("Prompt copied. Paste it into your preferred AI assistant.")
      setError("")
    } catch {
      setError("The prompt could not be copied. Allow clipboard access and try again.")
    }
  }

  /** Reads the source as a whole dashboard, or as widget_edits applied to the current draft. */
  function readReview(): { document: Dashboard; mode: ApplyMode; placements: Placement[] } {
    if (format === "openui") return { document: parseOpenUIDashboard(source), mode: "document", placements: [] }
    const patch = readDashboardPatchSource(readSource(source, format))
    if (!patch) return { document: parseDashboard(source, format), mode: "document", placements: [] }
    if (patch.id !== undefined && patch.id !== dashboard.id) throw new Error(`These edits are for dashboard “${patch.id}”.`)
    const applied = applyDashboardPatch(JSON.parse(currentBase), patch)
    if (applied.error) {
      const { error: failure } = applied
      if (failure.reason === "unchanged") throw new Error("These edits do not change the draft.")
      throw new Error(failure.editIndex !== undefined ? `Edit ${failure.editIndex + 1}: ${failure.message}` : failure.message)
    }
    return { document: dashboardSchema.parse(applied.document), mode: "edits", placements: applied.placements }
  }

  async function runChecks(document: Dashboard): Promise<Pick<Reviewed, "report" | "checkFailed">> {
    if (!checkDocument) return {}
    const controller = new AbortController()
    try {
      const report = await withTimeout(checkDocument(document, controller.signal), CHECK_TIMEOUT_MS, () => controller.abort())
      return { report }
    } catch (cause) {
      const failure = cause instanceof Error ? cause.message : "Could not check this dashboard."
      return { checkFailed: failure }
    }
  }

  async function review() {
    const current = ++pass.current
    setReviewed(null)
    setError("")
    setNotice("")
    let result: ReturnType<typeof readReview>
    try {
      result = readReview()
      ensureLibrary(result.document)
      validateAIProviders(result.document, providers, library.queries)
      if (result.document.id !== dashboard.id)
        throw new Error(`Keep the current dashboard id “${dashboard.id}” when editing this dashboard.`)
    } catch (cause) {
      if (current === pass.current) setError(cause instanceof Error ? cause.message : "The definition could not be validated.")
      return
    }
    const next: Reviewed = { ...result, base: currentBase, changes: changesBetween(dashboard, result.document) }
    if (!checkDocument) {
      setReviewed(next)
      return
    }
    const checked = await runChecks(result.document)
    if (current === pass.current) setReviewed({ ...next, ...checked })
  }

  function apply() {
    if (!reviewed || !isCurrent || blockedByErrors) return
    // Recheck provider capability in case configuration changed since review.
    try {
      ensureLibrary(reviewed.document)
      validateAIProviders(reviewed.document, providers, library.queries)
      onApply(reviewed.document, reviewed.mode)
      setReviewed(null)
      setNotice("Definition applied to your draft. Save the dashboard when ready.")
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The definition could not be applied.")
    }
  }

  const change = reviewed && reviewed.mode === "document" ? documentChangeSummary(dashboard, reviewed.document) : null
  const applyLabel = reviewed?.mode === "edits" ? "Apply edits to draft" : "Replace dashboard draft"

  return (
    <section className={styles.panel} aria-label="Build with AI">
      <div className={styles.heading}>
        <div>
          <Sparkles size={17} aria-hidden="true" />
          <h2>Build with AI</h2>
        </div>
        <GammaButton iconOnly size="sm" variant="quiet"
          type="button"
          className={styles.iconButton}
          onClick={onClose}
          aria-label="Close AI builder"
        >
          <X size={17} />
        </GammaButton>
      </div>
      <p className={styles.intro}>Describe the dashboard. Bring back a definition.</p>
      <section className={styles.step} aria-labelledby={`${id}-context`}>
        <h3 id={`${id}-context`}>
          <span>1</span> Copy dashboard context
        </h3>
        <label htmlFor={`${id}-request`}>What would you like to build?</label>
        <GammaTextarea
          id={`${id}-request`}
          value={request}
          maxLength={4000}
          rows={3}
          onChange={(event) => {
            setRequest(event.target.value)
            setNotice("")
          }}
          placeholder="Show request rate and p95 latency by service…"
        />
        <p className={styles.hint}>
          The prompt includes this dashboard, available providers, saved queries and typed parameters, and the allowed widget library.
        </p>
        <GammaButton size="sm" variant="secondary" type="button" className={styles.secondary} onClick={copyContext}>
          <Copy size={14} aria-hidden="true" />
          Copy AI prompt
        </GammaButton>
        {savedLibraryBlocked && <p className={styles.hint}>{library.loading ? "Saved queries are loading; wait before copying a prompt that needs them." : "The saved-query library is unavailable. Definitions using custom queries can still be reviewed."}</p>}
        <GammaDisclosure title="Use your agent with Paprika Observe">
          <div className="grid justify-items-start gap-2 p-1">
            <p className={styles.hint}>
              Your agent reads this dashboard through Observe and replies with widget edits. Review them here before they reach the draft.
            </p>
            <GammaButton size="sm" variant="secondary" type="button" className={styles.secondary} onClick={copyInstructions}>
              <Copy size={14} aria-hidden="true" />
              Copy agent instructions
            </GammaButton>
            {handoff.setupCommand && (
              <GammaButton size="sm" variant="secondary" type="button" className={styles.secondary} onClick={() => void copyAgentText(handoff.setupCommand!, "Setup command copied.")}>
                <Copy size={14} aria-hidden="true" />
                Copy setup command
              </GammaButton>
            )}
            {handoff.links.map((link) => (
              <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className="text-[13px] text-[color:var(--gamma-accent-text)] underline underline-offset-2">
                {link.label}
              </a>
            ))}
          </div>
        </GammaDisclosure>
      </section>
      <section className={styles.step} aria-labelledby={`${id}-definition`}>
        <h3 id={`${id}-definition`}>
          <span>2</span> Review a definition
        </h3>
        <div className={styles.formats} role="group" aria-label="AI definition format">
          {(["openui", "json", "yaml"] as const).map((item) => (
            <GammaButton size="sm" variant="quiet"
              type="button"
              key={item}
              aria-pressed={format === item}
              onClick={() => {
                pass.current++
                setFormat(item)
                setReviewed(null)
                setError("")
                setNotice("")
              }}
            >
              {item === "openui" ? "OpenUI" : item.toUpperCase()}
            </GammaButton>
          ))}
        </div>
        <label className={styles.sourceLabel} htmlFor={`${id}-source`}>
          AI-generated definition
        </label>
        <GammaTextarea
          id={`${id}-source`}
          className={styles.source}
          value={source}
          spellCheck={false}
          rows={11}
          maxLength={MAX_DOCUMENT_BYTES}
          onChange={(event) => {
            pass.current++
            setSource(event.target.value)
            setReviewed(null)
            setError("")
            setNotice("")
          }}
          placeholder={
            format === "openui"
              ? "root = Dashboard(…)\nwidget0 = TimeSeries(…)"
              : `Paste a ${format.toUpperCase()} dashboard or {"widget_edits":[…]}…`
          }
        />
        <GammaButton size="sm" variant="secondary"
          type="button"
          className={styles.secondary}
          onClick={() => void review()}
          disabled={!source.trim()}
        >
          Review definition
        </GammaButton>
        {reviewed && (
          <div className={styles.review} role="status">
            <div>
              <Check size={15} aria-hidden="true" />
              <strong>
                {reviewed.mode === "edits"
                  ? `Edits valid · ${reviewed.changes?.widgets.length ?? 0} widgets changed`
                  : `Definition valid · ${reviewed.document.widgets.length} widgets`}
              </strong>
            </div>
            {change && <p>{documentChangeText(change)}</p>}
            <p>
              {reviewed.document.title} · {reviewed.document.timeRange} window
            </p>
            {reviewed.checkFailed && (
              <p>
                Could not check this dashboard: {reviewed.checkFailed}. Applying to the canvas does not depend on the check.
              </p>
            )}
            {blockedByErrors && reviewed.report && <p>{errorCountText(reviewed.report)}. Fix them before applying.</p>}
            {!isCurrent && <p>The canvas changed. Review again before applying.</p>}
          </div>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
        {reviewed?.report && (
          <ChecksList label="Definition checks" report={reviewed.report} dashboard={reviewed.document} onFocusWidget={onFocusWidget} />
        )}
        {reviewed?.changes && <ChangeReview changes={reviewed.changes} onFocusWidget={onFocusWidget} />}
        <GammaButton size="sm" variant="primary"
          type="button"
          className={styles.primary}
          disabled={!reviewed || !isCurrent || blockedByErrors || (usesSaved(reviewed.document) && savedLibraryBlocked)}
          onClick={apply}
        >
          {applyLabel}
        </GammaButton>
        <p className={styles.hint}>
          Applying replaces the current draft. You can undo it before saving.
        </p>
      </section>
      <footer className={styles.footer}>
        Works with your preferred AI assistant. No model is connected here. Copied text and links are
        sent only when you paste or open them.
      </footer>
    </section>
  )
}
