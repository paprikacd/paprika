import { Suspense } from "react"
import { FilePlus2, LayoutDashboard, LayoutTemplate, Plus } from "lucide-react"
import { dashboardAsSent } from "../layout-compaction"
import { MAX_WIDGETS } from "../schema"
import { LazyPanelBoundary, MountSignal } from "../lazy-panel"
import { WidgetEditorSkeleton } from "../widget-editor-skeleton"
import { queryConnectionKey } from "../query-connections"
import { DashboardCanvas } from "../canvas"
import { refreshStaggerSpread } from "../refresh-stagger"
import { applyChartToDashboard } from "../chart-apply"
import styles from "../insights.module.css"
import { GammaButton } from "../gamma/button"
import { duplicateLayout, savedLayout } from "../layout-edit"
import { WidgetEditor } from "./lazy-panels"
import { placementPhrase } from "./navigation"
import type { Shell } from "./types"

export function renderCanvasArea(
  alignedEnd: Shell["alignedEnd"],
  autoTick: Shell["autoTick"],
  backend: Shell["backend"],
  builderClient: Shell["builderClient"],
  builderPanel: Shell["builderPanel"],
  busy: Shell["busy"],
  canvasMode: Shell["canvasMode"],
  client: Shell["client"],
  close: Shell["close"],
  compactShell: Shell["compactShell"],
  currentWidget: Shell["currentWidget"],
  dashboard: Shell["dashboard"],
  dashboards: Shell["dashboards"],
  dense: Shell["dense"],
  dirty: Shell["dirty"],
  drilldown: Shell["drilldown"],
  duplicateTile: Shell["duplicateTile"],
  editing: Shell["editing"],
  editingWidget: Shell["editingWidget"],
  exploring: Shell["exploring"],
  fetcher: Shell["fetcher"],
  finePointer: Shell["finePointer"],
  focusedWidget: Shell["focusedWidget"],
  importingBundle: Shell["importingBundle"],
  latestDocument: Shell["latestDocument"],
  layoutUpdate: Shell["layoutUpdate"],
  leaveWidget: Shell["leaveWidget"],
  markEditorMounted: Shell["markEditorMounted"],
  noticeWithUndo: Shell["noticeWithUndo"],
  openBuilderPanel: Shell["openBuilderPanel"],
  panel: Shell["panel"],
  phoneViewport: Shell["phoneViewport"],
  previewWidget: Shell["previewWidget"],
  providers: Shell["providers"],
  queryFieldSnapshot: Shell["queryFieldSnapshot"],
  queryResultSnapshot: Shell["queryResultSnapshot"],
  range: Shell["range"],
  registerChartCommands: Shell["registerChartCommands"],
  removeTile: Shell["removeTile"],
  save: Shell["save"],
  saveDocument: Shell["saveDocument"],
  saveLatest: Shell["saveLatest"],
  scheduledFetcher: Shell["scheduledFetcher"],
  selectDashboardContext: Shell["selectDashboardContext"],
  selectDashboardTime: Shell["selectDashboardTime"],
  selectWidget: Shell["selectWidget"],
  selected: Shell["selected"],
  setCanvasMode: Shell["setCanvasMode"],
  setEditing: Shell["setEditing"],
  setError: Shell["setError"],
  setMessage: Shell["setMessage"],
  setMessageAction: Shell["setMessageAction"],
  setQueryFieldSnapshot: Shell["setQueryFieldSnapshot"],
  setQueryResultSnapshot: Shell["setQueryResultSnapshot"],
  setShortcutsOpen: Shell["setShortcutsOpen"],
  setWidgetDraftDirty: Shell["setWidgetDraftDirty"],
  setWidgetDraftValid: Shell["setWidgetDraftValid"],
  setWidgetPreview: Shell["setWidgetPreview"],
  update: Shell["update"],
  variableValues: Shell["variableValues"],
  viewDashboard: Shell["viewDashboard"],
  widgetDraftDirty: Shell["widgetDraftDirty"],
  widgetDraftValid: Shell["widgetDraftValid"],
  widgetOpener: Shell["widgetOpener"],
) {
  return (
    <div className={styles.canvasArea}>
      {editing && !focusedWidget && (
        <div className={styles.editHint}>
          <span className={styles.statusDot} /> Editing canvas{" "}
          <span className={styles.wideEditHint}>
            Drag a handle to move. Pull an edge or corner to resize.
          </span>
          <span className={styles.compactEditHint}>
            {"Use a widget's ⋯ menu to move, resize or duplicate it."}
          </span>
          {/* Phone-width layouts and touch-only devices have no use for the list, so it stays hidden there. */}
          {!phoneViewport && (
            <GammaButton size="sm" variant="quiet" className={styles.shortcutsButton} onClick={() => setShortcutsOpen(true)}>
              Keyboard shortcuts
            </GammaButton>
          )}
          <GammaButton size="sm" variant="quiet"
            disabled={importingBundle}
            onClick={() => {
              setEditing(false)
              close()
            }}
          >
            Preview
          </GammaButton>
        </div>
      )}
      {dashboard.widgets.length ? (
        <DashboardCanvas
          dashboard={viewDashboard}
          sidePanelOpen={!!panel && panel !== "widget"}
          focus={editingWidget && currentWidget && previewWidget ? {
            widget: previewWidget,
            render: (preview, previewFootprints) => <section ref={builderPanel} tabIndex={-1}>
          <LazyPanelBoundary label="Widget editor" unsaved={dirty || widgetDraftDirty} onClose={leaveWidget}>
          <Suspense fallback={<WidgetEditorSkeleton preview={preview} onClose={leaveWidget} />}>
              <WidgetEditor
                key={currentWidget.id}
                widget={currentWidget}
                workspace={{ preview, previewFootprints, canvasMode, dashboardTitle: dashboard.title, dashboardDirty: dirty, saveBusy: busy || !widgetDraftValid, onSaveDashboard: save, onDiscard: close, widgets: dashboard.widgets }}
                onPreview={setWidgetPreview}
                onDirtyChange={setWidgetDraftDirty}
                dashboards={dashboards.map(item => item.id === dashboard.id ? dashboard : item)}
                providers={providers}
                client={builderClient}
                range={range}
                queryFetcher={fetcher}
                queryFields={currentWidget.id === queryFieldSnapshot?.widgetId && queryFieldSnapshot.fetcher === fetcher && queryFieldSnapshot.key === queryConnectionKey(previewWidget ?? currentWidget, range) ? queryFieldSnapshot.fields : undefined}
                result={currentWidget.id === queryResultSnapshot?.widgetId && queryResultSnapshot.fetcher === fetcher ? queryResultSnapshot.result : undefined}
                onClose={leaveWidget}
                onCommands={registerChartCommands}
                onDraftValidityChange={setWidgetDraftValid}
                onApply={(next, layout, options) => {
                  const applied = applyChartToDashboard(latestDocument.current, next, layout)
                  if (options?.save && !busy) {
                    // Normalizing the form values joins the apply in one undo step: the document is written as it
                    // is applied, so the save below has nothing left to normalize. A document that will not
                    // parse is left as it is, and the save reports the error.
                    let sent = applied
                    try { sent = dashboardAsSent(applied) } catch { /* reported by saveDocument */ }
                    update(sent)
                    close()
                    void saveDocument(sent, { chartApplied: true, focusWidget: next.id })
                    return
                  }
                  update(applied)
                  close()
                  // The notice offers the save as its action, so the user need not find the header button.
                  const text = "Chart changes applied. Save the dashboard to keep them."
                  setMessage(text)
                  // Named "Save now", not "Save dashboard": the header button keeps that name, and e2e suites find it by name.
                  setMessageAction({ text, label: "Save now", name: "Save now", run: () => saveLatest.current() })
                }}
                onDelete={() => {
                  removeTile(currentWidget.id)
                  close()
                }}
                onDuplicate={() => {
                  if (dashboard.widgets.length >= MAX_WIDGETS) {
                    setError("A dashboard supports up to 48 widgets.")
                    return
                  }
                  // The copy holds the chart as it is in the editor, unapplied changes included. Its footprint is the
                  // draft's, and it is placed beside the saved tile or below it. The original is never resized.
                  const draft = previewWidget ?? currentWidget
                  const copyId = `widget-${crypto.randomUUID()}`
                  const edit = duplicateLayout(savedLayout(dashboard.widgets), currentWidget.id, copyId, { w: draft.layout.w, h: draft.layout.h })
                  if ("blocked" in edit) {
                    setError(edit.blocked)
                    return
                  }
                  const placed = new Map(edit.layout.map((item) => [item.i, item]))
                  const moved = dashboard.widgets.map((item) => {
                    const at = placed.get(item.id)
                    return at ? { ...item, layout: { ...item.layout, x: at.x, y: at.y } } : item
                  })
                  const at = placed.get(copyId)!
                  const copy = {
                    ...draft,
                    id: copyId,
                    title: `${draft.title.slice(0, 113)} (copy)`,
                    layout: { ...draft.layout, x: at.x, y: at.y, w: at.w, h: at.h },
                  }
                  const next = { ...dashboard, widgets: [...moved, copy] }
                  update(next)
                  selectWidget(copy.id)
                  const where = placementPhrase(edit.placement)
                  noticeWithUndo({
                    // A clean draft has no unapplied changes to call out, so the copy is described like a tile copy.
                    text: widgetDraftDirty
                      ? "Duplicated with your unapplied changes; the original is unchanged."
                      : `Duplicated ${draft.title}${where}.`,
                    name: `Undo duplicate ${draft.title}`,
                    document: next,
                    focus: currentWidget.id,
                    restored: "Removed the copy.",
                    // The editor's opener was the copy, which Undo removes. The original takes its place as the opener.
                    leave: () => {
                      widgetOpener.current = currentWidget.id
                      close()
                    },
                  })
                }}
              />
            <MountSignal onMount={markEditorMounted} />
          </Suspense>
          </LazyPanelBoundary>
            </section>,
          } : undefined}
          active={!exploring}
          onDrilldown={drilldown}
          onSelection={selectDashboardContext}
          variables={variableValues}
          onTimeRange={selectDashboardTime}
          providers={providers}
          fetcher={fetcher}
          tooltipFetcher={scheduledFetcher}
          end={alignedEnd}
          refreshStaggerMs={autoTick && !editing ? refreshStaggerSpread(viewDashboard.refreshInterval ?? 0) : 0}
          editing={editing}
          dense={dense}
          referenceCompact={compactShell && finePointer}
          onModeChange={setCanvasMode}
          selected={selected}
          onSelect={selectWidget}
          onLayout={layoutUpdate}
          onDuplicate={duplicateTile}
          onRemove={removeTile}
          duplicateBlocked={dashboard.widgets.length >= MAX_WIDGETS ? "A dashboard supports up to 48 widgets." : undefined}
          onQueryFields={setQueryFieldSnapshot}
          onQueryResult={setQueryResultSnapshot}
        />
      ) : (
        <div className={styles.emptyCanvas}>
          <LayoutDashboard size={38} strokeWidth={1} />
          <h2>Start with a signal.</h2>
          <p>
            Add a widget, bring a dashboard document, or let your AI
            assistant help shape your view.
          </p>
          <div className={styles.actions}>
            <GammaButton data-panel-opener="add" size="sm" variant="primary"
              className={styles.primary}
              disabled={importingBundle}
              onClick={() => {
                setEditing(true)
                openBuilderPanel("add")
              }}
            >
              <Plus size={15} /> Add your first widget
            </GammaButton>
            <GammaButton data-panel-opener="source" size="sm" variant="secondary"
              className={styles.secondary}
              disabled={importingBundle}
              onClick={() => openBuilderPanel("source")}
            >
              <FilePlus2 size={15} /> Import dashboard
            </GammaButton>
            {client.listStarters && client.getStarter && (
              <GammaButton data-panel-opener="starters" size="sm" variant="secondary"
                className={styles.secondary}
                disabled={importingBundle}
                onClick={() => openBuilderPanel("starters")}
              >
                <LayoutTemplate size={15} /> Start from a template
              </GammaButton>
            )}
          </div>
        </div>
      )}
      {!focusedWidget && <footer className={styles.canvasFooter}>
        <span>
          {backend.copy.footer}
        </span>
        <span>
          {dirty ? "Unsaved changes" : "All changes saved"}
          <span className={dirty ? styles.unsavedDot : styles.savedDot} />
        </span>
      </footer>}
    </div>
  )
}
