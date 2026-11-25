import { Suspense } from "react"
import { MAX_WIDGETS } from "../schema"
import { LazyFailure, LazyPanelBoundary, MountSignal } from "../lazy-panel"
import { WidgetLibrary } from "../widget-library"
import styles from "../insights.module.css"
import { DashboardHistory, DocumentEditor, ProviderManager, DashboardManager, AIBuilder, RepositoryGallery, StarterPicker } from "./lazy-panels"
import type { Shell } from "./types"

export function renderPanelRouter(
  acceptCatalog: Shell["acceptCatalog"],
  addWidget: Shell["addWidget"],
  applyDocument: Shell["applyDocument"],
  applyRestoredDocument: Shell["applyRestoredDocument"],
  backend: Shell["backend"],
  builderPanel: Shell["builderPanel"],
  busy: Shell["busy"],
  client: Shell["client"],
  close: Shell["close"],
  dashboard: Shell["dashboard"],
  dashboards: Shell["dashboards"],
  deleteDashboard: Shell["deleteDashboard"],
  dirty: Shell["dirty"],
  duplicateDashboard: Shell["duplicateDashboard"],
  endGroup: Shell["endGroup"],
  exploreProvider: Shell["exploreProvider"],
  importBundle: Shell["importBundle"],
  importingBundle: Shell["importingBundle"],
  markGalleryMounted: Shell["markGalleryMounted"],
  markManageMounted: Shell["markManageMounted"],
  markProvidersMounted: Shell["markProvidersMounted"],
  markSourceMounted: Shell["markSourceMounted"],
  openBuilderPanel: Shell["openBuilderPanel"],
  panel: Shell["panel"],
  providers: Shell["providers"],
  refreshCatalog: Shell["refreshCatalog"],
  refreshSavedQueries: Shell["refreshSavedQueries"],
  reviewBundle: Shell["reviewBundle"],
  saved: Shell["saved"],
  savedQueries: Shell["savedQueries"],
  selectWidget: Shell["selectWidget"],
  setEditing: Shell["setEditing"],
  setLibraryRevision: Shell["setLibraryRevision"],
  setQueryRevision: Shell["setQueryRevision"],
  setSourceRequest: Shell["setSourceRequest"],
  syncVariableDefinitions: Shell["syncVariableDefinitions"],
  unsupportedProviders: Shell["unsupportedProviders"],
  update: Shell["update"],
  variableCatalog: Shell["variableCatalog"],
  widePanel: Shell["widePanel"],
  widgetDraftDirty: Shell["widgetDraftDirty"],
  workspace: Shell["workspace"],
  workspaceFailed: Shell["workspaceFailed"],
) {
  return (
    <aside
      ref={builderPanel}
      tabIndex={-1}
      className={`${styles.panel} ${(panel === "source" || panel === "examples") && widePanel ? styles.widePanel : ""}`}
      aria-label="Builder panel"
    >
      {panel === "examples" && (workspaceFailed ? (
        <LazyFailure label="Dashboard examples" kind="load" unsaved={dirty || widgetDraftDirty} onClose={close} />
      ) : workspace ? (
        <LazyPanelBoundary label="Dashboard examples" unsaved={dirty || widgetDraftDirty} onClose={close}>
          <Suspense fallback={<p className={styles.loading} role="status">Loading examples…</p>}>
            <RepositoryGallery entries={workspace.repositoryExamples} mode={backend.kind} providers={providers} onImportBundle={importBundle} onReviewBundle={reviewBundle} validateDocument={client.validate} onRefreshQueries={refreshSavedQueries} onClose={close} />
            <MountSignal onMount={markGalleryMounted} />
          </Suspense>
        </LazyPanelBoundary>
      ) : <p className={styles.loading} role="status">Loading examples…</p>)}
      {panel === "starters" && client.listStarters && client.getStarter && (
        <LazyPanelBoundary label="Templates" unsaved={dirty || widgetDraftDirty} onClose={close}>
          <Suspense fallback={<p className={styles.loading} role="status">Loading templates…</p>}>
            <StarterPicker
              listStarters={client.listStarters}
              getStarter={client.getStarter}
              providers={providers}
              onImportBundle={importBundle}
              onReviewBundle={reviewBundle}
              validateDocument={client.validate}
              onRefreshQueries={refreshSavedQueries}
              onClose={close}
            />
          </Suspense>
        </LazyPanelBoundary>
      )}
      {panel === "source" && (
        <LazyPanelBoundary label="Dashboard source" unsaved={dirty || widgetDraftDirty} onClose={close}>
          <Suspense fallback={<p className={styles.loading} role="status">Loading dashboard source…</p>}>
            <DocumentEditor
              key={dashboard.id}
              dashboard={dashboard}
              providers={providers}
              onImportBundle={importBundle}
              onReviewBundle={reviewBundle}
              onRefreshQueries={refreshSavedQueries}
              checkDocument={client.validate}
              onFocusWidget={selectWidget}
              onApply={applyDocument}
              onClose={close}
            />
            <MountSignal onMount={markSourceMounted} />
          </Suspense>
        </LazyPanelBoundary>
      )}
      {panel === "ai" && (
        <Suspense
          fallback={
            <p className={styles.loading}>Loading AI builder…</p>
          }
        >
          <AIBuilder
            dashboard={dashboard}
            providers={providers}
            onApply={applyDocument}
            onClose={close}
            checkDocument={client.validate}
            onFocusWidget={selectWidget}
            observe={!!client.observeConnection}
            unsaved={dirty}
          />
        </Suspense>
      )}
      {panel === "add" && (
        <WidgetLibrary
          onAdd={addWidget}
          onClose={close}
          onAI={() => openBuilderPanel("ai")}
          disabled={dashboard.widgets.length >= MAX_WIDGETS}
        />
      )}
      {panel === "providers" && (
        <LazyPanelBoundary label="Data sources" unsaved={dirty || widgetDraftDirty} onClose={close}>
          <Suspense fallback={<p className={styles.loading} role="status">Loading data sources…</p>}>
            <ProviderManager
              client={client}
              providers={providers}
              unsupportedProviders={unsupportedProviders}
              example={backend.example}
              onClose={close}
              onExplore={exploreProvider}
              loadCatalog={refreshCatalog}
              onChange={(catalog) => {
                // The manager's listing is authoritative now: it replaces any failed or pending load.
                acceptCatalog(catalog)
                setSourceRequest(null)
                setQueryRevision((value) => value + 1)
                setLibraryRevision((value) => value + 1)
              }}
            />
            <MountSignal onMount={markProvidersMounted} />
          </Suspense>
        </LazyPanelBoundary>
      )}
      {panel === "history" && (
        <LazyPanelBoundary label="Revision history" unsaved={dirty || widgetDraftDirty} onClose={close}>
          <Suspense fallback={<p className={styles.loading} role="status">Loading history…</p>}>
            <DashboardHistory
              key={dashboard.id}
              dashboard={dashboard}
              client={client}
              canRestore={!dirty && !widgetDraftDirty && !busy && !importingBundle}
              refreshKey={saved}
              onRestored={applyRestoredDocument}
              onClose={close}
              savedQueries={savedQueries}
            />
          </Suspense>
        </LazyPanelBoundary>
      )}
      {panel === "manage" && (
        <LazyPanelBoundary label="Manage dashboards" unsaved={dirty || widgetDraftDirty} onClose={close}>
          <Suspense fallback={<p className={styles.loading} role="status">Loading dashboard manager…</p>}>
            <DashboardManager
              key={dashboard.id}
              dashboard={dashboard}
              dashboards={dashboards}
              providers={providers}
              variableCatalog={variableCatalog}
              busy={busy}
              onClose={close}
              onApply={(next) => {
                syncVariableDefinitions(next)
                update(next)
                setEditing(true)
              }}
              onDetailsChange={(next, group) => {
                update(next, { group })
                setEditing(true)
              }}
              onDetailsEnd={endGroup}
              onDuplicate={duplicateDashboard}
              onDelete={deleteDashboard}
              onImportBundle={importBundle}
              onReviewBundle={reviewBundle}
              validateDocument={client.validate}
              onRefreshQueries={refreshSavedQueries}
            />
            <MountSignal onMount={markManageMounted} />
          </Suspense>
        </LazyPanelBoundary>
      )}

    </aside>
  )
}
