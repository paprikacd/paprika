"use client"

import { useId, useState } from "react"
import { Check, Copy, Sparkles, X } from "lucide-react"
import { copyToClipboard } from "@/lib/clipboard"
import { MAX_DOCUMENT_BYTES, parseDashboard, type Dashboard, type Provider } from "./schema"
import { buildAIContext, parseOpenUIDashboard, validateAIProviders } from "./openui"
import styles from "./ai.module.css"
import { GammaButton } from "./gamma/button"
import { GammaTextarea } from "./gamma/input"
import { useSavedQueryLibrary } from "./saved-query-context"

export { buildAIContext, dashboardToOpenUI, insightsLibrary, parseOpenUIDashboard } from "./openui"

interface AIBuilderProps {
  dashboard: Dashboard
  providers: Provider[]
  onApply: (dashboard: Dashboard) => void
  onClose: () => void
}

export function AIBuilder({ dashboard, providers, onApply, onClose }: AIBuilderProps) {
  const id = useId()
  const library = useSavedQueryLibrary()
  const [request, setRequest] = useState("")
  const [source, setSource] = useState("")
  const [format, setFormat] = useState<"openui" | "json" | "yaml">("openui")
  const [reviewed, setReviewed] = useState<{ document: Dashboard; base: string } | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const currentBase = JSON.stringify(dashboard)
  const isCurrent = reviewed?.base === currentBase
  const usesSaved = (document: Dashboard) => document.widgets.some(widget => widget.queryRef || widget.options?.tooltipView?.source?.type === "saved")
  const savedLibraryBlocked = !!(library.loading || library.error)
  function ensureLibrary(document: Dashboard) {
    if (usesSaved(document) && savedLibraryBlocked)
      throw new Error(library.loading ? "Saved queries are still loading. Review again when the library is ready." : `Saved queries could not be loaded: ${library.error}. Reload the query library before reviewing this definition.`)
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

  function review() {
    setReviewed(null)
    setError("")
    setNotice("")
    try {
      const document =
        format === "openui" ? parseOpenUIDashboard(source) : parseDashboard(source, format)
      ensureLibrary(document)
      validateAIProviders(document, providers, library.queries)
      if (document.id !== dashboard.id)
        throw new Error(
          `Keep the current dashboard id “${dashboard.id}” when editing this dashboard.`,
        )
      setReviewed({ document, base: currentBase })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The definition could not be validated.")
    }
  }

  function apply() {
    if (!reviewed || !isCurrent) return
    // Recheck provider capability in case configuration changed since review.
    try {
      ensureLibrary(reviewed.document)
      validateAIProviders(reviewed.document, providers, library.queries)
      onApply(reviewed.document)
      setReviewed(null)
      setNotice("Definition applied to your draft. Save the dashboard when ready.")
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The definition could not be applied.")
    }
  }

  const oldIds = new Set(dashboard.widgets.map((widget) => widget.id))
  const newIds = new Set(reviewed?.document.widgets.map((widget) => widget.id) ?? [])
  const added = reviewed?.document.widgets.filter((widget) => !oldIds.has(widget.id)).length ?? 0
  const removed = dashboard.widgets.filter((widget) => !newIds.has(widget.id)).length
  const changed =
    reviewed?.document.widgets.filter((widget) => {
      const before = dashboard.widgets.find((item) => item.id === widget.id)
      return before && JSON.stringify(before) !== JSON.stringify(widget)
    }).length ?? 0

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
            setSource(event.target.value)
            setReviewed(null)
            setError("")
            setNotice("")
          }}
          placeholder={
            format === "openui"
              ? "root = Dashboard(…)\nwidget0 = TimeSeries(…)"
              : `Paste a complete ${format.toUpperCase()} dashboard…`
          }
        />
        <GammaButton size="sm" variant="secondary"
          type="button"
          className={styles.secondary}
          onClick={review}
          disabled={!source.trim()}
        >
          Review definition
        </GammaButton>
        {reviewed && (
          <div className={styles.review} role="status">
            <div>
              <Check size={15} aria-hidden="true" />
              <strong>Definition valid · {reviewed.document.widgets.length} widgets</strong>
            </div>
            <p>
              {added} added · {changed} changed · {removed} removed
            </p>
            <p>
              {reviewed.document.title} · {reviewed.document.timeRange} window
            </p>
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
        <GammaButton size="sm" variant="primary"
          type="button"
          className={styles.primary}
          disabled={!reviewed || !isCurrent || (usesSaved(reviewed.document) && savedLibraryBlocked)}
          onClick={apply}
        >
          Apply to canvas
        </GammaButton>
        <p className={styles.hint}>
          Applying replaces the current draft. You can undo it before saving.
        </p>
      </section>
      <footer className={styles.footer}>
        Works with your preferred AI assistant. No model is connected here; copied context is only
        sent when you paste it into your assistant.
      </footer>
    </section>
  )
}
