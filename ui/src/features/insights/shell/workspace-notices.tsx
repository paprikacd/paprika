import { Suspense } from "react"
import { ArrowLeft, Check, X } from "lucide-react"
import styles from "../insights.module.css"
import { GammaButton } from "../gamma/button"
import { QueryInspector, ChecksList } from "./lazy-panels"
import { sourceBannerCopy } from "./source-catalog"
import type { Shell } from "./types"

export function renderWorkspaceNotices(
  backend: Shell["backend"],
  bannerRetry: Shell["bannerRetry"],
  busy: Shell["busy"],
  client: Shell["client"],
  dashboard: Shell["dashboard"],
  dashboards: Shell["dashboards"],
  error: Shell["error"],
  importingBundle: Shell["importingBundle"],
  inspectingQueries: Shell["inspectingQueries"],
  linkNotice: Shell["linkNotice"],
  message: Shell["message"],
  messageAction: Shell["messageAction"],
  openDashboard: Shell["openDashboard"],
  reloadRemoteDashboard: Shell["reloadRemoteDashboard"],
  remoteDashboard: Shell["remoteDashboard"],
  retrySources: Shell["retrySources"],
  returnTo: Shell["returnTo"],
  saveFindings: Shell["saveFindings"],
  scheduledFetcher: Shell["scheduledFetcher"],
  selectWidget: Shell["selectWidget"],
  setError: Shell["setError"],
  setInspectingQueries: Shell["setInspectingQueries"],
  setLinkNotice: Shell["setLinkNotice"],
  setMessage: Shell["setMessage"],
  setMessageAction: Shell["setMessageAction"],
  setReturnTo: Shell["setReturnTo"],
  sourceNoticeRef: Shell["sourceNoticeRef"],
  sources: Shell["sources"],
  syncError: Shell["syncError"],
) {
  return (
    <>
      {inspectingQueries && <Suspense fallback={<p role="status" className={styles.loading}>Loading query inspector…</p>}><QueryInspector store={scheduledFetcher.diagnostics} synthetic={backend.example} onClose={() => setInspectingQueries(false)} /></Suspense>}
      {returnTo ? (
        <div className={styles.viewContext}>
          <GammaButton size="sm" variant="quiet" onClick={async () => {
            const target = dashboards.find(item => item.id === returnTo.state.dashboardId)
            if (!target) { setError("The previous dashboard is no longer available."); return }
            if (await openDashboard(target, returnTo.state)) setReturnTo(null)
          }}><ArrowLeft size={14} /> Back to {returnTo.title}</GammaButton>
        </div>
      ) : null}
      {remoteDashboard?.id === dashboard.id && (
        <div className={styles.notice} role="status">
          <span>{remoteDashboard.removed
            ? "The saved dashboard was removed elsewhere. This view is preserved; duplicate it to keep a copy."
            : "The saved dashboard changed elsewhere. Your draft is preserved."}</span>
          {!remoteDashboard.removed && <GammaButton size="sm" variant="secondary" disabled={busy || importingBundle} onClick={reloadRemoteDashboard}>Load latest dashboard</GammaButton>}
        </div>
      )}
      {syncError && <p className={styles.notice} role="status">Workspace updates paused: {syncError} Retrying automatically.</p>}
      {/* One persistent live region for the source banner: it exists before its content changes. */}
      <div ref={sourceNoticeRef} role="status" tabIndex={-1} data-source-state={sources.status === "unavailable" ? sources.reason : sources.status} className={sources.status === "unavailable" ? styles.notice : undefined}>
        {sources.status === "unavailable" && (
          <>
            <span>{sourceBannerCopy(sources)}</span>
            {sources.reason === "signin" && client.signIn ? (
              <GammaButton size="sm" variant="secondary" onClick={() => client.signIn?.()}>Sign in again</GammaButton>
            ) : (
              <GammaButton ref={bannerRetry} size="sm" variant="secondary" onClick={retrySources}>Retry data sources</GammaButton>
            )}
          </>
        )}
      </div>
      {(error || message) && (
        <div
          className={`${styles.notice} ${error ? styles.errorNotice : ""}`}
          role={error ? "alert" : "status"}
        >
          {!error && <Check size={14} />}
          <span>{error || message}</span>
          {!error && messageAction?.text === message && (
            <GammaButton size="sm" variant="secondary" aria-label={messageAction.name} onClick={() => {
              const action = messageAction
              setMessageAction(undefined)
              action.run()
            }}>{messageAction.label}</GammaButton>
          )}
          <GammaButton iconOnly size="sm" variant="quiet"
            className={styles.iconButton}
            aria-label="Dismiss message"
            onClick={() => {
              setError("")
              setMessage("")
              setMessageAction(undefined)
            }}
          >
            <X size={14} />
          </GammaButton>
        </div>
      )}
      {saveFindings && error === saveFindings.message && (
        <Suspense fallback={null}><ChecksList label="Save checks" report={saveFindings.report} dashboard={dashboard} onFocusWidget={selectWidget} /></Suspense>
      )}
      {/* Always mounted, so a notice is announced when its content appears. */}
      <div role="status" data-link-notice>
        {linkNotice && (
          <div className={styles.notice}>
            <span>{linkNotice}</span>
            <GammaButton iconOnly size="sm" variant="quiet"
              className={styles.iconButton}
              aria-label="Dismiss link notice"
              onClick={() => setLinkNotice("")}
            >
              <X size={14} />
            </GammaButton>
          </div>
        )}
      </div>
    </>
  )
}
