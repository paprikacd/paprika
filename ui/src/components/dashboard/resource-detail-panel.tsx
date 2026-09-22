"use client"

import { createPromiseClient } from "@connectrpc/connect"
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react"

import { InvestigationPanel } from "@/components/dashboard/investigation-panel"
import {
  resourceHealthTone,
  resourceSyncLabel,
  resourceSyncTone,
} from "@/components/dashboard/resource-list-table"
import { parseUnifiedDiff, summarizeUnifiedDiff } from "@/components/dashboard/sync-diff-view"
import { StatusGlyph } from "@/components/ui/status-chip"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import type {
  GetResourceResponse,
  KubernetesEvent,
  LogChunk,
} from "@/gen/paprika/v1/api_pb"
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
  const [data, setData] = useState<GetResourceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [investigationOpen, setInvestigationOpen] = useState(false)
  const titleId = useId()
  const drawerRef = useRef<HTMLElement | null>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setLoading(true)
      setError(null)
      client
        .getResource({
          applicationNamespace,
          applicationName,
          resourceKind: resource.kind,
          resourceName: resource.name,
          resourceNamespace: resource.namespace,
        })
        .then((res) => {
          if (cancelled) return
          setData(res)
          // Nothing to diff against — land on the manifest instead of an
          // empty frame.
          if (!res.diff && !res.liveManifest) setTab("live")
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "Failed to load resource")
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    })
    return () => {
      cancelled = true
    }
  }, [applicationNamespace, applicationName, resource])

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

  const onTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = TABS.length - 1
    let next = -1
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = last
    if (next === -1) return
    event.preventDefault()
    setTab(TABS[next].id)
    tabRefs.current[next]?.focus()
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

        <div
          role="tablist"
          aria-label="Resource inspector views"
          className="flex border-b border-rule bg-card px-4"
        >
          {TABS.map((t, index) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[index] = el
              }}
              type="button"
              role="tab"
              id={`inspector-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="inspector-panel"
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={cn(
                "border-b-2 px-3 py-2.5 text-chip focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                tab === t.id
                  ? "border-primary font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div
          id="inspector-panel"
          role="tabpanel"
          aria-labelledby={`inspector-tab-${tab}`}
          tabIndex={0}
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
        </div>
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

function DiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  const summary = useMemo(() => summarizeUnifiedDiff(diff), [diff])
  const changed = summary.additions + summary.deletions

  if (lines.length === 0) {
    return (
      <p className="py-12 text-center text-chip text-muted-foreground">
        No differences — live matches desired.
      </p>
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
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState("")
  const [lineCount, setLineCount] = useState(0)
  const [firstChunkAt, setFirstChunkAt] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const preRef = useRef<HTMLPreElement | null>(null)
  const userScrolledAwayRef = useRef(false)
  const filterId = useId()

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
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const open = async () => {
      if (cancelled) return
      const controller = new AbortController()
      abortRef.current = controller
      setReconnecting(true)
      try {
        const iter = client.streamResourceLogs({
          applicationNamespace,
          applicationName,
          resourceKind: resource.kind,
          resourceName: resource.name,
          resourceNamespace: resource.namespace,
          follow: true,
        })
        const reader = iter[Symbol.asyncIterator]()
        while (!cancelled) {
          const { value, done } = await reader.next()
          if (done) break
          const chunk = value as LogChunk
          // Bail out if the caller (tab switch / unmount / explicit cancel)
          // aborted the stream while we were waiting.
          if (controller.signal.aborted) break
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
          if (firstChunkAt == null) setFirstChunkAt(Date.now())
        }
        // Normal completion (EOF or end of follow=false): close cleanly.
        if (!cancelled) setConnected(false)
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        console.warn("StreamResourceLogs error:", msg)
        if (err && typeof err === "object" && "code" in err) {
          // Unimplemented on agent/repo-server: don't keep trying.
          const code = (err as { code: unknown }).code
          if (typeof code === "string" && code.includes("unimplemented")) {
            setError("Streaming logs are not available on this server.")
            setConnected(false)
            setReconnecting(false)
            return
          }
        }
        setError(msg)
        setConnected(false)
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS)
        attempt++
        setReconnecting(true)
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          void open()
        }, delay)
      }
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

  useEffect(() => {
    if (paused) return
    if (userScrolledAwayRef.current) return
    const pre = preRef.current
    if (!pre) return
    pre.scrollTop = pre.scrollHeight
  }, [lineCount, paused])

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
            type="button"
            onClick={() => {
              const next = !paused
              setPaused(next)
              if (!next) userScrolledAwayRef.current = false
            }}
            data-testid="pause-toggle"
            className="ml-auto font-mono text-meta text-ink-muted hover:text-ink-on focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-accent"
          >
            {paused ? "resume" : "pause"}
          </button>
        </div>
        <pre
          ref={preRef}
          data-testid="logs-output"
          aria-label="Resource logs"
          aria-live="off"
          onScroll={(e) => {
            const el = e.currentTarget
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16
            userScrolledAwayRef.current = !atBottom
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
