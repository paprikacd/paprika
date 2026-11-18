"use client"

import { useQuery } from "@tanstack/react-query"
import { applicationQueryKey } from "@/lib/use-application-data"
import { createPromiseClient } from "@connectrpc/connect"
import { GitCompare } from "lucide-react"
import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"

import { InvestigationPanel } from "@/components/dashboard/investigation-panel"
import {
  resourceHealthTone,
  resourceSyncLabel,
  resourceSyncTone,
} from "@/components/dashboard/resource-list-table"
import { parseUnifiedDiff, summarizeUnifiedDiff } from "@/components/dashboard/sync-diff-view"
import { EmptyState } from "@/components/ui/empty-state"
import { StatusGlyph } from "@/components/ui/status-chip"
import { MorphTabList, MorphTabPanel, type MorphTabDirection } from "@/components/ui/morph-tabs"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import type {
  KubernetesEvent,
  LogChunk,
} from "@/gen/paprika/v1/api_pb"
import { getSessionSnapshot, recoverUnauthorized } from "@/lib/browser-session"
import { STATUS_TONES } from "@/lib/status-tone"
import { createTransport } from "@/lib/transport"
import { cn } from "@/lib/utils"

const transport = createTransport()
const client = createPromiseClient(PaprikaService, transport)

type Tab = "diff" | "live" | "desired" | "events" | "logs"

const TABS: { id: Tab; label: string }[] = [
  { id: "diff", label: "Diff" },
  { id: "live", label: "Live" },
  { id: "desired", label: "Desired" },
  { id: "events", label: "Events" },
  { id: "logs", label: "Logs" },
]

const LOG_BUFFER_LIMIT = 5000
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000
// The server re-checks a follow every five minutes by default, so a NotFound or 16
// that arrives this soon after open comes from the open itself, not from a re-check.
const OPEN_FAILURE_WINDOW_MS = 60_000
// connect-es reports Code values as numbers. These end the follow at once, since a
// retry cannot succeed: PermissionDenied (7), Unimplemented (12) and
// ResourceExhausted (8), the per-caller stream limit.
// InvalidArgument (3) is final until a stream of this follow has sent a chunk. The
// server sends it at open, for the request itself: a kind with no logs, or an
// invalid name or namespace. The request does not change during a follow, so after
// a chunk the 3 comes from the client, when a response ends partway through a
// message, and the follow reconnects.
// NotFound (5) is final when it arrives within OPEN_FAILURE_WINDOW_MS of the
// stream's open. Later, it comes from the server's periodic re-check, so the stream
// reconnects. Each reconnect opens anew, so a NotFound that arrives near that open
// is final.
// Unauthenticated (16) is final there only after its one retry. It gets one
// immediate retry, after recovering the session, and a 16 that follows that retry
// and arrives near the open is final.
const PERMISSION_DENIED_LOG_CODE = 7
const NOT_FOUND_LOG_CODE = 5
const RESOURCE_EXHAUSTED_LOG_CODE = 8
const UNIMPLEMENTED_LOG_CODE = 12
const UNAUTHENTICATED_LOG_CODE = 16
const INVALID_ARGUMENT_LOG_CODE = 3
const NON_RETRYABLE_LOG_CODES: ReadonlySet<unknown> = new Set<unknown>([
  PERMISSION_DENIED_LOG_CODE,
  RESOURCE_EXHAUSTED_LOG_CODE,
  UNIMPLEMENTED_LOG_CODE,
  UNAUTHENTICATED_LOG_CODE,
])

export interface InspectedResource {
  kind: string
  name: string
  namespace: string
  syncStatus: string
  health: string
  healthMessage: string
}

/**
 * The resource inspector: a right-anchored drawer over the application detail
 * view. It opens on Diff because drift is the question the reader almost
 * always arrived with; Live and Desired are the manifests behind that answer.
 */
export function ResourceDetailPanel({
  applicationNamespace,
  applicationName,
  resource,
  onClose,
}: {
  applicationNamespace: string
  applicationName: string
  resource: InspectedResource
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>("diff")
  const query = useQuery({
    queryKey: [...applicationQueryKey(applicationNamespace, applicationName), "resource", resource.namespace, resource.kind, resource.name],
    staleTime: 15_000,
    gcTime: 60_000,
    queryFn: ({ signal }) => client.getResource({ applicationNamespace, applicationName,
      resourceKind: resource.kind, resourceName: resource.name, resourceNamespace: resource.namespace }, { signal }),
  })
  const data = query.data
  const loading = query.isPending
  const error = query.error?.message ?? null
  const [investigationOpen, setInvestigationOpen] = useState(false)
  const titleId = useId()
  const drawerRef = useRef<HTMLElement | null>(null)
  const [tabDirection, setTabDirection] = useState<MorphTabDirection>("right")

  useEffect(() => {
    drawerRef.current?.focus()
  }, [])

  const healthTone = resourceHealthTone(resource.health)
  const syncTone = resourceSyncTone(resource.syncStatus)

  const tags = [
    resource.namespace,
    data?.apiVersion ?? "",
    data?.resource ?? "",
    data?.uid ?? "",
    ...Object.entries(data?.labels ?? {})
      .slice(0, 3)
      .map(([key, value]) => `${key}=${value}`),
  ].filter(Boolean)

  const changeTab = (next: Tab) => {
    const currentIndex = TABS.findIndex((item) => item.id === tab)
    const nextIndex = TABS.findIndex((item) => item.id === next)
    setTabDirection(nextIndex >= currentIndex ? "right" : "left")
    setTab(next)
  }

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className="fixed inset-0 z-[60] bg-foreground/30"
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose()
        }}
        className="fixed inset-y-0 right-0 z-[61] flex w-[560px] max-w-full flex-col border-l border-rule-strong bg-background shadow-drawer outline-none"
      >
        <div className="border-b border-rule bg-card px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-meta tracking-[0.12em] text-neutral-600">
                {resource.kind.toUpperCase()}
              </p>
              <h2
                id={titleId}
                className="mt-0.5 font-cond text-weight font-semibold tracking-[0.02em]"
              >
                {resource.name}
              </h2>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule bg-inset px-1.5 py-px font-mono text-meta text-muted-foreground">
                  <StatusGlyph
                    tone={healthTone}
                    label={`${STATUS_TONES[healthTone].label} health`}
                    className="size-3"
                  />
                  {STATUS_TONES[healthTone].label}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-[2px] border border-rule bg-inset px-1.5 py-px font-mono text-meta text-muted-foreground">
                  <StatusGlyph
                    tone={syncTone}
                    label={`${resourceSyncLabel(resource.syncStatus)} sync`}
                    className="size-3"
                  />
                  {resourceSyncLabel(resource.syncStatus)}
                </span>
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="max-w-56 truncate rounded-[2px] border border-rule bg-inset px-1.5 py-px font-mono text-meta text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              {resource.healthMessage ? (
                <p className="mt-1.5 text-note text-muted-foreground">
                  {resource.healthMessage}
                </p>
              ) : null}
            </div>
            <div className="flex flex-none items-center gap-1.5">
              <button
                type="button"
                onClick={() => setInvestigationOpen(true)}
                data-testid="open-investigation"
                className="inline-flex h-[26px] items-center border border-rule bg-card px-2.5 font-cond text-note font-semibold hover:bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Investigate
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close resource inspector"
                className="inline-flex size-[26px] items-center justify-center border border-rule bg-card text-muted-foreground hover:bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span aria-hidden>✕</span>
              </button>
            </div>
          </div>
        </div>

        <MorphTabList
          tabs={TABS}
          value={tab}
          onValueChange={changeTab}
          label="Resource inspector views"
          idPrefix="inspector-tab"
          panelId="inspector-panel"
          className="px-1"
        />

        <MorphTabPanel
          key={tab}
          id="inspector-panel"
          labelledBy={`inspector-tab-${tab}`}
          direction={tabDirection}
          className="flex-1 overflow-auto px-4 py-3.5"
        >
          {tab === "logs" ? (
            <LogsTab
              applicationNamespace={applicationNamespace}
              applicationName={applicationName}
              resource={resource}
              isActive
            />
          ) : loading ? (
            <p role="status" className="py-12 text-center text-chip text-muted-foreground">
              Loading resource…
            </p>
          ) : error ? (
            <p
              role="alert"
              className="border border-status-failed-line bg-status-failed-fill px-3 py-2.5 text-chip text-status-failed-text"
            >
              {error}
            </p>
          ) : !data ? (
            <p className="py-12 text-center text-chip text-muted-foreground">
              No data available.
            </p>
          ) : tab === "live" ? (
            <ManifestView manifest={data.liveManifest} label="Live manifest" />
          ) : tab === "desired" ? (
            <ManifestView manifest={data.desiredManifest} label="Desired manifest" />
          ) : tab === "diff" ? (
            <DiffView diff={data.diff} />
          ) : (
            <EventsView events={data.events} />
          )}
        </MorphTabPanel>
      </aside>
      {investigationOpen ? (
        <InvestigationPanel
          applicationNamespace={applicationNamespace}
          applicationName={applicationName}
          resource={resource}
          onClose={() => setInvestigationOpen(false)}
        />
      ) : null}
    </>
  )
}

function ManifestView({ manifest, label }: { manifest: string; label: string }) {
  if (!manifest) {
    return (
      <p className="py-12 text-center text-chip text-muted-foreground">
        {label} not available.
      </p>
    )
  }
  return (
    <pre
      aria-label={label}
      className="m-0 border border-rule bg-card p-3 font-mono text-note leading-[1.7] whitespace-pre-wrap"
    >
      {manifest}
    </pre>
  )
}

function DiffView({ diff }: { diff?: string }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  const summary = useMemo(() => summarizeUnifiedDiff(diff), [diff])
  const changed = summary.additions + summary.deletions

  if (lines.length === 0) {
    return (
      <EmptyState
        compact
        icon={GitCompare}
        title="No differences"
        description="Live state matches the desired manifest."
      />
    )
  }

  return (
    <div className="border border-rule bg-card" data-testid="inspector-diff">
      <div className="flex items-center justify-between border-b border-rule px-2.5 py-1.5">
        <span className="font-mono text-meta text-muted-foreground">
          desired ↔ live · {changed} changed {changed === 1 ? "line" : "lines"}
        </span>
        <span className="font-mono text-meta text-status-failed-text">
          +{summary.additions} −{summary.deletions}
        </span>
      </div>
      <div className="font-mono text-note leading-[1.75]">
        {lines.map((line) => (
          <div
            key={line.id}
            className={cn(
              "px-2.5 whitespace-pre",
              line.kind === "add" && "bg-diff-add-bg text-diff-add-text",
              line.kind === "delete" && "bg-diff-del-bg text-diff-del-text",
              line.kind === "context" && "text-diff-ctx-text",
              (line.kind === "file" || line.kind === "hunk") &&
                "bg-inset text-muted-foreground"
            )}
          >
            <span
              aria-hidden
              className="mr-2.5 inline-block w-[26px] text-right text-diff-gutter tabular-nums"
            >
              {line.newLine ?? line.oldLine ?? ""}
            </span>
            {line.raw}
          </div>
        ))}
      </div>
    </div>
  )
}

function EventsView({ events }: { events: KubernetesEvent[] }) {
  if (!events || events.length === 0) {
    return (
      <p className="py-12 text-center text-chip text-muted-foreground">
        No recent events.
      </p>
    )
  }
  return (
    <ul className="list-none space-y-2">
      {events.map((e, i) => {
        const tone = e.type === "Warning" ? "degraded" : "healthy"
        return (
          <li
            key={`${e.reason}-${i}`}
            className="flex gap-2.5 border border-rule bg-card px-2.5 py-2"
          >
            <StatusGlyph tone={tone} label={e.type || "Normal"} />
            <span className="min-w-0 flex-1">
              <span className="block text-chip font-semibold">{e.reason}</span>
              <span className="mt-0.5 block text-note text-muted-foreground">
                {e.message}
              </span>
              <span className="mt-1 block font-mono text-meta text-neutral-600">
                {e.count > 1 ? `${e.count} × · ` : ""}
                {e.lastTimestamp}
              </span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function LogsTab({
  applicationNamespace,
  applicationName,
  resource,
  isActive,
}: {
  applicationNamespace: string
  applicationName: string
  resource: { kind: string; name: string; namespace: string }
  isActive: boolean
}) {
  const [lines, setLines] = useState<LogChunk[]>([])
  const [podName, setPodName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  // Following drives auto-scroll. Scrolling away from the bottom turns it off, and
  // scrolling back to the bottom or pressing Follow turns it on.
  const [following, setFollowing] = useState(true)
  // Mirrors `following` for the stream loop, which reads it outside render. Only
  // applyFollowing writes it.
  const followingRef = useRef(true)
  // The scroll position at the last scroll event or programmatic scroll. A move up
  // away from the bottom turns following off, so a scroll that only clamps or
  // grows the content does not.
  const lastScrollTopRef = useRef(0)
  // Lines appended since following last turned off. Lines replayed by a reconnect
  // are not counted.
  const [unseenCount, setUnseenCount] = useState(0)
  const [filter, setFilter] = useState("")
  const [lineCount, setLineCount] = useState(0)
  const [firstChunkAt, setFirstChunkAt] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const preRef = useRef<HTMLPreElement | null>(null)
  const followToggleRef = useRef<HTMLButtonElement | null>(null)
  const filterId = useId()

  const applyFollowing = (next: boolean) => {
    followingRef.current = next
    setFollowing(next)
    if (next) setUnseenCount(0)
  }

  const scrollToBottom = () => {
    const pre = preRef.current
    if (pre) {
      pre.scrollTop = pre.scrollHeight
      lastScrollTopRef.current = pre.scrollTop
    }
  }

  // Reset state when (re)entering the tab or changing resource.
  useEffect(() => {
    if (!isActive) {
      abortRef.current?.abort()
      abortRef.current = null
      return
    }
    queueMicrotask(() => {
      setLines([])
      setPodName(null)
      setError(null)
      setLineCount(0)
      followingRef.current = true
      setFollowing(true)
      setUnseenCount(0)
      setFirstChunkAt(null)
      setReconnecting(false)
    })
  }, [
    isActive,
    applicationNamespace,
    applicationName,
    resource.kind,
    resource.name,
    resource.namespace,
  ])

  // Open the streaming RPC and pump chunks into the line buffer with
  // exponential reconnect on transient errors.
  useEffect(() => {
    if (!isActive) return
    let cancelled = false
    let attempt = 0
    // True after one immediate retry of an Unauthenticated stream, until a chunk arrives.
    let authRetried = false
    // True once any stream of this follow has sent a chunk. A reconnect replays the
    // pod log from the start (no TailLines or SinceSeconds), so its first chunk must
    // replace the buffer. Until then, InvalidArgument (3) is final.
    let sawChunk = false
    // Lines in the buffer since its last replacement, and how many lines the last
    // replacement replays. A line that a replay sends again is not new, so it does not
    // count toward the Jump to latest count.
    let shownTotal = 0
    let replayBaseline = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const open = async () => {
      if (cancelled) return
      const controller = new AbortController()
      abortRef.current = controller
      setReconnecting(true)
      // The session token this stream opens with. An Unauthenticated answer is
      // recovered against it, so a token the app has already replaced is not refreshed.
      const tokenAtOpen = getSessionSnapshot().idToken
      const openedAt = Date.now()
      // Whether this stream has sent a chunk yet. It is set on the first chunk of
      // this stream, which may be a replay of the buffered log.
      let streamHasChunk = false
      // Position of this stream's next chunk, counted from the stream's first chunk.
      let streamIndex = 0
      try {
        const iter = client.streamResourceLogs({
          applicationNamespace,
          applicationName,
          resourceKind: resource.kind,
          resourceName: resource.name,
          resourceNamespace: resource.namespace,
          follow: true,
        }, { signal: controller.signal })
        const reader = iter[Symbol.asyncIterator]()
        while (!cancelled) {
          const { value, done } = await reader.next()
          if (done) break
          const chunk = value as LogChunk
          // Bail out if the caller (tab switch / unmount / explicit cancel)
          // aborted the stream while we were waiting.
          if (controller.signal.aborted) break
          authRetried = false
          if (!streamHasChunk) {
            streamHasChunk = true
            setError(null)
            if (sawChunk) {
              // A reconnect replays the whole log, so drop the lines already shown.
              // The replay re-sends the lines shown so far before any new ones. A
              // reconnect during a replay keeps the higher count.
              replayBaseline = Math.max(replayBaseline, shownTotal)
              shownTotal = 0
              setLines([])
              setLineCount(0)
              setFirstChunkAt(Date.now())
            }
          }
          const replayed = streamIndex < replayBaseline
          streamIndex++
          shownTotal++
          sawChunk = true
          if (!connected) {
            setConnected(true)
            setReconnecting(false)
            attempt = 0
          }
          if (!podName && chunk.podName) setPodName(chunk.podName)
          setLines((prev) => {
            const next =
              prev.length >= LOG_BUFFER_LIMIT
                ? prev.slice(prev.length - LOG_BUFFER_LIMIT + 1)
                : prev
            next.push(chunk)
            return next
          })
          setLineCount((c) => c + 1)
          if (!replayed && !followingRef.current) setUnseenCount((c) => c + 1)
          if (firstChunkAt == null) setFirstChunkAt(Date.now())
        }
        // Normal completion (EOF or end of follow=false): close cleanly.
        if (!cancelled) setConnected(false)
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        console.warn("StreamResourceLogs error:", msg)
        const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined
        // Unimplemented on agent/repo-server: don't keep trying.
        if (code === UNIMPLEMENTED_LOG_CODE) {
          setError("Streaming logs are not available on this server.")
          setConnected(false)
          setReconnecting(false)
          return
        }
        if (code === RESOURCE_EXHAUSTED_LOG_CODE) {
          setError("Too many log streams are open. Close another log view, then reopen this one.")
          setConnected(false)
          setReconnecting(false)
          return
        }
        const failedNearOpen = Date.now() - openedAt < OPEN_FAILURE_WINDOW_MS
        if (code === NOT_FOUND_LOG_CODE) {
          // Near the open, the resource or its application is missing now, so the follow
          // ends. Later, the server's re-check found it gone. A reconnect then opens again:
          // the open resolves the pod through the application's tree, so a NotFound there
          // covers a deleted application and a resource outside its tree alike. A recreated
          // application streams again only if its tree lists the resource by that reopen;
          // otherwise that NotFound is final.
          if (failedNearOpen) {
            setError("This resource or its application no longer exists.")
            setConnected(false)
            setReconnecting(false)
            return
          }
        }
        if (code === UNAUTHENTICATED_LOG_CODE && (!authRetried || !failedNearOpen)) {
          authRetried = true
          setConnected(false)
          setReconnecting(true)
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            void refreshThenOpen(msg, tokenAtOpen)
          }, 0)
          return
        }
        // InvalidArgument before this follow's first chunk is final: the kind has no
        // logs, or the name or namespace is invalid. After a chunk, the stream
        // reconnects below.
        if (code === INVALID_ARGUMENT_LOG_CODE && !sawChunk) {
          setError(msg)
          setConnected(false)
          setReconnecting(false)
          return
        }
        if (NON_RETRYABLE_LOG_CODES.has(code)) {
          setError(msg)
          setConnected(false)
          setReconnecting(false)
          return
        }
        setError(msg)
        setConnected(false)
        scheduleReconnect()
      }
    }

    // Retries open() with exponential backoff.
    const scheduleReconnect = () => {
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS)
      attempt++
      setReconnecting(true)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void open()
      }, delay)
    }

    // Recovers the session before the Unauthenticated retry. The transport refreshes
    // only when the token is near expiry, so a token the server rejected would otherwise
    // be sent again. recoverUnauthorized returns the token the app already holds when
    // it has replaced the rejected one, and refreshes only when the rejected token is
    // still current. A refresh that fails may be temporary and leaves the token valid,
    // so the follow reconnects with backoff, and the transport then uses that token. A
    // session with no token ends the follow, because the retry would carry no bearer.
    const refreshThenOpen = async (msg: string, rejectedToken: string | null) => {
      let token: string | null
      try {
        token = await recoverUnauthorized(rejectedToken)
      } catch {
        if (cancelled) return
        setError(msg)
        setConnected(false)
        scheduleReconnect()
        return
      }
      if (cancelled) return
      if (token === null) {
        setError("Your session could not be renewed. Sign in again to keep following the logs.")
        setConnected(false)
        setReconnecting(false)
        return
      }
      void open()
    }

    void open()
    return () => {
      cancelled = true
      abortRef.current?.abort()
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isActive,
    applicationNamespace,
    applicationName,
    resource.kind,
    resource.name,
    resource.namespace,
  ])

  // Filter is deferred so the input stays responsive on a large buffer.
  const deferredFilter = useDeferredValue(filter)
  const visible = useMemo(() => {
    const f = deferredFilter.trim().toLowerCase()
    if (!f) return lines
    return lines.filter((c) => c.line.toLowerCase().includes(f))
  }, [lines, deferredFilter])

  // A layout effect scrolls after each commit, before the browser can dispatch a
  // scroll event for the previous position against the taller log. It also runs when
  // the filter changes what is shown, so a followed view stays at the bottom.
  useLayoutEffect(() => {
    if (!following) return
    scrollToBottom()
  }, [lineCount, following, visible])

  if (error && lines.length === 0) {
    return (
      <div data-testid="logs-tab-error" className="py-12 text-center">
        <p role="alert" className="text-chip text-muted-foreground">
          {error}
        </p>
        {reconnecting ? (
          <p className="mt-1 font-mono text-meta text-neutral-600">reconnecting…</p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2" data-testid="logs-tab">
      <label htmlFor={filterId} className="sr-only">
        Filter log lines
      </label>
      <input
        id={filterId}
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter (case insensitive)"
        data-testid="logs-filter"
        className="h-8 w-full border border-rule bg-card px-2 text-note outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      />

      {error && lines.length > 0 ? (
        <p
          role="status"
          className="border border-status-degraded-line bg-status-degraded-fill px-2 py-1 text-meta text-status-degraded-text"
        >
          {error}
          {reconnecting ? " · reconnecting…" : ""}
        </p>
      ) : null}

      <div className="border border-rule bg-ink-surface">
        <div className="flex items-center gap-2 border-b border-ink-rule px-2.5 py-1.5">
          <span
            aria-hidden
            className={cn(
              "size-1.5 flex-none",
              connected ? "animate-blip bg-ink-accent" : "bg-ink-kicker"
            )}
          />
          <span className="font-mono text-meta text-ink-accent">
            {connected ? "live" : reconnecting ? "reconnecting…" : "idle"}
            {podName ? ` · pod/${podName}` : ""} · {lineCount} lines
          </span>
          <button
            ref={followToggleRef}
            type="button"
            aria-pressed={following}
            onClick={() => applyFollowing(!following)}
            data-testid="follow-toggle"
            className={`ml-auto border px-1.5 py-0.5 font-mono text-meta hover:text-ink-on focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-accent ${
              following
                ? "border-ink-accent bg-ink-accent/10 text-ink-accent"
                : "border-ink-rule text-ink-muted"
            }`}
          >
            Follow
          </button>
        </div>
        <div className="relative">
          <pre
            ref={preRef}
            data-testid="logs-output"
            aria-label="Resource logs"
            aria-live="off"
            onScroll={(e) => {
              const el = e.currentTarget
              const top = el.scrollTop
              const movedUp = top < lastScrollTopRef.current
              const movedDown = top > lastScrollTopRef.current
              lastScrollTopRef.current = top
              const atBottom = el.scrollHeight - top - el.clientHeight < 16
              // Only a move is a user's scroll. A scroll event for a clamp, or for
              // content that grew, keeps the follow state.
              if (movedUp && !atBottom && followingRef.current) applyFollowing(false)
              else if (movedDown && atBottom && !followingRef.current) applyFollowing(true)
            }}
            className="m-0 max-h-[60vh] min-h-[200px] overflow-auto p-2.5 font-mono text-note leading-[1.7] whitespace-pre-wrap text-log-text"
          >
            {visible.length === 0
              ? firstChunkAt == null
                ? "Waiting for first log line…"
                : "No matches."
              : visible.map((chunk, i) => (
                  <div key={`${chunk.timestampMs}-${i}`} className="flex gap-2">
                    <span className="flex-none text-ink-kicker tabular-nums select-none">
                      {formatTimestamp(chunk.timestampMs)}
                    </span>
                    <span className="min-w-0 flex-1 break-words">{chunk.line}</span>
                  </div>
                ))}
          </pre>
          {!following && lines.length > 0 ? (
            <button
              type="button"
              data-testid="jump-to-latest"
              onClick={() => {
                // The button unmounts once following is on, so focus moves to Follow first.
                followToggleRef.current?.focus()
                applyFollowing(true)
              }}
              className="absolute right-2 bottom-2 border border-ink-accent bg-ink-surface px-2 py-1 font-mono text-meta text-ink-accent hover:text-ink-on focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-accent"
            >
              Jump to latest{unseenCount > 0 ? ` · ${unseenCount} new` : ""}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function formatTimestamp(ms: bigint): string {
  if (!ms) return ""
  const d = new Date(Number(ms))
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`
  if (n < 100) return `0${n}`
  return `${n}`
}
