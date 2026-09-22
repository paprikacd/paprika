"use client"

import { useEffect, useState } from "react"
import { createPromiseClient } from "@connectrpc/connect"
import { createTransport } from "@/lib/transport"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import type { InvestigateResponse } from "@/gen/paprika/v1/api_pb"
import {
  CheckCircle2,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
  Terminal,
  X,
} from "lucide-react"

import { StatusGlyph } from "@/components/ui/status-chip"
import { STATUS_TONES, type StatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

const transport = createTransport()
const client = createPromiseClient(PaprikaService, transport)

type Severity = "CRITICAL" | "WARNING" | "INFO" | "UNSPECIFIED"

const severityTone: Record<Severity, StatusTone> = {
  CRITICAL: "failed",
  WARNING: "degraded",
  INFO: "progressing",
  UNSPECIFIED: "unknown",
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

  const run = async () => {
    setLoading(true)
    setError(null)
    try {
      const [res] = await Promise.all([
        client.investigate({
          applicationNamespace,
          applicationName,
          resourceKind: resource.kind,
          resourceName: resource.name,
          resourceNamespace: resource.namespace,
        }),
        client.listInvestigatorPlugins({}).then((p) => {
          const grouped: Record<string, string[]> = { source: [], detector: [], narrator: [] }
          for (const plug of p.plugins) {
            grouped[plug.type]?.push(plug.name)
          }
          setPlugins(`${grouped.detector?.length ?? 0} detectors · ${grouped.source?.length ?? 0} sources`)
        }),
      ])
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to investigate")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void run()
    }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationNamespace, applicationName, resource.kind, resource.name, resource.namespace])

  const sorted = (data?.findings ?? []).slice().sort((a, b) => {
    return severityRank(severityKey(Number(a.severity))) - severityRank(severityKey(Number(b.severity)))
  })

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-sm"
        onClick={onClose}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Investigation of ${resource.kind} ${resource.name}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose()
        }}
        className="fixed inset-y-0 right-0 z-[63] flex w-[640px] max-w-full flex-col border-l border-rule-strong bg-background shadow-drawer"
        data-testid="investigation-panel"
      >
        <div className="flex items-start justify-between border-b border-rule bg-card px-4 py-3">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-muted-foreground" aria-hidden />
              <h2 className="font-cond text-card font-semibold tracking-[0.05em] uppercase">
                Investigation
              </h2>
            </div>
            <p className="mt-1 font-mono text-meta text-neutral-600">
              {resource.kind}/{resource.name}
            </p>
            {data && (
              <p className="mt-2 text-chip">
                <span
                  className={
                    sorted.length > 0
                      ? "font-semibold text-foreground"
                      : "text-status-healthy-text"
                  }
                >
                  {data.summary ?? ""}
                </span>
                {data.narrator && (
                  <span className="ml-2 text-note text-muted-foreground">
                    via {data.narrator}
                  </span>
                )}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={run}
              aria-label="Re-run investigation"
              data-testid="investigation-refresh"
              className="inline-flex size-[26px] items-center justify-center border border-rule bg-card text-muted-foreground hover:bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <RefreshCw className="size-3.5" />
            </button>
            <button
              onClick={onClose}
              aria-label="Close investigation"
              data-testid="investigation-close"
              className="rounded-md p-1.5 text-muted-foreground transition-[color,box-shadow] hover:text-foreground active:scale-[0.96]"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3.5">
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
              <CheckCircle2 className="size-6 text-status-healthy-text" />
              <p className="text-chip font-semibold">No issues detected</p>
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
                    className={cn(
                      "border",
                      STATUS_TONES[severityTone[sevKey] ?? "unknown"].line,
                      STATUS_TONES[severityTone[sevKey] ?? "unknown"].fill
                    )}
                  >
                    <header className="flex items-start gap-2.5 px-3 py-2.5">
                      <StatusGlyph
                        tone={severityTone[sevKey] ?? "unknown"}
                        label={`${sev} finding`}
                      />
                      <div className="min-w-0 flex-1">
                        <h3 className="text-chip font-semibold">{f.title}</h3>
                        {f.description && (
                          <p className="mt-0.5 text-note text-muted-foreground">
                            {f.description}
                          </p>
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
                        className="flex w-full items-center justify-between border-t border-rule-soft px-3 py-1.5 text-left text-note hover:bg-background/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
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
                      <ul className="list-none space-y-1 bg-background/40 px-3 py-2 text-note">
                        {f.evidence.map((e, j) => (
                          <li
                            key={j}
                            className="border border-rule-faint bg-card px-2 py-1 font-mono"
                          >
                            <span className="text-meta tracking-[0.08em] text-neutral-600 uppercase">
                              {e.source}
                            </span>
                            <span className="ml-2">{e.summary}</span>
                            {e.timestamp && (
                              <span className="ml-2 text-muted-foreground tabular-nums">
                                {e.timestamp}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {f.playbook && f.playbook.length > 0 && (
                      <div className="border-t border-rule-soft bg-background/40 px-3 py-2">
                        <p className="font-mono text-kicker tracking-[0.14em] text-muted-foreground uppercase">
                          Suggested fixes
                        </p>
                        <ul className="mt-1 list-none space-y-1 text-note">
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
            className="border-t border-rule px-4 py-2 font-mono text-meta text-muted-foreground tabular-nums"
          >
            {plugins}
            {data.narrator && ` · narrator: ${data.narrator}`}
          </div>
        )}
      </aside>
    </>
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

