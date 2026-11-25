import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { type Provider } from "../schema"
import { exampleDashboard } from "../example"
import { useDashboardHistory } from "../history"
import { type UnsupportedProvider } from "../client"
import { useInsightsTheme } from "../insights-theme"
import { RepositoryWorkspace } from "./lazy-panels"

export function useWorkspace() {
  const { theme, resolvedTheme, setTheme } = useInsightsTheme()
  const history = useDashboardHistory(exampleDashboard)
  const { dashboard, update, endGroup, reset, undo, redo, canUndo, canRedo } = history
  const latestDocument = useRef(dashboard)
  useLayoutEffect(() => { latestDocument.current = dashboard }, [dashboard])
  const [mode, setMode] = useState<
    "loading" | "live" | "example" | "unavailable"
  >("loading")
  const [providers, setProviders] = useState<Provider[]>([])
  const [unsupportedProviders, setUnsupportedProviders] = useState<UnsupportedProvider[]>([])
  // Loaded on first use. Example mode reads it; the Examples panel needs it even in live mode.
  const [workspace, setWorkspace] = useState<RepositoryWorkspace | null>(null)
  const activeExample = mode === "example" ? workspace : null
  // A failed catalog or editor chunk stays failed until the page reloads, so the only recovery offered is a reload.
  const [workspaceFailed, setWorkspaceFailed] = useState(false)
  const [exampleStarting, setExampleStarting] = useState(false)
  const [editorMounted, setEditorMounted] = useState(false)
  const [galleryMounted, setGalleryMounted] = useState(false)
  // Every example start and live refresh claims a generation; a superseded or unmounted start must not write.
  const exampleGeneration = useRef(0)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const markEditorMounted = useCallback(() => setEditorMounted(true), [])
  const markGalleryMounted = useCallback(() => setGalleryMounted(true), [])
  // Lazy builder panels that hold focus targets. Focus waits for each one's first mount; later opens are cached.
  const [mountedPanels, setMountedPanels] = useState<ReadonlySet<string>>(() => new Set())
  const markPanelMounted = useCallback((name: string) => setMountedPanels((current) => current.has(name) ? current : new Set(current).add(name)), [])
  const markSourceMounted = useCallback(() => markPanelMounted("source"), [markPanelMounted])
  const markProvidersMounted = useCallback(() => markPanelMounted("providers"), [markPanelMounted])
  const markManageMounted = useCallback(() => markPanelMounted("manage"), [markPanelMounted])
  return [
    activeExample,
    canRedo,
    canUndo,
    dashboard,
    editorMounted,
    endGroup,
    exampleGeneration,
    exampleStarting,
    galleryMounted,
    latestDocument,
    markEditorMounted,
    markGalleryMounted,
    markManageMounted,
    markProvidersMounted,
    markSourceMounted,
    mode,
    mounted,
    mountedPanels,
    providers,
    redo,
    reset,
    resolvedTheme,
    setExampleStarting,
    setMode,
    setProviders,
    setTheme,
    setUnsupportedProviders,
    setWorkspace,
    setWorkspaceFailed,
    theme,
    undo,
    unsupportedProviders,
    update,
    workspace,
    workspaceFailed,
  ] as const
}
