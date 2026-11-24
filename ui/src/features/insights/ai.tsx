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
import { ChangeReview, draftChanges } from "./change-review"
import { applyDashboardPatch, readDashboardPatchSource, type DocumentChanges, type Placement } from "./dashboard-patch"
import { ChecksList, errorCountText, hasErrors, type DocumentValidator } from "./checks-list"
import { buildAgentHandoff } from "./agent-handoff"
import { GammaDisclosure } from "./gamma/disclosure"

export { buildAIContext, dashboardToOpenUI, insightsLibrary, parseOpenUIDashboard } from "./openui"

export type ApplyMode = "document" | "edits"

const widgetCountText = (count: number) => `${count} widget${count === 1 ? "" : "s"}`

// The same check bound and wording as the source editor's (document-editor.tsx). They are repeated here, in the
// lazy panel, because sharing them through an eager module grew the first view (scripts/check-insights-budget.mjs).
const CHECK_TIMEOUT_MS = 10_000
const checkFailureText = (reason: string) =>
  `Could not check this dashboard: ${reason.replace(/\.+$/, "")}. Applying to the canvas does not depend on the check.`

/** Settles with the check, or rejects after the limit, whether or not the check honours its signal. */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error(`The check did not finish within ${ms / 1000} seconds.`))
    }, ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

interface AIBuilderProps {
  dashboard: Dashboard
  providers: Provider[]
  /**
   * Replaces the draft with the reviewed dashboard: a whole pasted dashboard, or the current draft with widget_edits
   * applied. message is the host's confirmation, set for edits; without it the host says the draft was replaced.
   */
  onApply: (dashboard: Dashboard, message?: string) => void
  onClose: () => void
  /** Dry-run checks for a reviewed definition. Error findings block Apply; a failed check does not. */
  checkDocument?: DocumentValidator
  /** Focuses or scrolls to a widget on the canvas, for a finding's or change's "Show widget" action. */
  onFocusWidget?: (widgetId: string) => void
  /** The host serves Paprika Observe. The handoff then names its endpoint and offers the setup command. */
  observe?: boolean
  /** The Observe MCP endpoint, for tests and hosts on another origin. Defaults to this origin's /observe/mcp. */
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

export function AIBuilder({ dashboard, providers, onApply, onClose, checkDocument, onFocusWidget, observe = false, observeEndpoint, unsaved = false }: AIBuilderProps) {
  const id = useId()
  const library = useSavedQueryLibrary()
  const [request, setRequest] = useState("")
  const [source, setSource] = useState("")
  const [format, setFormat] = useState<"openui" | "json" | "yaml">("openui")
  const [reviewed, setReviewed] = useState<Reviewed | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [checking, setChecking] = useState(false)
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

  // The gateway routes /observe on the host root, like /api/insights, so the UI basePath does not apply. Only the
  // origin is used, so the page's path, query and fragment, which can carry sign-in state, never reach the text.
  const endpoint = observeEndpoint ?? (observe ? new URL("/observe/mcp", window.location.origin).href : undefined)
  const handoff = useMemo(
    () => buildAgentHandoff({ id: dashboard.id, title: dashboard.title, request, endpoint, draft: unsaved ? dashboard : undefined }),
    [dashboard, request, endpoint, unsaved],
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
    setChecking(false)
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
    // The merged draft is read with the same schema and messages as a pasted dashboard.
    const parsed = dashboardSchema.safeParse(applied.document)
    if (!parsed.success)
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".") || "dashboard"}: ${issue.message}`).join("\n"))
    return { document: parsed.data, mode: "edits", placements: applied.placements }
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
    setChecking(false)
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
    const next: Reviewed = { ...result, base: currentBase, changes: draftChanges(dashboard, result.document) }
    if (!checkDocument) {
      setReviewed(next)
      return
    }
    setChecking(true)
    const checked = await runChecks(result.document)
    if (current !== pass.current) return
    setChecking(false)
    setReviewed({ ...next, ...checked })
  }

  function apply() {
    if (!reviewed || !isCurrent || blockedByErrors) return
    // Recheck provider capability in case configuration changed since review.
    try {
      ensureLibrary(reviewed.document)
      validateAIProviders(reviewed.document, providers, library.queries)
      if (reviewed.mode === "edits") onApply(reviewed.document, "Edits applied to the draft. Review the canvas, then save the dashboard.")
      else onApply(reviewed.document)
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
                setChecking(false)
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
            setChecking(false)
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
                  ? `Edits valid · ${widgetCountText(reviewed.changes?.widgets.length ?? 0)} changed`
                  : `Definition valid · ${reviewed.document.widgets.length} widgets`}
              </strong>
            </div>
            {change && <p>{documentChangeText(change)}</p>}
            <p>
              {reviewed.document.title} · {reviewed.document.timeRange} window
            </p>
            {reviewed.checkFailed && (
              <p>
                {checkFailureText(reviewed.checkFailed)}
              </p>
            )}
            {blockedByErrors && reviewed.report && <p>{errorCountText(reviewed.report)}. Fix them before applying.</p>}
            {!isCurrent && <p>The canvas changed. Review again before applying.</p>}
          </div>
        )}
        {checking && (
          <p className={styles.hint} role="status">
            Checking definition…
          </p>
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
          {reviewed?.mode === "edits"
            ? "Applying changes only the widgets listed above. You can undo it before saving."
            : "Applying replaces the current draft. You can undo it before saving."}
        </p>
      </section>
      <footer className={styles.footer}>
        Works with your preferred AI assistant. No model is connected here. Copied text and links are
        sent only when you paste or open them.
      </footer>
    </section>
  )
}
