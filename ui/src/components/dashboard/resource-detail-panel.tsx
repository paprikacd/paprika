"use client"

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { createPromiseClient } from "@connectrpc/connect"
import { createTransport } from "@/lib/transport"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import type { GetResourceResponse, KubernetesEvent, LogChunk } from "@/gen/paprika/v1/api_pb"
import { X, FileText, GitCompare, ListChecks, Loader2, CheckCircle2, AlertTriangle, Terminal, Pause, Play, Search, Wifi, WifiOff, Sparkles } from "lucide-react"
import { InvestigationPanel } from "@/components/dashboard/investigation-panel"
import { SyncDiffView } from "@/components/dashboard/sync-diff-view"

const transport = createTransport()
const client = createPromiseClient(PaprikaService, transport)

type Tab = "live" | "desired" | "diff" | "events" | "logs"

const tabs: { id: Tab; label: string; icon: typeof FileText }[] = [
  { id: "diff", label: "Diff", icon: GitCompare },
  { id: "live", label: "Live", icon: FileText },
  { id: "desired", label: "Desired", icon: FileText },
  { id: "events", label: "Events", icon: ListChecks },
  { id: "logs", label: "Logs", icon: Terminal },
]

const LOG_BUFFER_LIMIT = 5000
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000

export function ResourceDetailPanel({
  applicationNamespace,
  applicationName,
  resource,
  onClose,
}: {
  applicationNamespace: string
  applicationName: string
  resource: { kind: string; name: string; namespace: string; syncStatus: string; health: string; healthMessage: string }
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>("diff")
  const [data, setData] = useState<GetResourceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [investigationOpen, setInvestigationOpen] = useState(false)

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
          if (!cancelled) {
            setData(res)
            if (!res.diff && !res.liveManifest) {
              setTab("live")
            }
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load resource")
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      })
    return () => {
      cancelled = true
    }
  }, [applicationNamespace, applicationName, resource])

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-foreground/20 backdrop-blur-sm"
        onClick={onClose}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col bg-card shadow-2xl ring-1 ring-foreground/10">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-border/40 px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold">{resource.kind}</span>
              <span className="font-mono text-sm text-muted-foreground">/{resource.name}</span>
            </div>
            <div className="mt-1 flex items-center gap-3 text-xs">
              <span className="inline-flex items-center gap-1 text-muted-foreground tabular-nums">
                {resource.namespace}
              </span>
              <span className="text-muted-foreground">Sync: {resource.syncStatus || "-"}</span>
              <span className="text-muted-foreground">Health: {resource.health || "-"}</span>
            </div>
            {resource.healthMessage && (
              <p className="mt-1 text-xs text-muted-foreground">{resource.healthMessage}</p>
            )}
            {data && (
              <div className="mt-2 flex max-w-xl flex-wrap gap-1.5">
                {data.apiVersion && (
                  <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {data.apiVersion}
                  </span>
                )}
                {data.resource && (
                  <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {data.resource}
                  </span>
                )}
                {data.uid && (
                  <span className="max-w-48 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {data.uid}
                  </span>
                )}
                {Object.entries(data.labels ?? {}).slice(0, 3).map(([key, value]) => (
                  <span
                    key={key}
                    className="max-w-64 truncate rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary"
                  >
                    {key}={value}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setInvestigationOpen(true)}
              aria-label="Investigate"
              data-testid="open-investigation"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-foreground/80 transition-[color,background-color] hover:bg-muted/40"
            >
              <Sparkles className="size-3.5" />
              Investigate
            </button>
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground transition-[color,box-shadow] hover:text-foreground active:scale-[0.96]"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border/40 px-4">
          {tabs.map((t) => {
            const Icon = t.icon
            const isActive = tab === t.id
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-[color,box-shadow] ${
                  isActive ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="size-3.5" />
                {t.label}
              </button>
            )
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto px-6 py-4">
          {tab === "logs" ? (
            <LogsTab
              applicationNamespace={applicationNamespace}
              applicationName={applicationName}
              resource={resource}
              isActive={tab === "logs"}
            />
          ) : loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : !data ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No data available.</p>
          ) : tab === "live" ? (
            <ManifestView manifest={data.liveManifest} label="Live Manifest" />
          ) : tab === "desired" ? (
            <ManifestView manifest={data.desiredManifest} label="Desired Manifest" />
          ) : tab === "diff" ? (
            <SyncDiffView diff={data.diff} />
           ) : (
            <EventsView events={data.events} />
          )}
        </div>
      </aside>
      {investigationOpen && (
        <InvestigationPanel
          applicationNamespace={applicationNamespace}
          applicationName={applicationName}
          resource={resource}
          onClose={() => setInvestigationOpen(false)}
        />
      )}
    </>
  )
}

function ManifestView({ manifest, label }: { manifest: string; label: string }) {
  if (!manifest) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <FileText className="size-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{label} not available</p>
      </div>
    )
  }
  return (
    <pre className="overflow-auto rounded-lg bg-background p-4 font-mono text-xs leading-relaxed text-foreground/90 ring-1 ring-foreground/10">
      {manifest}
    </pre>
  )
}

function EventsView({ events }: { events: KubernetesEvent[] }) {
  if (!events || events.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <ListChecks className="size-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No recent events.</p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {events.map((e, i) => {
        const isWarning = e.type === "Warning"
        return (
          <div key={i} className="flex items-start gap-3 rounded-lg bg-muted/30 px-3 py-2.5 ring-1 ring-foreground/5">
            {isWarning ? (
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            ) : (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{e.reason}</span>
                {e.count > 1 && (
                  <span className="text-[10px] text-muted-foreground tabular-nums">x{e.count}</span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{e.message}</p>
              {e.lastTimestamp && (
                <p className="mt-0.5 text-[10px] text-muted-foreground/60 tabular-nums">{e.lastTimestamp}</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
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
  }, [isActive, applicationNamespace, applicationName, resource.kind, resource.name, resource.namespace])

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
            const next = prev.length >= LOG_BUFFER_LIMIT ? prev.slice(prev.length - LOG_BUFFER_LIMIT + 1) : prev
            next.push(chunk)
            return next
          })
          setLineCount((c) => c + 1)
          if (firstChunkAt == null) setFirstChunkAt(Date.now())
        }
        // Normal completion (EOF or end of follow=false): close cleanly.
        if (!cancelled) {
          setConnected(false)
        }
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        console.warn("StreamResourceLogs error:", msg)
        if (err && typeof err === "object" && "code" in err) {
          // Unimplemented on agent/repo-server: don't keep trying.
          const code = (err as { code: unknown }).code
          if (typeof code === "string" && code.includes("unimplemented")) {
            setError("Streaming logs not available on this server. Falling back to polling.")
            setConnected(false)
            setReconnecting(false)
            return
          }
        }
        setError(msg)
        setConnected(false)
        // Exponential backoff reconnect
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
  }, [isActive, applicationNamespace, applicationName, resource.kind, resource.name, resource.namespace])

  // Filter is debounced via useDeferredValue so input stays responsive even
  // when the buffered set is large.
  const deferredFilter = useDeferredValue(filter)
  const visible = useMemo(() => {
    const f = deferredFilter.trim().toLowerCase()
    if (!f) return lines
    return lines.filter((c) => c.line.toLowerCase().includes(f))
  }, [lines, deferredFilter])

  // Auto-scroll to bottom unless the user has scrolled up. Only attempt
  // autoscroll when the log buffer (length) actually changes, so React
  // re-renders triggered by the filter don't snap-scroll.
  useEffect(() => {
    if (paused) return
    if (userScrolledAwayRef.current) return
    const pre = preRef.current
    if (!pre) return
    pre.scrollTop = pre.scrollHeight
  }, [lineCount, paused])

  if (error && lines.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center" data-testid="logs-tab-error">
        <AlertTriangle className="size-5 text-amber-500" />
        <p className="text-sm text-muted-foreground">{error}</p>
        {reconnecting && <p className="text-xs text-muted-foreground/60 tabular-nums">reconnecting…</p>}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2" data-testid="logs-tab">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ConnectionDot connected={connected} reconnecting={reconnecting} />
        <span className="tabular-nums">{connected ? "live" : reconnecting ? "reconnecting…" : "idle"}</span>
        {podName && (
          <span className="font-mono text-muted-foreground">
            · pod/<span className="text-foreground/80">{podName}</span>
          </span>
        )}
        <span className="tabular-nums">· {lineCount} lines</span>
        <button
          onClick={() => {
            const next = !paused
            setPaused(next)
            if (!next) {
              // Unpausing: snap to bottom on next render.
              userScrolledAwayRef.current = false
            }
          }}
          aria-label={paused ? "Resume follow" : "Pause follow"}
          data-testid="pause-toggle"
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 transition-[color,background-color] hover:bg-muted/40"
        >
          {paused ? (
            <>
              <Play className="size-3" />
              Resume
            </>
          ) : (
            <>
              <Pause className="size-3" />
              Pause
            </>
          )}
        </button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter (case insensitive) - pause to inspect"
          data-testid="logs-filter"
          className="w-full rounded-md bg-background py-1 pl-7 pr-3 text-xs text-foreground/90 ring-1 ring-foreground/10 outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/40 focus:ring-foreground/30"
        />
      </div>

      {error && lines.length > 0 && (
        <div className="flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-[10px] text-amber-600">
          <AlertTriangle className="size-3" />
          <span className="truncate">{error}</span>
          {reconnecting && <span className="ml-auto opacity-60">reconnecting…</span>}
        </div>
      )}

      <pre
        ref={preRef}
        data-testid="logs-output"
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16
          userScrolledAwayRef.current = !atBottom
        }}
        className="max-h-[60vh] min-h-[200px] flex-1 overflow-auto whitespace-pre-wrap rounded-lg bg-background p-4 font-mono text-xs leading-relaxed ring-1 ring-foreground/10"
      >
        {visible.length === 0 ? (
          <span className="text-muted-foreground/40 italic">
            {firstChunkAt == null
              ? "Waiting for first log line…"
              : "No matches."}
          </span>
        ) : (
          visible.map((chunk, i) => (
            <div key={`${chunk.timestampMs}-${i}`} className="flex gap-2">
              <span className="select-none whitespace-nowrap text-muted-foreground/40 tabular-nums">
                {formatTimestamp(chunk.timestampMs)}
              </span>
              <span className="min-w-0 flex-1 break-words">{chunk.line}</span>
            </div>
          ))
        )}
      </pre>
    </div>
  )
}

function ConnectionDot({ connected, reconnecting }: { connected: boolean; reconnecting: boolean }) {
  const live = connected
  return (
    <span className="relative flex size-2">
      {live ? (
        <>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </>
      ) : reconnecting ? (
        <>
          <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-amber-500/40" />
          <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
        </>
      ) : (
        <>
          <WifiOff className="size-3 text-muted-foreground/60" />
        </>
      )}
      {!connected && !reconnecting ? null : null}
      {live || reconnecting ? null : <Wifi className="hidden" />}
    </span>
  )
}

function formatTimestamp(ms: bigint): string {
  if (!ms) return ""
  const n = Number(ms)
  const d = new Date(n)
  // Compact HH:MM:SS.mmm is easier to skim than full RFC3339.
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
