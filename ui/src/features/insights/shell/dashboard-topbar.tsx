import { Suspense } from "react"
import { ChevronRight, CircleHelp, Link2, PanelLeftClose } from "lucide-react"
import styles from "../insights.module.css"
import { GammaButton } from "../gamma/button"
import { InsightsThemeControl } from "../insights-theme"
import { serialiseDashboardView } from "../dashboard-view"
import { Explorer } from "./lazy-panels"
import type { Shell } from "./types"

export function renderDashboardTopbar(
  backend: Shell["backend"],
  compactNavigationExpanded: Shell["compactNavigationExpanded"],
  compactShell: Shell["compactShell"],
  currentRoute: Shell["currentRoute"],
  dashboard: Shell["dashboard"],
  drawerOpen: Shell["drawerOpen"],
  explorerOpened: Shell["explorerOpened"],
  explorerSource: Shell["explorerSource"],
  exploring: Shell["exploring"],
  importingBundle: Shell["importingBundle"],
  isMobile: Shell["isMobile"],
  libraryClient: Shell["libraryClient"],
  mobileSidebar: Shell["mobileSidebar"],
  navigationToggle: Shell["navigationToggle"],
  openBuilderPanel: Shell["openBuilderPanel"],
  panelHidden: Shell["panelHidden"],
  providers: Shell["providers"],
  queriesError: Shell["queriesError"],
  queriesLoaded: Shell["queriesLoaded"],
  queriesLoading: Shell["queriesLoading"],
  savedQueries: Shell["savedQueries"],
  setCompactNavigationExpanded: Shell["setCompactNavigationExpanded"],
  setError: Shell["setError"],
  setExplorerDirty: Shell["setExplorerDirty"],
  setExploring: Shell["setExploring"],
  setLibraryRevision: Shell["setLibraryRevision"],
  setMessage: Shell["setMessage"],
  setMobileSidebar: Shell["setMobileSidebar"],
  setPanelHidesSidebar: Shell["setPanelHidesSidebar"],
  setSidebar: Shell["setSidebar"],
  setSidebarOverride: Shell["setSidebarOverride"],
  setTheme: Shell["setTheme"],
  sidebar: Shell["sidebar"],
  sidebarShown: Shell["sidebarShown"],
  theme: Shell["theme"],
  updateSavedQueries: Shell["updateSavedQueries"],
  linkSavedQuery: Shell["linkSavedQuery"],
  variableValues: Shell["variableValues"],
) {
  return (
    <>
      <div className={styles.topbar} data-tooltip-obstacle>
        <div className={styles.breadcrumb}>
          <GammaButton iconOnly size="sm" variant="quiet"
            ref={navigationToggle}
            className={styles.iconButton}
            aria-label="Toggle sidebar"
            aria-expanded={isMobile ? drawerOpen : compactShell ? compactNavigationExpanded && sidebarShown : sidebarShown}
            aria-controls="insights-navigation"
            onClick={() => {
              if (isMobile) setMobileSidebar(!mobileSidebar)
              // Showing the sidebar over an open panel is the user's choice; it stays until they hide it again.
              else if (panelHidden) {
                setPanelHidesSidebar(false)
                setSidebarOverride(true)
              } else if (compactShell) setCompactNavigationExpanded(!compactNavigationExpanded)
              else setSidebar(!sidebar)
            }}
          >
            <PanelLeftClose size={17} />
          </GammaButton>
          <span>Insights</span>
          <ChevronRight size={12} />
          <strong>{exploring ? "Explore" : "Dashboards"}</strong>
        </div>
        <div className={styles.topbarRight}>
          <InsightsThemeControl value={theme} onChange={setTheme} className={styles.themeControl} />
          <GammaButton iconOnly size="sm" variant="quiet" aria-label="Copy dashboard link" onClick={async () => {
            try {
              const state = { ...currentRoute, dashboardId: dashboard.id, variables: variableValues }
              const url = new URL(serialiseDashboardView(state, { example: backend.example }), location.origin)
              await navigator.clipboard.writeText(url.href)
              setError("")
              setMessage("Dashboard link copied with the current variables and time settings.")
            } catch { setError("Could not copy the link. Copy the current address from your browser.") }
          }}><Link2 size={15} /></GammaButton>
          <span className={styles.modeBadge}>
            <span />
            {backend.copy.badge}
          </span>
          <GammaButton data-panel-opener="providers" iconOnly size="sm" variant="quiet"
            className={styles.iconButton}
            aria-label="About data sources"
            disabled={importingBundle}
            onClick={() => openBuilderPanel("providers")}
          >
            <CircleHelp size={17} />
          </GammaButton>
        </div>
      </div>
      {explorerOpened && (
        <section hidden={!exploring} className={styles.explorerArea} aria-label="Data source explorer">
          {queriesLoading && <p className={styles.loading} role="status">Loading saved queries…</p>}
          {queriesError && <div role="alert"><p>{queriesError}</p><GammaButton variant="secondary" onClick={() => setLibraryRevision(value => value + 1)}>Reload saved queries</GammaButton></div>}
          {queriesLoaded && <Suspense fallback={<p className={styles.loading}>Loading explorer…</p>}>
            <Explorer key={explorerSource.revision} initialProviderId={explorerSource.providerId} initialSeed={explorerSource.seed} client={libraryClient} providers={providers} queries={savedQueries} onQueriesChange={updateSavedQueries} onDirtyChange={setExplorerDirty} onUse={linkSavedQuery} onClose={() => setExploring(false)} active={exploring && !queriesLoading && !queriesError} />
          </Suspense>}
        </section>
      )}
    </>
  )
}
