import { Loader2, Pencil, Save, History, Sparkles, Settings2 } from "lucide-react"
import { GammaActionMenu } from "../gamma/action-menu"
import { dashboardActionItems } from "../dashboard-actions"
import { ariaKeyshortcutsFor, hintFor } from "../shortcuts"
import styles from "../insights.module.css"
import { GammaButton } from "../gamma/button"
import { GammaInput } from "../gamma/input"
import { ClampedDescription } from "../dashboard-description"
import type { Shell } from "./types"

export function renderDashboardHeader(
  actionsRegion: Shell["actionsRegion"],
  applePlatform: Shell["applePlatform"],
  busy: Shell["busy"],
  changeViewRefresh: Shell["changeViewRefresh"],
  compactShell: Shell["compactShell"],
  dashboard: Shell["dashboard"],
  editing: Shell["editing"],
  endGroup: Shell["endGroup"],
  enterEdit: Shell["enterEdit"],
  focusTitleOnEdit: Shell["focusTitleOnEdit"],
  historyAvailable: Shell["historyAvailable"],
  importingBundle: Shell["importingBundle"],
  invalidWidgetSaveHintId: Shell["invalidWidgetSaveHintId"],
  isMobile: Shell["isMobile"],
  openBuilderPanel: Shell["openBuilderPanel"],
  panel: Shell["panel"],
  phoneShell: Shell["phoneShell"],
  save: Shell["save"],
  saveButton: Shell["saveButton"],
  setInspectingQueries: Shell["setInspectingQueries"],
  setShortcutsOpen: Shell["setShortcutsOpen"],
  titleField: Shell["titleField"],
  update: Shell["update"],
  viewDashboard: Shell["viewDashboard"],
  widgetDraftValid: Shell["widgetDraftValid"],
) {
  return (
    <div className={styles.pageHeader} data-tooltip-obstacle>
      <div className={styles.heading}>
        {editing ? (
          <GammaInput
            ref={titleField}
            className={styles.titleInput}
            aria-label="Dashboard title"
            maxLength={120}
            value={dashboard.title}
            onBlur={() => endGroup()}
            onChange={(e) =>
              update({ ...dashboard, title: e.target.value }, { group: "dashboard:title" })
            }
          />
        ) : (
          <h1>{dashboard.title}</h1>
        )}
        {dashboard.description && (compactShell
          ? <details className={styles.compactDescription}><summary>Dashboard context</summary><p>{dashboard.description}</p></details>
          : isMobile ? <ClampedDescription text={dashboard.description} /> : <p>{dashboard.description}</p>)}
      </div>
      <div className={styles.actions} ref={actionsRegion}>
        {isMobile || compactShell ? <GammaActionMenu
          label="Dashboard actions"
          openerName="dashboard-actions"
          className={styles.iconButton}
          disabled={importingBundle}
          items={dashboardActionItems({ phoneShell, refreshInterval: viewDashboard.refreshInterval, customRange: !!viewDashboard.customTimeRange, history: historyAvailable }, {
            edit: () => { focusTitleOnEdit.current = true; enterEdit() },
            togglePanel: name => openBuilderPanel(panel === name ? null : name),
            inspectQueries: () => setInspectingQueries(value => !value),
            refresh: changeViewRefresh,
            shortcuts: () => setShortcutsOpen(true),
          })}
        /> : <>
        {historyAvailable && <GammaButton data-panel-opener="history" size="sm" variant="secondary"
          className={styles.secondary}
          disabled={importingBundle}
          onClick={() => openBuilderPanel(panel === "history" ? null : "history")}
        >
          <History size={15} /> History
        </GammaButton>}
        <GammaButton data-panel-opener="manage" size="sm" variant="secondary"
          className={styles.secondary}
          aria-label="Manage dashboards"
          disabled={importingBundle}
          onClick={() => openBuilderPanel(panel === "manage" ? null : "manage")}
        >
          <Settings2 size={15} /> Manage
        </GammaButton>
        <GammaButton data-panel-opener="ai" size="sm" variant="secondary"
          className={styles.secondary}
          disabled={importingBundle}
          onClick={() => openBuilderPanel(panel === "ai" ? null : "ai")}
        >
          <Sparkles size={15} /> Build with AI
        </GammaButton>
        </>}
        {!phoneShell && (editing ? (
          <GammaButton ref={saveButton} size="sm" variant="primary" className={styles.primary} aria-keyshortcuts={ariaKeyshortcutsFor("save")} title={hintFor("save", applePlatform)} disabled={busy || !widgetDraftValid} aria-describedby={!widgetDraftValid ? invalidWidgetSaveHintId : undefined} onClick={save}>
            {busy ? (
              <Loader2 size={15} className={styles.spin} />
            ) : (
              <Save size={15} />
            )}{" "}
            Save dashboard
          </GammaButton>
        ) : (
          <GammaButton size="sm" variant="primary"
            iconOnly={compactShell}
            aria-label={compactShell ? "Edit dashboard" : undefined}
            title={compactShell ? "Edit dashboard" : undefined}
            className={styles.primary}
            onClick={() => enterEdit()}
          >
            <Pencil size={14} />{!compactShell && " Edit dashboard"}
          </GammaButton>
        ))}
      </div>
    </div>
  )
}
