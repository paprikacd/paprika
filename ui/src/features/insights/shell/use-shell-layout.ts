import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { flushSync } from "react-dom"
import { useMobileNavigation, usePhoneShell } from "../use-mobile-navigation"
import { useCanvasDensity } from "../canvas-density"
import { type CanvasMode } from "../responsive-layout"
import { useConfirmation } from "../gamma/confirmation"
import { subscribeCompactDesktop, compactDesktopSnapshot, compactDesktopServerSnapshot, subscribeFinePointer, finePointerSnapshot } from "./media-stores"
import type { AfterDashboardSession } from "./types"

export function useShellLayout(
  editing: AfterDashboardSession["editing"],
  exploring: AfterDashboardSession["exploring"],
  panel: AfterDashboardSession["panel"],
) {
  const confirmation = useConfirmation()
  const [search, setSearch] = useState("")
  const { dense, setDense } = useCanvasDensity()
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("wide")
  // The user's sidebar preference. A builder panel may hide it for as long as the panel is open, so the canvas keeps the
  // wide grid; the preference returns when the panel closes. Device-local: it is never written to the URL or document.
  const [sidebar, setSidebar] = useState(true)
  const [panelHidesSidebar, setPanelHidesSidebar] = useState(false)
  // The user showed the sidebar over an open panel. It stays until they hide it, so the plan never collapses it again.
  const [sidebarOverride, setSidebarOverride] = useState(false)
  const [widePanel, setWidePanel] = useState(false)
  const [planRevision, setPlanRevision] = useState(0)
  const layoutRoot = useRef<HTMLDivElement>(null)
  const sidebarOpenWidth = useRef(192)
  // The control that opened the current panel, by its data-panel-opener name. Its element may leave the DOM while the
  // sidebar yields, so focus returns to the same name once the sidebar is back.
  const panelOpener = useRef<string | undefined>(undefined)
  const [compactNavigationExpanded, setCompactNavigationExpanded] = useState(false)
  const compactDesktop = useSyncExternalStore(subscribeCompactDesktop, compactDesktopSnapshot, compactDesktopServerSnapshot)
  const finePointer = useSyncExternalStore(subscribeFinePointer, finePointerSnapshot, compactDesktopServerSnapshot)
  const compactShell = dense && !editing && compactDesktop
  const [mobileSidebar, setMobileSidebar] = useState(false)
  const isMobile = useMobileNavigation()
  const phoneViewport = usePhoneShell()
  const drawerOpen = isMobile && mobileSidebar
  const navigation = useRef<HTMLElement>(null)
  // A panel lives in the workspace section, which Explore hides. The sidebar carries Explore and Dashboards, so it
  // is never hidden by a panel that is not on screen.
  const panelHidden = panelHidesSidebar && !!panel && !exploring
  const sidebarShown = (compactShell || sidebar) && !panelHidden
  useLayoutEffect(() => {
    if (navigation.current) sidebarOpenWidth.current = navigation.current.offsetWidth
  }, [sidebarShown, isMobile, compactShell])
  useEffect(() => {
    // A resize event runs before the canvas observes its new width. Committing the plan synchronously here means the
    // canvas sees the final room, so the hysteresis is not fed the width from before the sidebar yielded or returned.
    const replan = () => flushSync(() => setPlanRevision(value => value + 1))
    window.addEventListener("resize", replan)
    return () => window.removeEventListener("resize", replan)
  }, [])
  const navigationToggle = useRef<HTMLButtonElement>(null)
  return [
    canvasMode,
    compactNavigationExpanded,
    compactShell,
    confirmation,
    dense,
    drawerOpen,
    finePointer,
    isMobile,
    layoutRoot,
    mobileSidebar,
    navigation,
    navigationToggle,
    panelHidden,
    panelOpener,
    phoneViewport,
    planRevision,
    search,
    setCanvasMode,
    setCompactNavigationExpanded,
    setDense,
    setMobileSidebar,
    setPanelHidesSidebar,
    setSearch,
    setSidebar,
    setSidebarOverride,
    setWidePanel,
    sidebar,
    sidebarOpenWidth,
    sidebarOverride,
    sidebarShown,
    widePanel,
  ] as const
}
