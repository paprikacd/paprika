import { Braces, Clock3, LayoutDashboard, PanelTop, Plus, Redo2, RefreshCw, Undo2 } from "lucide-react"
import { MAX_WIDGETS, type Dashboard } from "../schema"
import { ariaKeyshortcutsFor, hintFor } from "../shortcuts"
import { TimeRangeControl, savedRangeLabel } from "../time-range"
import styles from "../insights.module.css"
import { GammaButton } from "../gamma/button"
import { GammaSelect } from "../gamma/select"
import { PhoneVariables, VariableBar } from "../dashboard-variables"
import { viewTimeDiffers } from "../dashboard-view"
import type { Shell } from "./types"

export function renderDashboardToolbar(
  advanceEnd: Shell["advanceEnd"],
  applePlatform: Shell["applePlatform"],
  applyDashboardVariables: Shell["applyDashboardVariables"],
  canRedo: Shell["canRedo"],
  canUndo: Shell["canUndo"],
  canvasMode: Shell["canvasMode"],
  changeViewRange: Shell["changeViewRange"],
  changeViewRefresh: Shell["changeViewRefresh"],
  compactShell: Shell["compactShell"],
  dashboard: Shell["dashboard"],
  declareVariable: Shell["declareVariable"],
  dense: Shell["dense"],
  editing: Shell["editing"],
  importingBundle: Shell["importingBundle"],
  inspectingQueries: Shell["inspectingQueries"],
  invalidWidgetSaveHintId: Shell["invalidWidgetSaveHintId"],
  openBuilderPanel: Shell["openBuilderPanel"],
  panel: Shell["panel"],
  phoneShell: Shell["phoneShell"],
  range: Shell["range"],
  redo: Shell["redo"],
  resetViewRange: Shell["resetViewRange"],
  setDense: Shell["setDense"],
  setInspectingQueries: Shell["setInspectingQueries"],
  setLibraryRevision: Shell["setLibraryRevision"],
  setQueryRevision: Shell["setQueryRevision"],
  setRefreshedAt: Shell["setRefreshedAt"],
  setViewAsDefault: Shell["setViewAsDefault"],
  undo: Shell["undo"],
  variableLoaders: Shell["variableLoaders"],
  variableValues: Shell["variableValues"],
  viewDashboard: Shell["viewDashboard"],
  viewDiffers: Shell["viewDiffers"],
  widgetDraftValid: Shell["widgetDraftValid"],
) {
  return (
    <>
      {editing && !widgetDraftValid && <p id={invalidWidgetSaveHintId} className={styles.saveBlockedHint} role="status">Fix the widget settings to save, or close the editor to keep the last valid preview.</p>}
      <div className={styles.toolbar} data-tooltip-obstacle>
        {!phoneShell && <div className={styles.toolbarLeft}>
          <VariableBar dashboard={dashboard} values={variableValues} loaders={variableLoaders} range={range} onApply={applyDashboardVariables} onDeclareVariable={editing ? declareVariable : undefined} />
          {/* The phone shell holds Code and Queries in the Dashboard actions menu, so the canvas tools row is not shown. */}
          <div className={styles.canvasTools}>
          <span className={styles.canvasTab}>
            <LayoutDashboard size={14} /> Canvas
          </span>
          <GammaButton data-panel-opener="source" size="sm" variant="quiet"
            className={panel === "source" ? styles.activeTool : ""}
            iconOnly={compactShell} aria-label={compactShell ? "Code" : undefined} title={compactShell ? "Dashboard as code" : undefined}
            disabled={importingBundle}
            onClick={() => openBuilderPanel(panel === "source" ? null : "source")}
          >
            <Braces size={14} />{!compactShell && " Code"}
          </GammaButton>
          <GammaButton size="sm" variant="quiet"
            className={inspectingQueries ? styles.activeTool : ""}
            iconOnly={compactShell} aria-label="Query inspector"
            aria-haspopup="dialog" aria-expanded={inspectingQueries} aria-controls={inspectingQueries ? "insights-query-inspector" : undefined}
            title="Inspect query timing, reuse and result bounds"
            onClick={() => setInspectingQueries(value => !value)}>
            <Clock3 size={14} />{!compactShell && " Queries"}
          </GammaButton>
          {canvasMode === "wide" && <>
          <span className={styles.divider} />
          <GammaButton size="sm" variant="quiet" iconOnly={compactShell} aria-label={compactShell ? "Compact view" : undefined} aria-pressed={dense} disabled={editing || canvasMode !== "wide"}
            title={editing ? "Compact view is available when previewing" : canvasMode !== "wide" ? "Compact view is available when the dashboard canvas is wider" : "Icon rail, one-row header and a tighter grid. The saved dashboard is unchanged."}
            className={dense && !editing ? styles.activeTool : ""} onClick={() => setDense(!dense)}>
            <PanelTop size={14} />{!compactShell && " Compact view"}
          </GammaButton>
          </>}
          <span className={styles.widgetCount}>
            {dashboard.widgets.length} widgets
          </span>
          {editing && (
            <>
              <GammaButton iconOnly size="sm" variant="quiet"
                className={styles.iconButton}
                aria-label="Undo"
                aria-keyshortcuts={ariaKeyshortcutsFor("undo")}
                title={hintFor("undo", applePlatform)}
                disabled={!canUndo}
                onClick={undo}
              >
                <Undo2 size={14} />
              </GammaButton>
              <GammaButton iconOnly size="sm" variant="quiet"
                className={styles.iconButton}
                aria-label="Redo"
                aria-keyshortcuts={ariaKeyshortcutsFor("redo")}
                title={hintFor("redo", applePlatform)}
                disabled={!canRedo}
                onClick={redo}
              >
                <Redo2 size={14} />
              </GammaButton>
            </>
          )}
          </div>
        </div>}
        <div className={styles.toolbarRight} role={phoneShell ? "group" : undefined} aria-label={phoneShell ? "Dashboard view" : undefined}>
          {phoneShell && <PhoneVariables dashboard={dashboard} values={variableValues} loaders={variableLoaders} range={range} onApply={applyDashboardVariables} />}
          <TimeRangeControl
            key={dashboard.id}
            dashboard={viewDashboard}
            onChange={changeViewRange}
            onReset={viewTimeDiffers(dashboard, viewDashboard) ? resetViewRange : undefined}
            resetLabel={savedRangeLabel(dashboard)}
            customButton={!phoneShell}
            className={phoneShell ? styles.phoneTime : undefined}
          />
          <GammaButton iconOnly size="sm" variant="quiet"
            className={styles.iconButton}
            aria-label="Refresh data"
            onClick={() => {
              advanceEnd(false)
              setRefreshedAt(Date.now())
              setQueryRevision((value) => value + 1)
              setLibraryRevision((value) => value + 1)
            }}
          >
            <RefreshCw size={14} />
          </GammaButton>
          {!phoneShell && <GammaSelect
            className={styles.refreshSelect}
            aria-label="Auto refresh"
            size="sm"
            value={String(viewDashboard.customTimeRange ? 0 : viewDashboard.refreshInterval)}
            disabled={!!viewDashboard.customTimeRange}
            onValueChange={(value) => changeViewRefresh(Number(value) as Dashboard["refreshInterval"])}
            options={[
              {value: "0", label: "Auto off"}, {value: "15", label: "15s"},
              {value: "30", label: "30s"}, {value: "60", label: "1m"},
            ]}
          />}
          {viewDiffers && (
            <GammaButton size="sm" variant="quiet" onClick={setViewAsDefault}>
              Set as dashboard default
            </GammaButton>
          )}
          {editing && (
            <GammaButton data-panel-opener="add" size="sm" variant="quiet"
              className={styles.addButton}
              onClick={() => openBuilderPanel(panel === "add" ? null : "add")}
              disabled={importingBundle || dashboard.widgets.length >= MAX_WIDGETS}
            >
              <Plus size={14} /> Add widget
            </GammaButton>
          )}
        </div>
      </div>
    </>
  )
}
