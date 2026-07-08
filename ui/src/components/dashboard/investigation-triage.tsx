"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, CheckCircle2, Microscope, Play, SearchCheck, Terminal } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  mergeResourcesFromApplication,
  type MergedResource,
} from "@/components/dashboard/resource-list-table"

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
    <Card data-testid="investigation-triage">
      <CardHeader>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-balance">
              <SearchCheck className="size-5" />
              Investigation Triage
            </CardTitle>
            <CardDescription className="text-pretty">
              Degraded resources, failing checks, and manual investigation entry points for this application.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant={isApplicationUnhealthy(application) ? "destructive" : "secondary"}>
              {application.phase || "Unknown"}
            </Badge>
            <Badge variant={(application.outOfSync ?? 0) > 0 ? "destructive" : "secondary"}>
              <span className="tabular-nums">{application.outOfSync ?? 0}</span>&nbsp;out of sync
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {resources.length > 0 && (
          <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
            <div className="divide-y divide-foreground/5">
              {resources.map(({ resource, reasons }) => (
                <InvestigationResourceRow
                  key={resourceKey(resource)}
                  resource={resource}
                  reasons={reasons}
                  run={runs[resourceKey(resource)]}
                  onRun={() => void runInvestigation(resource, "manual")}
                  onSelectResource={onSelectResource}
                />
              ))}
            </div>
          </div>
        )}

        {supportingSignals.length > 0 && (
          <div className="rounded-xl bg-muted/20 p-3 ring-1 ring-foreground/10">
            <p className="mb-2 text-xs font-medium text-foreground/80">Additional signals</p>
            <div className="grid gap-2 md:grid-cols-2">
              {supportingSignals.map((signal) => (
                <div key={signal} className="flex items-start gap-2 rounded-lg bg-background px-2 py-2 text-xs ring-1 ring-foreground/10">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                  <span className="text-muted-foreground text-pretty">{signal}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
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
    <div className="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_12rem] lg:items-start">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Microscope className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-mono text-xs font-medium">{resource.kind}</span>
          <span className="min-w-0 truncate font-mono text-xs text-foreground">{resource.name}</span>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{resource.namespace || "cluster-scoped"}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge variant={resource.syncStatus === "Synced" ? "secondary" : "destructive"}>{resource.syncStatus || "Unknown"}</Badge>
          <Badge variant={resource.health === "Healthy" ? "secondary" : "destructive"}>{resource.health || "Unknown"}</Badge>
        </div>
      </div>
      <div className="space-y-2">
        <ul className="space-y-1">
          {reasons.map((reason) => (
            <li key={reason} className="text-xs text-muted-foreground text-pretty">
              {reason}
            </li>
          ))}
        </ul>
        <RunResult run={run} />
      </div>
      <div className="flex flex-wrap gap-2 lg:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Run investigation for ${resource.name}`}
          onClick={onRun}
          disabled={run?.loading}
          className="transition-[scale] active:scale-[0.96]"
        >
          <Play className="mr-1 size-3.5" />
          {run?.loading ? "Running" : "Run"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Open resource ${resource.name}`}
          onClick={() => onSelectResource(resource)}
          className="transition-[scale] active:scale-[0.96]"
        >
          Open
        </Button>
      </div>
    </div>
  )
}

function RunResult({ run }: { run?: RunState }) {
  if (!run) return null
  if (run.loading) {
    return <p className="text-xs text-muted-foreground">Investigation running</p>
  }
  if (run.error) {
    return <p className="text-xs text-destructive">{run.error}</p>
  }
  const findings = run.response?.findings ?? []
  return (
    <div className="rounded-lg bg-background p-2 text-xs ring-1 ring-foreground/10">
      <div className="flex items-start gap-2">
        {findings.length > 0 ? (
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        ) : (
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
        )}
        <div className="min-w-0">
          <p className="font-medium text-foreground/80">
            {run.response?.summary || (findings.length > 0 ? "Findings detected" : "No issues detected")}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {run.source === "auto" ? "Auto-run" : "Manual run"}
            {run.response?.narrator ? ` via ${run.response.narrator}` : ""}
          </p>
        </div>
      </div>
      {findings.length > 0 && (
        <div className="mt-2 space-y-2">
          {findings.map((finding) => (
            <div key={finding.id} className="rounded-md bg-muted/25 px-2 py-1.5">
              <p className="font-medium text-foreground/85">{finding.title}</p>
              {finding.description && (
                <p className="mt-0.5 text-muted-foreground text-pretty">{finding.description}</p>
              )}
              {finding.evidence && finding.evidence.length > 0 && (
                <div className="mt-1 space-y-1">
                  {finding.evidence.map((evidence, index) => (
                    <p key={`${evidence.source}-${index}`} className="font-mono text-[11px] text-muted-foreground">
                      {evidence.source}: {evidence.summary}
                    </p>
                  ))}
                </div>
              )}
              {finding.playbook && finding.playbook.length > 0 && (
                <div className="mt-1 space-y-1">
                  {finding.playbook.map((step) => (
                    <p key={step} className="flex gap-1 font-mono text-[11px] text-muted-foreground">
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
