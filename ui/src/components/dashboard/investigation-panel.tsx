"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { createPromiseClient } from "@connectrpc/connect"
import { createTransport } from "@/lib/transport"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import type { InvestigateResponse } from "@/gen/paprika/v1/api_pb"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
  Terminal,
  X,
} from "lucide-react"

const transport = createTransport()
const client = createPromiseClient(PaprikaService, transport)

type Severity = "CRITICAL" | "WARNING" | "INFO" | "UNSPECIFIED"

const severityClass: Record<Severity, string> = {
  CRITICAL: "border-destructive/40 bg-destructive/10 text-destructive",
  WARNING: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  INFO: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  UNSPECIFIED: "border-muted/40 bg-muted/20 text-muted-foreground",
}

const severityLabel: Record<Severity, string> = {
  CRITICAL: "Critical",
  WARNING: "Warning",
  INFO: "Info",
  UNSPECIFIED: "Unknown",
}

export function InvestigationPanel({
  applicationNamespace,
  applicationName,
  resource,
  onClose,
}: {
  applicationNamespace: string
  applicationName: string
  resource: { kind: string; name: string; namespace: string }
  onClose: () => void
}) {
  const [data, setData] = useState<InvestigateResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<string | null>(null)
  const [expandedFindings, setExpandedFindings] = useState<Set<string>>(new Set())
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const requestGenerationRef = useRef(0)
  const requestControllerRef = useRef<AbortController | null>(null)

  const run = useCallback(async ({ resetIdentity = false }: { resetIdentity?: boolean } = {}) => {
    const generation = ++requestGenerationRef.current
    requestControllerRef.current?.abort()
    const controller = new AbortController()
    requestControllerRef.current = controller

    if (resetIdentity) {
      setData(null)
      setPlugins(null)
      setExpandedFindings(new Set())
    }
    setLoading(true)
    setError(null)

    const isCurrentRequest = () =>
      requestGenerationRef.current === generation &&
      requestControllerRef.current === controller &&
      !controller.signal.aborted

    try {
      const [res, pluginResponse] = await Promise.all([
        client.investigate(
          {
            applicationNamespace,
            applicationName,
            resourceKind: resource.kind,
            resourceName: resource.name,
            resourceNamespace: resource.namespace,
          },
          { signal: controller.signal },
        ),
        client.listInvestigatorPlugins({}, { signal: controller.signal }),
      ])

      if (!isCurrentRequest()) return

      const grouped: Record<string, string[]> = { source: [], detector: [], narrator: [] }
      for (const plug of pluginResponse.plugins) {
        grouped[plug.type]?.push(plug.name)
      }
      setPlugins(`${grouped.detector?.length ?? 0} detectors · ${grouped.source?.length ?? 0} sources`)
      setData(res)
    } catch (err) {
      if (!isCurrentRequest()) return
      setError(err instanceof Error ? err.message : "Failed to investigate")
    } finally {
      if (isCurrentRequest()) {
        requestControllerRef.current = null
        setLoading(false)
      }
    }
  }, [applicationNamespace, applicationName, resource.kind, resource.name, resource.namespace])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void run({ resetIdentity: true })
    }, 0)
    return () => {
      window.clearTimeout(timer)
      requestGenerationRef.current += 1
      requestControllerRef.current?.abort()
      requestControllerRef.current = null
    }
  }, [run])

  const sorted = (data?.findings ?? []).slice().sort((a, b) => {
    return severityRank(severityKey(Number(a.severity))) - severityRank(severityKey(Number(b.severity)))
  })

  return (
    <Dialog.Root open modal onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop
          forceRender
          data-testid="investigation-backdrop"
          className="fixed inset-0 z-[60] bg-foreground/30"
        />
        <Dialog.Popup
          aria-modal="true"
          initialFocus={closeButtonRef}
          finalFocus
          className="fixed right-0 top-0 z-[60] flex h-full w-full max-w-3xl flex-col border-l border-border bg-card"
          data-testid="investigation-panel"
        >
          <Dialog.Title className="sr-only">
            Investigation for {resource.kind}/{resource.name}
          </Dialog.Title>
          <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {loading
              ? "Running investigation"
              : error
                ? `Investigation failed: ${error}`
                : data
                  ? `Investigation complete${data.summary ? `: ${data.summary}` : ""}`
                  : ""}
          </p>
        <div className="flex items-start justify-between border-b border-border/40 px-6 py-4">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="size-5 text-foreground/80" aria-hidden />
              <span className="text-sm font-semibold">Investigation</span>
            </div>
            <div className="mt-1 font-mono text-xs text-muted-foreground">
              {resource.kind}/{resource.name}
            </div>
            {data && (
              <p className="mt-2 text-sm">
                <span
                  className={
                    sorted.length > 0
                      ? "font-medium text-foreground/90"
                      : "text-emerald-600 dark:text-emerald-400"
                  }
                >
                  {data.summary ?? ""}
                </span>
                {data.narrator && (
                  <span className="ml-2 text-xs text-muted-foreground">via {data.narrator}</span>
                )}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void run()}
              aria-label="Re-run investigation"
              data-testid="investigation-refresh"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground active:scale-[0.96]"
            >
              <RefreshCw className="size-4" />
            </button>
            <Dialog.Close
              ref={closeButtonRef}
              aria-label="Close investigation"
              data-testid="investigation-close"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground active:scale-[0.96]"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4">
          {loading && !data ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : sorted.length === 0 ? (
            <div
              data-testid="investigation-empty"
              className="flex flex-col items-center gap-2 py-12 text-center"
            >
              <CheckCircle2 className="size-8 text-emerald-500" />
              <p className="text-sm font-medium text-foreground/80">No issues detected</p>
              {data?.generatedAtMs && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  Scanned {countPlugins(plugins)} at{" "}
                  {new Date(Number(data.generatedAtMs)).toLocaleString()}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {sorted.map((f, i) => {
                const sevKey = severityKey(Number(f.severity))
                const sev = severityLabel[sevKey] ?? "Unknown"
                const isOpen = expandedFindings.has(f.id) || (i === 0 && sorted[0]?.id === f.id)
                return (
                  <article
                    key={f.id}
                    data-testid={`finding-${f.id}`}
                    className={`overflow-hidden rounded-lg border ${
                      severityClass[sevKey] ?? severityClass.UNSPECIFIED
                    }`}
                  >
                    <header className="flex items-start gap-3 px-3 py-2.5">
                      <span className="rounded-full bg-background/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide tabular-nums">
                        {sev}
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-medium">{f.title}</h3>
                        {f.description && (
                          <p className="mt-0.5 text-xs text-muted-foreground">{f.description}</p>
                        )}
                      </div>
                    </header>
                    {f.evidence && f.evidence.length > 0 && (
                      <button
                        onClick={() => {
                          setExpandedFindings((prev) => {
                            const next = new Set(prev)
                            if (next.has(f.id)) next.delete(f.id)
                            else next.add(f.id)
                            return next
                          })
                        }}
                        aria-expanded={isOpen}
                        className="flex w-full items-center justify-between border-t border-current/10 px-3 py-1.5 text-left text-xs transition-[background-color] hover:bg-background/40"
                      >
                        <span>
                          Evidence ({f.evidence.length})
                        </span>
                        <ChevronRight
                          className={`size-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
                        />
                      </button>
                    )}
                    {isOpen && f.evidence && f.evidence.length > 0 && (
                      <ul className="space-y-1 bg-background/30 px-3 py-2 text-xs">
                        {f.evidence.map((e, j) => (
                          <li
                            key={j}
                            className="rounded-md border border-border bg-background px-2 py-1 font-mono"
                          >
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
                              {e.source}
                            </span>
                            <span className="ml-2 text-foreground/80">{e.summary}</span>
                            {e.timestamp && (
                              <span className="ml-2 tabular-nums text-muted-foreground">
                                {e.timestamp}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {f.playbook && f.playbook.length > 0 && (
                      <div className="border-t border-current/10 bg-background/30 px-3 py-2">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                          Suggested fixes
                        </p>
                        <ul className="mt-1 space-y-1 text-xs text-foreground/80">
                          {f.playbook.map((step, k) => (
                            <li key={k} className="flex items-start gap-2">
                              <Terminal className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                              <code className="font-mono">{step}</code>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </div>

        {plugins && data && sorted.length > 0 && (
          <div
            data-testid="investigation-footer"
            className="border-t border-border/40 px-6 py-2 text-[10px] text-muted-foreground/80 tabular-nums"
          >
            {plugins}
            {data.narrator && ` · narrator: ${data.narrator}`}
          </div>
        )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function severityRank(sev: Severity): number {
  switch (sev) {
    case "CRITICAL":
      return 0
    case "WARNING":
      return 1
    case "INFO":
      return 2
    default:
      return 3
  }
}

// Severity is generated as a numeric enum from buf. Translate to our
// string-keys for clean switch/lookup semantics.
function severityKey(n: number): Severity {
  switch (n) {
    case 1:
      return "CRITICAL"
    case 2:
      return "WARNING"
    case 3:
      return "INFO"
    default:
      return "UNSPECIFIED"
  }
}

function countPlugins(p: string | null): string {
  return p ?? "—"
}

function AlertTriangleFallback() {
  return <AlertTriangle className="size-4" />
}
// silence unused
void AlertTriangleFallback
