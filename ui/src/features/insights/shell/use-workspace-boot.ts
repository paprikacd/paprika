/* eslint-disable react-hooks/immutability -- code moved verbatim from InsightsWorkspace, which the React Compiler lint skips; its ref and setter patterns are reviewed there, not rewritten in a move */
import { useCallback, useEffect } from "react"
import { newDashboard } from "../schema"
import { EXAMPLE_STORAGE_KEY, writeExampleWorkspace } from "../example-storage"
import { documentFingerprint } from "../fingerprint"
import { loadProviderCatalog } from "../client"
import { lockBodyScroll } from "../gamma/scroll-lock"
import { describeIgnoredLink, resolveLinkView } from "../drilldown"
import { RepositoryWorkspace, loadRepositoryWorkspace } from "./lazy-panels"
import { initialNavigation } from "./navigation"
import { sourceFailureReason } from "./source-catalog"
import type { AfterTileActions } from "./types"

export function useWorkspaceBoot(
  acceptCatalog: AfterTileActions["acceptCatalog"],
  advanceEnd: AfterTileActions["advanceEnd"],
  applyView: AfterTileActions["applyView"],
  bannerRetry: AfterTileActions["bannerRetry"],
  catalogWaiters: AfterTileActions["catalogWaiters"],
  client: AfterTileActions["client"],
  dirty: AfterTileActions["dirty"],
  drawerOpen: AfterTileActions["drawerOpen"],
  etags: AfterTileActions["etags"],
  exampleGeneration: AfterTileActions["exampleGeneration"],
  explorerDirty: AfterTileActions["explorerDirty"],
  focusBannerRetry: AfterTileActions["focusBannerRetry"],
  importingBundle: AfterTileActions["importingBundle"],
  initialExample: AfterTileActions["initialExample"],
  mode: AfterTileActions["mode"],
  mounted: AfterTileActions["mounted"],
  navigation: AfterTileActions["navigation"],
  navigationToggle: AfterTileActions["navigationToggle"],
  reset: AfterTileActions["reset"],
  retry: AfterTileActions["retry"],
  retryFocus: AfterTileActions["retryFocus"],
  setDashboards: AfterTileActions["setDashboards"],
  setError: AfterTileActions["setError"],
  setExampleStarting: AfterTileActions["setExampleStarting"],
  setLinkNotice: AfterTileActions["setLinkNotice"],
  setMobileSidebar: AfterTileActions["setMobileSidebar"],
  setMode: AfterTileActions["setMode"],
  setProviders: AfterTileActions["setProviders"],
  setSaved: AfterTileActions["setSaved"],
  setSourceRequest: AfterTileActions["setSourceRequest"],
  setSources: AfterTileActions["setSources"],
  setUnsupportedProviders: AfterTileActions["setUnsupportedProviders"],
  setWorkspace: AfterTileActions["setWorkspace"],
  setWorkspaceFailed: AfterTileActions["setWorkspaceFailed"],
  showView: AfterTileActions["showView"],
  sourceNoticeRef: AfterTileActions["sourceNoticeRef"],
  sourceRequest: AfterTileActions["sourceRequest"],
  sources: AfterTileActions["sources"],
  viewDashboard: AfterTileActions["viewDashboard"],
  widgetDraftDirty: AfterTileActions["widgetDraftDirty"],
  workspaceRegion: AfterTileActions["workspaceRegion"],
) {
  const enterExample = useCallback(async () => {
    const generation = ++exampleGeneration.current
    const current = () => mounted.current && generation === exampleGeneration.current
    setExampleStarting(true)
    let runtime: RepositoryWorkspace
    try {
      runtime = await loadRepositoryWorkspace()
    } catch {
      if (!current()) return
      setWorkspaceFailed(true)
      setExampleStarting(false)
      setError("The example workspace could not load. Reload the page to try again.")
      setMode("unavailable")
      return
    }
    if (!current()) return
    const stored = runtime.readRepositoryExampleWorkspace(localStorage)
    if (localStorage.getItem(EXAMPLE_STORAGE_KEY) === null) writeExampleWorkspace(localStorage, stored.dashboards, stored.activeId)
    const fallback =
      stored.dashboards.find((item) => item.id === stored.activeId) ??
      newDashboard()
    const { document: sample, link, rejected, error } = initialNavigation(stored.dashboards, fallback)
    reset(sample)
    setSaved(documentFingerprint(sample))
    setDashboards(stored.dashboards)
    setProviders(runtime.repositoryWorkspaceProviders)
    setUnsupportedProviders([])
    setWorkspace(runtime)
    setSources({ status: "ready" })
    setSourceRequest(null)
    setMode("example")
    const linked = resolveLinkView(sample, link, rejected)
    let viewError = error
    try {
      applyView(linked.state, error ? "keep" : "load", { example: true })
    } catch (cause) {
      // A link that parses but cannot be written back keeps its value on screen, and the address keeps the link.
      showView(linked.state)
      viewError = cause instanceof Error ? cause.message : "Invalid dashboard link"
    }
    setLinkNotice(describeIgnoredLink(linked.ignored))
    setError(viewError)
    setExampleStarting(false)
  }, [reset, applyView, showView, exampleGeneration, mounted, setDashboards, setExampleStarting, setMode, setProviders, setUnsupportedProviders, setWorkspace, setWorkspaceFailed, setError, setLinkNotice, setSaved, setSourceRequest, setSources])

  useEffect(() => {
    if (initialExample) {
      let active = true
      queueMicrotask(() => {
        if (active) enterExample()
      })
      return () => {
        active = false
      }
    }
    exampleGeneration.current++
    const controller = new AbortController()
    client.list(controller.signal)
      .then(async (documents) => {
        if (controller.signal.aborted) return
        const initial = initialNavigation(documents, documents[0] ?? newDashboard())
        const active = documents.length
          ? await client.get(initial.document.id)
          : { dashboard: newDashboard(), etag: undefined }
        if (controller.signal.aborted) return
        if (active.etag) etags.current.set(active.dashboard.id, active.etag)
        // The workspace renders now; the shared source list loads behind it.
        setSources({ status: "pending" })
        setSourceRequest({})
        setDashboards(documents)
        reset(active.dashboard)
        setSaved(documentFingerprint(active.dashboard))
        setMode("live")
        // The fetched document is authoritative: values it no longer declares are dropped, not thrown.
        const linked = resolveLinkView(active.dashboard, { ...initial.link, dashboardId: active.dashboard.id }, initial.rejected)
        applyView(linked.state, initial.error ? "keep" : "load")
        setLinkNotice(describeIgnoredLink(linked.ignored))
        setError(initial.error)
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setMode("unavailable")
          setError(error.message)
        }
      })
    return () => controller.abort()
  }, [client, initialExample, enterExample, reset, retry, applyView, exampleGeneration, setDashboards, setMode, setError, setLinkNotice, setSaved, etags, setSourceRequest, setSources])

  // One background load, one retry layer: the client replays a busy listing, and a
  // failure that remains is shown with a manual retry. The listing carries the shared
  // catalog's own status, so local sources still load.
  useEffect(() => {
    if (!sourceRequest || mode !== "live") return
    const controller = new AbortController()
    const ownsFocus = retryFocus.current === sourceRequest
    loadProviderCatalog(client, controller.signal).then(
      (catalog) => {
        if (controller.signal.aborted) return
        if (ownsFocus) {
          retryFocus.current = null
          if (catalog.sharedCatalog) {
            // A busy answer still resolves, but the retry did not recover: its control keeps focus.
            focusBannerRetry.current = true
          } else {
            // Move focus only while it still sits on the banner, or nowhere: a user who moved on keeps it.
            const active = document.activeElement
            if (!active || active === document.body || active === sourceNoticeRef.current || active === bannerRetry.current) workspaceRegion.current?.focus()
          }
        }
        acceptCatalog(catalog)
        for (const waiter of catalogWaiters.current.splice(0)) waiter.resolve(catalog)
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (ownsFocus) {
          retryFocus.current = null
          focusBannerRetry.current = true
        }
        // The workspace is already on screen: a rejected catalog never unmounts it,
        // so unsaved edits survive. Sign-in is offered as an explicit action.
        const message = error instanceof Error ? error.message : "Data sources are unavailable."
        setSources({ status: "unavailable", reason: sourceFailureReason(error), message })
        for (const waiter of catalogWaiters.current.splice(0)) waiter.reject(error)
      },
    )
    return () => {
      controller.abort()
      // An aborted retry no longer owns focus.
      if (retryFocus.current === sourceRequest) retryFocus.current = null
    }
  }, [client, mode, sourceRequest, acceptCatalog, bannerRetry, catalogWaiters, focusBannerRetry, retryFocus, setSources, sourceNoticeRef, workspaceRegion])

  // A retry that ends busy again renders a new retry control, which takes focus.
  useEffect(() => {
    if (!focusBannerRetry.current) return
    focusBannerRetry.current = false
    const target = bannerRetry.current ?? sourceNoticeRef.current
    target?.focus()
  }, [sources, bannerRetry, focusBannerRetry, sourceNoticeRef])


  useEffect(() => {
    if (!dirty && !widgetDraftDirty && !explorerDirty && !importingBundle) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [dirty, widgetDraftDirty, explorerDirty, importingBundle])

  useEffect(() => {
    if (!drawerOpen || !navigation.current) return
    const drawer = navigation.current
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : navigationToggle.current
    const unlock = lockBodyScroll()
    const focusable = () => [
      ...drawer.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ]
    focusable()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      // A native modal above the drawer owns Tab and Escape, including events
      // delivered at document level by the browser's modal close watcher.
      if (event.defaultPrevented || document.querySelector("dialog[open]")) return
      if (event.key === "Escape") {
        event.preventDefault()
        setMobileSidebar(false)
        return
      }
      if (event.key !== "Tab") return
      const controls = focusable()
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) {
        event.preventDefault()
        drawer.focus()
        return
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !drawer.contains(document.activeElement))
      ) {
        event.preventDefault()
        last.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !drawer.contains(document.activeElement))
      ) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", keydown)
    return () => {
      document.removeEventListener("keydown", keydown)
      unlock()
      if (previous?.isConnected) previous.focus()
    }
  }, [drawerOpen, navigation, navigationToggle, setMobileSidebar])

  useEffect(() => {
    // A fixed window pauses auto refresh; a relative window keeps refreshing at the view's interval.
    if (!viewDashboard.refreshInterval || viewDashboard.customTimeRange) return
    const timer = setInterval(() => {
      if (!document.hidden) advanceEnd(true)
    }, viewDashboard.refreshInterval * 1000)
    const onVisible = () => {
      if (!document.hidden) advanceEnd(true)
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [viewDashboard.refreshInterval, viewDashboard.customTimeRange, advanceEnd])
  return [
    enterExample,
  ] as const
}
