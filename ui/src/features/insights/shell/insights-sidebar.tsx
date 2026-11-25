import { Activity, ArrowLeft, Braces, Database, FilePlus2, LayoutDashboard, Plus, Search, X } from "lucide-react"
import catalogMeta from "../repository-examples/catalog-meta.json"
import { DashboardTree } from "../dashboard-library"
import styles from "../insights.module.css"
import { GammaButton } from "../gamma/button"
import { GammaInput } from "../gamma/input"
import { preloadExamples } from "./lazy-panels"
import type { Shell } from "./types"

export function renderInsightsSidebar(
  backend: Shell["backend"],
  bundleImportActive: Shell["bundleImportActive"],
  close: Shell["close"],
  compactNavigationExpanded: Shell["compactNavigationExpanded"],
  compactShell: Shell["compactShell"],
  confirmation: Shell["confirmation"],
  createDashboard: Shell["createDashboard"],
  dashboard: Shell["dashboard"],
  dashboards: Shell["dashboards"],
  dirty: Shell["dirty"],
  drawerOpen: Shell["drawerOpen"],
  explorerDirty: Shell["explorerDirty"],
  exploring: Shell["exploring"],
  focusedWidget: Shell["focusedWidget"],
  importingBundle: Shell["importingBundle"],
  isMobile: Shell["isMobile"],
  mobileSidebar: Shell["mobileSidebar"],
  moveDashboard: Shell["moveDashboard"],
  navigation: Shell["navigation"],
  onBack: Shell["onBack"],
  openBuilderPanel: Shell["openBuilderPanel"],
  openDashboard: Shell["openDashboard"],
  openQueryExplorer: Shell["openQueryExplorer"],
  providers: Shell["providers"],
  savedQueries: Shell["savedQueries"],
  search: Shell["search"],
  setExploring: Shell["setExploring"],
  setMobileSidebar: Shell["setMobileSidebar"],
  setReturnTo: Shell["setReturnTo"],
  setSearch: Shell["setSearch"],
  sidebarShown: Shell["sidebarShown"],
  widgetDraftDirty: Shell["widgetDraftDirty"],
) {
  return (
    !focusedWidget && (isMobile ? drawerOpen : sidebarShown) && (
      <aside
        ref={navigation}
        id="insights-navigation"
        className={`${styles.sidebar} ${mobileSidebar ? styles.mobileSidebar : ""} ${compactShell && !compactNavigationExpanded ? styles.compactRail : ""}`}
        data-navigation-expanded={compactShell ? compactNavigationExpanded : undefined}
        aria-label="Insights navigation"
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen ? true : undefined}
        tabIndex={drawerOpen ? -1 : undefined}
      >
        {drawerOpen && (
          <GammaButton iconOnly size="sm" variant="quiet"
            className={styles.iconButton}
            style={{ position: "absolute", top: 12, right: 12 }}
            aria-label="Close navigation"
            onClick={() => setMobileSidebar(false)}
          >
            <X size={17} />
          </GammaButton>
        )}
        <GammaButton size="sm" variant="quiet"
          className={styles.back}
          title={compactShell ? "Back to Paprika" : undefined}
          disabled={importingBundle}
          onClick={async () => {
            if (bundleImportActive.current) return
            if (
              (!dirty && !widgetDraftDirty && !explorerDirty) ||
              await confirmation.ask({ title: "Discard unsaved changes?", description: "Your unsaved dashboard and explorer query changes will be lost when you leave Insights.", action: "Discard changes" })
            )
              onBack?.()
          }}
        >
          <ArrowLeft size={15} /> Back to Paprika
        </GammaButton>
        <div className={styles.wordmark}>
          <span>
            <Activity size={19} />
          </span>
          Insights<span className={styles.previewTag}>preview</span>
        </div>
        <div className={styles.sideLabel}>WORKSPACE</div>
        <GammaButton size="sm" variant="quiet"
          className={styles.sideLink}
          title={compactShell ? "Dashboards — expand navigation to choose a dashboard" : undefined}
          aria-current={!exploring ? "page" : undefined}
          disabled={importingBundle}
          onClick={() => {
            setExploring(false)
            if (!exploring) close()
            setMobileSidebar(false)
          }}
        >
          <LayoutDashboard size={16} /> Dashboards{" "}
          <span>{dashboards.length}</span>
        </GammaButton>
        <GammaButton size="sm" variant="quiet"
          className={styles.sideLink}
          title={compactShell ? "Explore" : undefined}
          aria-current={exploring ? "page" : undefined}
          disabled={importingBundle}
          onClick={() => openQueryExplorer()}
        ><Search size={16} /> Explore <span>{savedQueries.length}</span></GammaButton>
        <GammaButton data-panel-opener="providers" size="sm" variant="quiet"
          className={styles.sideLink}
          title={compactShell ? "Data sources" : undefined}
          disabled={importingBundle}
          onClick={() => openBuilderPanel("providers")}
        >
          <Database size={16} /> Data sources <span>{providers.length}</span>
        </GammaButton>
        <GammaButton data-panel-opener="examples" size="sm" variant="quiet" className={styles.sideLink} title={compactShell ? "Examples" : undefined} disabled={importingBundle} onMouseEnter={preloadExamples} onFocus={preloadExamples} onClick={() => openBuilderPanel("examples")}><FilePlus2 size={16} /> Examples <span>{catalogMeta.count}</span></GammaButton>
        <div className={styles.sideSection}>
          <span className={styles.sideLabel}>YOUR DASHBOARDS</span>
          <GammaButton iconOnly size="sm" variant="quiet"
            className={styles.iconButton}
            aria-label="New dashboard"
            disabled={importingBundle}
            onClick={createDashboard}
          >
            <Plus size={15} />
          </GammaButton>
        </div>
        <label className={styles.search}>
          <Search size={13} />
          <GammaInput
            aria-label="Search dashboards"
            placeholder="Find a dashboard"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className={styles.dashboardList}>
          <DashboardTree
            dashboards={dashboards.map((item) =>
              item.id === dashboard.id ? dashboard : item,
            )}
            activeId={dashboard.id}
            search={search}
            onOpen={async (item) => {
              if (await openDashboard(item)) {
                setExploring(false)
                setReturnTo(null)
              }
            }}
            onMove={moveDashboard}
          />
        </div>
        <div className={styles.sidebarBottom}>
          <div className={styles.environment}>
            <span className={styles.statusDot} />
            <div>
              <strong>
                {backend.copy.environment}
              </strong>
              <span>
                {backend.copy.environmentDetail(providers.length)}
              </span>
            </div>
          </div>
          <GammaButton data-panel-opener="source" size="sm" variant="quiet"
            className={styles.sideLink}
            disabled={importingBundle}
            onClick={() => openBuilderPanel("source")}
          >
            <Braces size={15} /> Dashboard as code
          </GammaButton>
        </div>
      </aside>
    )
  )
}
