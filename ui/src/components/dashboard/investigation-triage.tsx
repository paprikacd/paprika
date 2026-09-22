"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Microscope, Play, Terminal } from "lucide-react"

import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusGlyph, StatusPill } from "@/components/ui/status-chip"
import {
  mergeResourcesFromApplication,
  resourceHealthTone,
  resourceSyncLabel,
  resourceSyncTone,
  type MergedResource,
} from "@/components/dashboard/resource-list-table"
import { STATUS_TONES } from "@/lib/status-tone"

interface InvestigationApplicationLike {
  name: string
  namespace: string
  phase?: string
  health?: string
  outOfSync?: number
  resources?: { kind: string; name: string; namespace: string; status: string }[]
  resourceHealth?: { kind: string; name: string; namespace: string; health: string; message: string }[]
  healthChecks?: { name: string; status: string; message: string; httpStatusCode: number }[]
  gates?: { name: string; status: string; message: string }[]
  conditions?: { type: string; status: string; reason: string; message: string }[]
  analysisResults?: { name: string; phase: string; passed: boolean; message: string }[]
}

interface InvestigationFindingLike {
  id: string
  severity: number
  title: string
  description?: string
  evidence?: { source: string; timestamp?: string; summary: string }[]
  playbook?: string[]
}

interface InvestigationResponseLike {
  findings?: InvestigationFindingLike[]
  summary?: string
  narrator?: string
  generatedAtMs?: bigint | number
}

interface RunState {
  loading: boolean
  error?: string
  source?: "auto" | "manual"
  response?: InvestigationResponseLike
}

type InvestigateFn = (resource: MergedResource) => Promise<InvestigationResponseLike>

export function InvestigationTriage({
  application,
  investigate,
  onSelectResource,
}: {
  application: InvestigationApplicationLike
  investigate: InvestigateFn
  onSelectResource: (resource: MergedResource) => void
}) {
  const autoRuns = useRef(new Set<string>())
  const [runs, setRuns] = useState<Record<string, RunState>>({})
  const resources = useMemo(() => rankInvestigationResources(application), [application])
  const topResource = resources[0]?.resource
  const supportingSignals = useMemo(() => collectSupportingSignals(application), [application])
  const shouldAutoRun = isApplicationUnhealthy(application) && Boolean(topResource)
  const autoSignature = topResource
    ? `${application.namespace}/${application.name}/${application.phase}/${application.health}/${application.outOfSync}/${resourceKey(topResource)}/${topResource.health}/${topResource.syncStatus}`
    : ""

  const runInvestigation = useCallback(
    async (resource: MergedResource, source: "auto" | "manual") => {
      const key = resourceKey(resource)
      setRuns((prev) => ({ ...prev, [key]: { loading: true, source } }))
      try {
        const response = await investigate(resource)
        setRuns((prev) => ({ ...prev, [key]: { loading: false, response, source } }))
      } catch (err) {
        setRuns((prev) => ({
          ...prev,
          [key]: {
            loading: false,
            error: err instanceof Error ? err.message : "Investigation failed",
            source,
          },
        }))
      }
    },
    [investigate],
  )

  useEffect(() => {
    if (!shouldAutoRun || !topResource || autoRuns.current.has(autoSignature)) return
    autoRuns.current.add(autoSignature)
    void runInvestigation(topResource, "auto")
  }, [autoSignature, runInvestigation, shouldAutoRun, topResource])

  if (resources.length === 0 && supportingSignals.length === 0) {
    return null
  }

  return (
    <Blueprint data-testid="investigation-triage">
      <BoardHeader
        title="Investigation triage"
        meta={`${resources.length} flagged · ${application.outOfSync ?? 0} out of sync`}
      />
      {resources.length > 0 ? (
        <ul className="list-none">
          {resources.map(({ resource, reasons }) => (
            <li key={resourceKey(resource)} className="border-b border-rule-soft">
              <InvestigationResourceRow
                resource={resource}
                reasons={reasons}
                run={runs[resourceKey(resource)]}
                onRun={() => void runInvestigation(resource, "manual")}
                onSelectResource={onSelectResource}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {supportingSignals.length > 0 ? (
        <div className="px-3.5 py-3">
          <p className="font-mono text-kicker tracking-[0.14em] text-muted-foreground uppercase">
            Additional signals
          </p>
          <ul className="mt-1.5 grid list-none gap-1.5 md:grid-cols-2">
            {supportingSignals.map((signal) => (
              <li
                key={signal}
                className="flex items-start gap-2 border border-rule-faint bg-inset px-2 py-1.5 text-note"
              >
                <StatusGlyph tone="degraded" label="Signal" />
                <span className="text-muted-foreground">{signal}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Blueprint>
  )
}

function InvestigationResourceRow({
  resource,
  reasons,
  run,
  onRun,
  onSelectResource,
}: {
  resource: MergedResource
  reasons: string[]
  run?: RunState
  onRun: () => void
  onSelectResource: (resource: MergedResource) => void
}) {
  return (
    <div className="grid gap-3 px-3.5 py-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_12rem] lg:items-start">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Microscope className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="font-mono text-kicker tracking-[0.08em] text-neutral-600">
            {resource.kind.toUpperCase()}
          </span>
          <span className="min-w-0 truncate font-cond text-label font-semibold">
            {resource.name}
          </span>
        </div>
        <p className="mt-1 truncate font-mono text-meta text-muted-foreground">
          {resource.namespace || "cluster-scoped"}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <StatusPill
            tone={resourceHealthTone(resource.health)}
            label={STATUS_TONES[resourceHealthTone(resource.health)].label}
          />
          <StatusPill
            tone={resourceSyncTone(resource.syncStatus)}
            label={resourceSyncLabel(resource.syncStatus)}
          />
        </div>
      </div>
      <div className="space-y-2">
        <ul className="list-none space-y-1">
          {reasons.map((reason) => (
            <li key={reason} className="text-note text-muted-foreground">
              {reason}
            </li>
          ))}
        </ul>
        <RunResult run={run} />
      </div>
      <div className="flex flex-wrap gap-1.5 lg:justify-end">
        <button
          type="button"
          aria-label={`Run investigation for ${resource.name}`}
          onClick={onRun}
          disabled={run?.loading}
          className="inline-flex h-11 items-center gap-1 border border-rule bg-card px-2.5 text-note hover:bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Play className="size-3" aria-hidden />
          {run?.loading ? "Running" : "Run"}
        </button>
        <button
          type="button"
          aria-label={`Open resource ${resource.name}`}
          onClick={() => onSelectResource(resource)}
          className="inline-flex h-11 items-center border border-rule bg-card px-2.5 text-note hover:bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Open
        </button>
      </div>
    </div>
  )
}

function RunResult({ run }: { run?: RunState }) {
  if (!run) return null
  if (run.loading) {
    return (
      <p role="status" className="text-note text-muted-foreground">
        Investigation running
      </p>
    )
  }
  if (run.error) {
    return (
      <p role="alert" className="text-note text-status-failed-text">
        {run.error}
      </p>
    )
  }
  const findings = run.response?.findings ?? []
  return (
    <div className="border border-rule-faint bg-inset p-2 text-note">
      <div className="flex items-start gap-2">
        <StatusGlyph
          tone={findings.length > 0 ? "degraded" : "healthy"}
          label={findings.length > 0 ? "Findings detected" : "No issues detected"}
        />
        <div className="min-w-0">
          <p className="font-semibold">
            {run.response?.summary || (findings.length > 0 ? "Findings detected" : "No issues detected")}
          </p>
          <p className="mt-0.5 text-note text-muted-foreground">
            {run.source === "auto" ? "Auto-run" : "Manual run"}
            {run.response?.narrator ? ` via ${run.response.narrator}` : ""}
          </p>
        </div>
      </div>
      {findings.length > 0 && (
        <div className="mt-2 space-y-2">
          {findings.map((finding) => (
            <div key={finding.id} className="border border-rule-faint bg-card px-2 py-1.5">
              <p className="font-semibold">{finding.title}</p>
              {finding.description && (
                <p className="mt-0.5 text-muted-foreground text-pretty">{finding.description}</p>
              )}
              {finding.evidence && finding.evidence.length > 0 && (
                <div className="mt-1 space-y-1">
                  {finding.evidence.map((evidence, index) => (
                    <p key={`${evidence.source}-${index}`} className="font-mono text-note text-muted-foreground">
                      {evidence.source}: {evidence.summary}
                    </p>
                  ))}
                </div>
              )}
              {finding.playbook && finding.playbook.length > 0 && (
                <div className="mt-1 space-y-1">
                  {finding.playbook.map((step) => (
                    <p key={step} className="flex gap-1 font-mono text-note text-muted-foreground">
                      <Terminal className="mt-0.5 size-3 shrink-0" />
                      <span>{step}</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function rankInvestigationResources(application: InvestigationApplicationLike) {
  const rows = mergeResourcesFromApplication(application)
  return rows
    .map((resource) => ({
      resource,
      reasons: reasonsForResource(resource),
      priority: priorityForResource(resource),
    }))
    .filter((row) => row.reasons.length > 0)
    .sort((a, b) => a.priority - b.priority || a.resource.kind.localeCompare(b.resource.kind) || a.resource.name.localeCompare(b.resource.name))
}

function reasonsForResource(resource: MergedResource) {
  const reasons: string[] = []
  if (["Degraded", "Failed"].includes(resource.health)) {
    reasons.push(resource.healthMessage || `${resource.kind} reports ${resource.health}`)
  }
  if (resource.syncStatus && resource.syncStatus !== "Synced") {
    reasons.push(`Sync status is ${resource.syncStatus}`)
  }
  return reasons
}

function priorityForResource(resource: MergedResource) {
  if (["Degraded", "Failed"].includes(resource.health)) return 0
  if (resource.syncStatus === "Missing") return 1
  if (resource.syncStatus === "OutOfSync") return 2
  if (resource.syncStatus === "Pruned") return 3
  return 10
}

function collectSupportingSignals(application: InvestigationApplicationLike) {
  const signals: string[] = []
  for (const check of application.healthChecks ?? []) {
    if (check.status && check.status !== "Healthy") {
      signals.push(`Health check ${check.name}: ${check.message || check.status}`)
    }
  }
  for (const gate of application.gates ?? []) {
    if (["Rejected", "Failed", "Blocked"].includes(gate.status)) {
      signals.push(`Gate ${gate.name}: ${gate.message || gate.status}`)
    }
  }
  for (const condition of application.conditions ?? []) {
    if (condition.status === "False" || condition.status === "Unknown") {
      signals.push(`Condition ${condition.type}: ${condition.message || condition.reason}`)
    }
  }
  for (const result of application.analysisResults ?? []) {
    if (!result.passed) {
      signals.push(`Analysis ${result.name}: ${result.message || result.phase}`)
    }
  }
  return signals
}

function isApplicationUnhealthy(application: InvestigationApplicationLike) {
  return (
    ["Degraded", "Failed", "Error"].includes(application.phase ?? "") ||
    ["Degraded", "Failed"].includes(application.health ?? "") ||
    (application.outOfSync ?? 0) > 0
  )
}

function resourceKey(resource: MergedResource) {
  return `${resource.kind}/${resource.namespace}/${resource.name}`
}
