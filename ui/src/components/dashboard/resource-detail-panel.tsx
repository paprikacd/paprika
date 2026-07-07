"use client"

import { useEffect, useRef, useState } from "react"
import { createPromiseClient } from "@connectrpc/connect"
import { createTransport } from "@/lib/transport"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import type { GetResourceResponse, GetResourceLogsResponse, KubernetesEvent } from "@/gen/paprika/v1/api_pb"
import { X, FileText, GitCompare, ListChecks, Loader2, CheckCircle2, AlertTriangle, Terminal, RefreshCw } from "lucide-react"

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

const LOG_POLL_INTERVAL_MS = 5000

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

  useEffect(() => {
    let cancelled = false
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
              <span className="text-muted-foreground">Sync: {resource.syncStatus || "—"}</span>
              <span className="text-muted-foreground">Health: {resource.health || "—"}</span>
            </div>
            {resource.healthMessage && (
              <p className="mt-1 text-xs text-muted-foreground">{resource.healthMessage}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground transition-[color,box-shadow] hover:text-foreground active:scale-[0.96]"
          >
            <X className="size-4" />
          </button>
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
            <DiffView diff={data.diff} />
          ) : (
            <EventsView events={data.events} />
          )}
        </div>
      </aside>
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

function DiffView({ diff }: { diff: string }) {
  if (!diff) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <CheckCircle2 className="size-5 text-emerald-500" />
        <p className="text-sm text-muted-foreground">No differences — live manifest matches desired.</p>
      </div>
    )
  }
  const lines = diff.split("\n")
  return (
    <pre className="overflow-auto rounded-lg bg-background p-4 font-mono text-xs leading-relaxed ring-1 ring-foreground/10">
      {lines.map((line, i) => {
        let className = "text-muted-foreground"
        if (line.startsWith("+++") || line.startsWith("---")) className = "text-foreground font-medium"
        else if (line.startsWith("@@")) className = "text-primary"
        else if (line.startsWith("+")) className = "text-emerald-500 bg-emerald-500/10"
        else if (line.startsWith("-")) className = "text-destructive bg-destructive/10"
        return (
          <div key={i} className={`px-2 ${className}`}>
            {line || "\u00a0"}
          </div>
        )
      })}
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
  const [data, setData] = useState<GetResourceLogsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastFetched, setLastFetched] = useState<number | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchLogs = async () => {
    try {
      const res = await client.getResourceLogs({
        applicationNamespace,
        applicationName,
        resourceKind: resource.kind,
        resourceName: resource.name,
        resourceNamespace: resource.namespace,
        tailLines: 100,
      })
      setData(res)
      setLastFetched(Date.now())
    } catch (err) {
      console.warn("getResourceLogs failed:", err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!isActive) return
    setLoading(true)
    fetchLogs()
    intervalRef.current = setInterval(fetchLogs, LOG_POLL_INTERVAL_MS)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, applicationNamespace, applicationName, resource.kind, resource.name, resource.namespace])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <Terminal className="size-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No log data.</p>
      </div>
    )
  }

  if (data.error) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <AlertTriangle className="size-5 text-amber-500" />
        <p className="text-sm text-muted-foreground">{data.error}</p>
        <button
          onClick={fetchLogs}
          className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-foreground/80 transition-[color,background-color] hover:bg-muted/40"
        >
          <RefreshCw className="size-3" />
          Retry
        </button>
      </div>
    )
  }

  if (!data.logs) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <Terminal className="size-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No log output yet.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2" data-testid="logs-tab">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="relative flex size-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </span>
        <span className="tabular-nums">Auto-refreshing every {LOG_POLL_INTERVAL_MS / 1000}s</span>
        {lastFetched && <span className="tabular-nums">· updated {relativeTime(lastFetched)}</span>}
        {data.podName && (
          <span className="font-mono text-muted-foreground">
            · pod/<span className="text-foreground/80">{data.podName}</span>
          </span>
        )}
        <button
          onClick={fetchLogs}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 transition-[color,background-color] hover:bg-muted/40"
        >
          <RefreshCw className="size-3" />
          Refresh
        </button>
      </div>
      <pre
        data-testid="logs-output"
        className="max-h-[60vh] overflow-auto rounded-lg bg-background p-4 font-mono text-xs leading-relaxed ring-1 ring-foreground/10"
      >
        {data.logs}
      </pre>
    </div>
  )
}

function relativeTime(ms: number): string {
  const elapsed = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (elapsed < 1) return "just now"
  if (elapsed < 60) return `${elapsed}s ago`
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`
  return `${Math.floor(elapsed / 3600)}h ago`
}
