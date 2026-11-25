/* eslint-disable react-hooks/refs -- code moved verbatim from InsightsWorkspace, which the React Compiler lint skips; its ref and setter patterns are reviewed there, not rewritten in a move */
import { useCallback, useEffect, useRef, useState } from "react"
import { createBundleImporter } from "../bundle-import"
import { type ProviderCatalog } from "../client"
import { type SourceStatus } from "../source-status"
import { preloadWidgetEditor } from "./lazy-panels"
import { type SourceState, sharedFailureReason } from "./source-catalog"
import type { AfterShellLayout } from "./types"

export function useSourceCatalog(
  client: AfterShellLayout["client"],
  editing: AfterShellLayout["editing"],
  mode: AfterShellLayout["mode"],
  sessionRevision: AfterShellLayout["sessionRevision"],
  setProviders: AfterShellLayout["setProviders"],
  setUnsupportedProviders: AfterShellLayout["setUnsupportedProviders"],
) {
  const [end, setEnd] = useState(() => Math.floor(Date.now() / 1000))
  // Whether the current end came from an automatic tick. An automatic tick staggers across the tiles; any other change adopts at once.
  const [autoTick, setAutoTick] = useState(false)
  // When the user last pressed Refresh. Queries in the bypass window skip the server's result cache.
  const [refreshedAt, setRefreshedAt] = useState(0)
  const advanceEnd = useCallback((auto: boolean) => {
    setEnd(Math.floor(Date.now() / 1000))
    setAutoTick(auto)
  }, [])
  const [retry, setRetry] = useState(0)
  // The shared source list loads behind a rendered workspace. Only tiles that need it wait.
  const [sources, setSources] = useState<SourceState>({ status: "ready" })
  const [sourceRequest, setSourceRequest] = useState<object | null>(null)
  const sourceNoticeRef = useRef<HTMLDivElement>(null)
  const bannerRetry = useRef<HTMLButtonElement>(null)
  // Always rendered in the live workspace, so it is a dependable focus target after a retry.
  const workspaceRegion = useRef<HTMLElement>(null)
  // The retry request whose outcome owns focus. Superseding or aborting it releases the claim.
  const retryFocus = useRef<object | null>(null)
  // A retry that ends busy again moves focus to the banner's retry control once it renders.
  const focusBannerRetry = useRef(false)
  // Callers awaiting the listing (the observe card, the provider manager) settle with the request that loads it.
  const catalogWaiters = useRef<Array<{ resolve: (catalog: ProviderCatalog) => void; reject: (error: unknown) => void }>>([])
  // A session change while the banner asks for sign-in reloads the sources.
  const [seenSessionRevision, setSeenSessionRevision] = useState(sessionRevision)
  if (sessionRevision !== seenSessionRevision) {
    setSeenSessionRevision(sessionRevision)
    if (mode === "live" && sources.status === "unavailable" && sources.reason === "signin") {
      setSources({ status: "pending" })
      setSourceRequest({})
    }
  }
  // The sign-in action only exists when the host can start sign-in.
  const sourceContext: SourceStatus = sources.status === "unavailable"
    ? (sources.reason === "signin" && client.signIn ? "signin" : "unavailable")
    : sources.status
  // Retry leaves the button out of the DOM as the load starts, so focus moves to the
  // persistent live region, which stays mounted for the whole episode.
  const retrySources = () => {
    const request = {}
    retryFocus.current = request
    sourceNoticeRef.current?.focus()
    setSources({ status: "pending" })
    setSourceRequest(request)
  }
  // The one way a listing reaches the workspace: boot, retry, and the provider
  // manager all share it, so a busy shared catalog is never mistaken for a clean one.
  const acceptCatalog = useCallback((catalog: ProviderCatalog) => {
    setProviders(catalog.providers)
    setUnsupportedProviders(catalog.unsupportedProviders ?? [])
    const shared = catalog.sharedCatalog
    setSources(shared
      ? { status: "unavailable", reason: sharedFailureReason(shared.status), message: shared.message }
      : { status: "ready" })
  }, [setProviders, setUnsupportedProviders])
  // The observe card and the provider manager wait on the request that loads the listing.
  // That request owns the abort, so closing their panel never strands the sources.
  const refreshCatalog = useCallback(() => new Promise<ProviderCatalog>((resolve, reject) => {
    catalogWaiters.current.push({ resolve, reject })
    setSources({ status: "pending" })
    setSourceRequest({})
  }), [])
  const [queryRevision, setQueryRevision] = useState(0)
  const etags = useRef(new Map<string, string>())
  // The inputs of the last workspace reconcile; see sameSyncInputs.
  const lastSyncInputs = useRef<readonly unknown[] | undefined>(undefined)
  const openRequest = useRef(0)
  const bundleImporter = useRef<ReturnType<typeof createBundleImporter> | null>(null)
  const bundleImportActive = useRef(false)
  if (!bundleImporter.current) bundleImporter.current = createBundleImporter()
  useEffect(() => {
    if (editing) preloadWidgetEditor()
  }, [editing])
  return [
    acceptCatalog,
    advanceEnd,
    autoTick,
    bannerRetry,
    bundleImportActive,
    bundleImporter,
    catalogWaiters,
    end,
    etags,
    focusBannerRetry,
    lastSyncInputs,
    openRequest,
    queryRevision,
    refreshCatalog,
    refreshedAt,
    retry,
    retryFocus,
    retrySources,
    setQueryRevision,
    setRefreshedAt,
    setRetry,
    setSourceRequest,
    setSources,
    sourceContext,
    sourceNoticeRef,
    sourceRequest,
    sources,
    workspaceRegion,
  ] as const
}
