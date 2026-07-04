import { useState } from "react"
import Link from "next/link"
import type { Application, PolicyResult, Release } from "@/gen/paprika/v1/api_pb"
import { createPromiseClient } from "@connectrpc/connect"
import { createTransport } from "@/lib/transport"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { StatusBadge } from "@/components/ui/status-badge"
import {
  GitBranch, Database, Package, ExternalLink, RefreshCw,
  CheckCircle2, AlertCircle, Loader2, Heart, XCircle,
  Clock, Activity, ArrowRight, Target, AlertTriangle, Container,
} from "lucide-react"

const transport = createTransport()
const client = createPromiseClient(PaprikaService, transport)

function PhaseTimeline({ phase }: { phase: string }) {
  const phases = ["Pending", "Building", "Promoting", "Canarying", "Verifying", "Healthy"]
  const currentIdx = phases.indexOf(phase)
  const failedPhases = new Set(["Degraded", "Failed", "RolledBack"])

  return (
    <div className="flex items-center gap-0.5">
      {phases.map((p, i) => {
        const isActive = i === currentIdx
        const isPast = i < currentIdx
        const isFailed = failedPhases.has(phase) && i === currentIdx
        let dotClass = "bg-muted-foreground/20"
        if (isPast) dotClass = "bg-emerald-500"
        if (isActive && !isFailed) dotClass = "bg-primary animate-pulse"
        if (isFailed) dotClass = "bg-destructive"

        return (
          <div key={p} className="flex items-center gap-0.5" title={p}>
            {i > 0 && <div className={`h-px w-1.5 ${isPast ? "bg-emerald-500" : "bg-muted-foreground/20"}`} />}
            <div className={`size-1.5 rounded-full ${dotClass}`} />
          </div>
        )
      })}
    </div>
  )
}

function SyncWindowBadge({ conditions }: { conditions?: Application["conditions"] }) {
  if (!conditions) return null
  const cond = conditions.find((c) => c.type === "SyncWindow")
  if (!cond || cond.status !== "False") return null
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500 border border-amber-500/20">
      <Clock className="size-3" />
      Window blocked
    </span>
  )
}

function SourceIcon({ type }: { type: string }) {
  switch (type) {
    case "git":
      return <GitBranch className="size-3.5 text-emerald-500" />
    case "s3":
      return <Database className="size-3.5 text-blue-500" />
    case "helm":
      return <Package className="size-3.5 text-violet-500" />
    case "inline":
      return <Package className="size-3.5 text-amber-500" />
    case "oci":
      return <Container className="size-3.5 text-sky-500" />
    default:
      return <Package className="size-3.5 text-muted-foreground" />
  }
}

function SourceInfo({ source }: { source?: Application["source"] }) {
  if (!source) return null

  const lines: string[] = []
  const type = source.type || "helm"

  switch (type) {
    case "git":
      if (source.repoUrl) lines.push(source.repoUrl)
      if (source.revision) lines.push(`ref: ${source.revision}`)
      if (source.path) lines.push(`path: ${source.path}`)
      break
    case "s3":
      lines.push(`${source.bucket || "?"}/${source.key || "?"}`)
      if (source.region) lines.push(`region: ${source.region}`)
      if (source.endpoint) lines.push(`endpoint: ${source.endpoint}`)
      if (source.path) lines.push(`chart: ${source.path}`)
      break
    case "helm":
      if (source.chart?.path) {
        lines.push(source.chart.path)
      } else if (source.chart?.name) {
        lines.push(`${source.chart.repo || "?"}/${source.chart.name}`)
        if (source.chart.version) lines.push(`v${source.chart.version}`)
      }
      break
    case "inline":
      if (source.inline?.configMapRef) {
        lines.push(`snapshot: ${source.inline.configMapRef}`)
      }
      break
    case "oci":
      if (source.oci?.url) lines.push(source.oci.url)
      if (source.oci?.tag) lines.push(`tag: ${source.oci.tag}`)
      if (source.oci?.insecure) lines.push("insecure: true")
      break
  }

  const label = type.toUpperCase()

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 rounded-lg bg-muted/50 px-2.5 py-2">
        <SourceIcon type={type} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
          <p className="truncate font-mono text-xs font-medium">{lines[0] || "—"}</p>
        </div>
        {source.pollInterval && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
            {source.pollInterval}
          </span>
        )}
      </div>
      {lines.length > 1 && (
        <div className="pl-1 space-y-0.5">
          {lines.slice(1).map((line, i) => (
            <p key={i} className="truncate font-mono text-[11px] text-muted-foreground">{line}</p>
          ))}
        </div>
      )}
      {source.secretRef && (
        <div className="flex items-center gap-1 pl-1">
          <AlertCircle className="size-3 text-warning" />
          <span className="text-[10px] text-warning">uses secret: {source.secretRef}</span>
        </div>
      )}
    </div>
  )
}

function SourceHashInfo({ application }: { application: Application }) {
  if (!application.sourceHash && !application.sourceRevision) return null
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5">
      <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />
      <div className="min-w-0 flex-1">
        {application.sourceHash && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">hash</span>
            <code className="truncate text-[11px] font-mono">{application.sourceHash.slice(0, 16)}</code>
          </div>
        )}
        {application.sourceRevision && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">rev</span>
            <code className="truncate text-[11px] font-mono">{application.sourceRevision.slice(0, 12)}</code>
          </div>
        )}
      </div>
    </div>
  )
}

function HealthIndicator({ health }: { health: string }) {
  const config: Record<string, { icon: typeof Heart; color: string; label: string }> = {
    Healthy: { icon: Heart, color: "text-emerald-500", label: "Healthy" },
    Degraded: { icon: XCircle, color: "text-destructive", label: "Degraded" },
    Progressing: { icon: Activity, color: "text-amber-500", label: "Progressing" },
    Unknown: { icon: AlertCircle, color: "text-muted-foreground", label: "Unknown" },
  }
  const { icon: Icon, color, label } = config[health] ?? config.Unknown

  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${color}`}>
      <Icon className="size-3" />
      {label}
    </span>
  )
}

function HealthChecksList({ checks }: { checks: Application["healthChecks"] }) {
  if (!checks || checks.length === 0) return null

  const statusColor: Record<string, string> = {
    Healthy: "text-emerald-500",
    Degraded: "text-destructive",
    Progressing: "text-amber-500",
    Unknown: "text-muted-foreground",
  }
  const statusIcon: Record<string, typeof CheckCircle2> = {
    Healthy: CheckCircle2,
    Degraded: XCircle,
    Progressing: Activity,
    Unknown: AlertCircle,
  }

  return (
    <div className="space-y-1">
      {checks.map((check) => {
        const Icon = statusIcon[check.status] ?? AlertCircle
        const color = statusColor[check.status] ?? "text-muted-foreground"
        return (
          <div key={check.name} className="flex items-start gap-1.5 rounded-md bg-muted/30 px-2 py-1.5">
            <Icon className={`mt-0.5 size-3 shrink-0 ${color}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-1">
                <span className="truncate font-mono text-[11px] font-medium">{check.name}</span>
                <span className={`shrink-0 text-[10px] font-medium ${color}`}>{check.status}</span>
              </div>
              {check.message && (
                <p className="truncate text-[10px] text-muted-foreground">{check.message}</p>
              )}
              {check.httpStatusCode > 0 && (
                <p className="text-[10px] text-muted-foreground">
                  HTTP {check.httpStatusCode}
                </p>
              )}
              {check.checkedAt && (
                <p className="text-[10px] text-muted-foreground">
                  {new Date(Number(check.checkedAt) * 1000).toLocaleTimeString()}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ResourceSyncList({ resources }: { resources: Application["resources"] }) {
  if (!resources || resources.length === 0) return null

  const statusColor: Record<string, string> = {
    Synced: "text-emerald-500",
    OutOfSync: "text-amber-500",
    Missing: "text-destructive",
    Pruned: "text-muted-foreground",
  }
  const statusIcon: Record<string, typeof CheckCircle2> = {
    Synced: CheckCircle2,
    OutOfSync: AlertCircle,
    Missing: XCircle,
    Pruned: Clock,
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted-foreground">Resources</span>
        <span className="text-[10px] text-muted-foreground">{resources.length} total</span>
      </div>
      {resources.map((r) => {
        const Icon = statusIcon[r.status] ?? AlertCircle
        const color = statusColor[r.status] ?? "text-muted-foreground"
        return (
          <div key={`${r.kind}/${r.name}`} className="flex items-center gap-1.5 rounded-md bg-muted/30 px-2 py-1">
            <Icon className={`size-3 shrink-0 ${color}`} />
            <span className="text-[10px] font-mono text-muted-foreground">{r.kind}</span>
            <span className="text-[10px] font-medium">{r.name}</span>
            <span className={`ml-auto text-[10px] font-medium ${color}`}>{r.status}</span>
          </div>
        )
      })}
    </div>
  )
}

function ResourceHealthList({ healths }: { healths: Application["resourceHealth"] }) {
  if (!healths || healths.length === 0) return null

  const healthColor: Record<string, string> = {
    Healthy: "text-emerald-500",
    Degraded: "text-destructive",
    Progressing: "text-amber-500",
    Unknown: "text-muted-foreground",
    Missing: "text-destructive",
  }
  const healthIcon: Record<string, typeof CheckCircle2> = {
    Healthy: CheckCircle2,
    Degraded: XCircle,
    Progressing: Activity,
    Unknown: AlertCircle,
    Missing: XCircle,
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted-foreground">Resource Health</span>
        <span className="text-[10px] text-muted-foreground">{healths.length} resources</span>
      </div>
      {healths.map((h) => {
        const Icon = healthIcon[h.health] ?? AlertCircle
        const color = healthColor[h.health] ?? "text-muted-foreground"
        return (
          <div key={`${h.kind}/${h.name}`} className="flex items-center gap-1.5 rounded-md bg-muted/30 px-2 py-1">
            <Icon className={`size-3 shrink-0 ${color}`} />
            <span className="text-[10px] font-mono text-muted-foreground">{h.kind}</span>
            <span className="text-[10px] font-medium">{h.name}</span>
            {h.message && <span className="text-[10px] text-muted-foreground truncate flex-1">{h.message}</span>}
            <span className={`ml-auto text-[10px] font-medium ${color}`}>{h.health}</span>
          </div>
        )
      })}
    </div>
  )
}

function SyncButton({ application, onSynced }: { application: Application; onSynced: () => void }) {
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSync = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setSyncing(true)
    setError(null)
    try {
      await client.syncApplication({ name: application.name, namespace: application.namespace })
      onSynced()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed")
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleSync}
        disabled={syncing}
        className="flex items-center gap-1.5 rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
      >
        {syncing ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
        {syncing ? "Syncing..." : "Re-sync"}
      </button>
      {error && (
        <span className="text-[10px] text-destructive">{error}</span>
      )}
    </div>
  )
}

function StagePill({ stage }: { stage: Application["stages"][number] }) {
  const phaseColor: Record<string, string> = {
    Running: "bg-primary/10 text-primary border-primary/20",
    Succeeded: "bg-success/10 text-success border-success/20",
    Failed: "bg-destructive/10 text-destructive border-destructive/20",
    Pending: "bg-warning/10 text-warning border-warning/20",
  }
  return (
    <div
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${phaseColor[stage.phase] ?? "bg-muted text-muted-foreground border-border/50"}`}
    >
      <span className="flex size-4 items-center justify-center rounded-full bg-background text-[10px] font-semibold ring-1 ring-inset ring-border">
        {stage.ring}
      </span>
      <span className="font-mono">{stage.name}</span>
      <span className="text-[10px] opacity-70">{stage.phase}</span>
    </div>
  )
}

function ApprovalGateButton({ application, onApproved }: { application: Application; onApproved: () => void }) {
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!application.gates || application.gates.length === 0) return null

  const pendingGates = application.gates.filter(g => g.status === "Pending")
  if (pendingGates.length === 0) return null

  const handleApprove = async (gateName: string) => {
    setApproving(true)
    setError(null)
    try {
      await client.approveGate({ name: application.name, namespace: application.namespace, gate: gateName })
      onApproved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval failed")
    } finally {
      setApproving(false)
    }
  }

  return (
    <div className="space-y-1">
      {pendingGates.map(gate => (
        <div key={gate.name} className="flex items-center gap-2">
          <button
            onClick={() => handleApprove(gate.name)}
            disabled={approving}
            className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {approving ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
            {approving ? "Approving..." : `Approve ${gate.name}`}
          </button>
          {error && <span className="text-[10px] text-destructive">{error}</span>}
        </div>
      ))}
    </div>
  )
}

function AnalysisSummary({ results }: { results?: Application["analysisResults"] }) {
  if (!results || results.length === 0) return null
  const failed = results.filter((r) => !r.passed).length
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground">Analysis</span>
      <Badge className={`gap-1 ${failed > 0 ? "bg-destructive/10 text-destructive border-destructive/20" : "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"}`}>
        {failed > 0 ? <XCircle className="size-3" /> : <CheckCircle2 className="size-3" />}
        {results.length - failed}/{results.length}
      </Badge>
    </div>
  )
}

function PolicySummary({ results }: { results?: PolicyResult[] }) {
  if (!results || results.length === 0) return null

  const pass = results.filter((r) => r.passed).length
  const warning = results.filter((r) => !r.passed && r.severity.toLowerCase() === "warning").length
  const fail = results.filter((r) => !r.passed && r.severity.toLowerCase() !== "warning").length

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground">Policies</span>
      <Badge className="gap-1 bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
        <CheckCircle2 className="size-3" />
        {pass}
      </Badge>
      {warning > 0 && (
        <Badge className="gap-1 bg-amber-500/10 text-amber-500 border-amber-500/20">
          <AlertTriangle className="size-3" />
          {warning}
        </Badge>
      )}
      {fail > 0 && (
        <Badge className="gap-1 bg-destructive/10 text-destructive border-destructive/20">
          <XCircle className="size-3" />
          {fail}
        </Badge>
      )}
    </div>
  )
}

export function ApplicationCard({ application, release, onSynced }: { application: Application; release?: Release; onSynced?: () => void }) {
  const hasHealthChecks = application.healthChecks && application.healthChecks.length > 0
  const detailHref = `/dashboard/application?namespace=${encodeURIComponent(application.namespace)}&name=${encodeURIComponent(application.name)}`

  return (
    <Card className="group transition-all duration-200 hover:ring-primary/30 hover:shadow-lg hover:shadow-primary/5">
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-start justify-between gap-2">
          <Link href={detailHref} className="min-w-0 flex-1">
            <h3 className="truncate font-mono text-sm font-medium group-hover:text-primary">
              {application.name}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              ns/{application.namespace}
            </p>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge status={application.phase} />
            <SyncWindowBadge conditions={application.conditions} />
            {onSynced && <SyncButton application={application} onSynced={onSynced} />}
            <Link
              href={detailHref}
              className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-background px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              View
              <ArrowRight className="size-3" />
            </Link>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <PhaseTimeline phase={application.phase} />
          {application.health && <HealthIndicator health={application.health} />}
        </div>

        <div className="grid grid-cols-2 gap-2">
          {application.currentStage && (
            <div className="flex items-center gap-1.5 rounded-lg bg-muted/50 px-2.5 py-2">
              <Package className="size-3.5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-muted-foreground">Stage</p>
                <p className="truncate font-mono text-xs font-medium">
                  {application.currentStage}
                </p>
              </div>
            </div>
          )}
          <div className="flex items-center gap-1.5 rounded-lg bg-muted/50 px-2.5 py-2">
            <ExternalLink className="size-3.5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground">Strategy</p>
              <p className="truncate font-mono text-xs font-medium">
                {application.strategy || "—"}
              </p>
            </div>
          </div>
        </div>

        {application.releaseRef && (
          <div className="flex items-center gap-1.5 rounded-lg bg-muted/50 px-2.5 py-2">
            <Target className="size-3.5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground">Release</p>
              <p className="truncate font-mono text-xs font-medium">{application.releaseRef}</p>
            </div>
          </div>
        )}
        {release && release.policyResults.length > 0 && (
          <PolicySummary results={release.policyResults} />
        )}

        {application.analysisResults && application.analysisResults.length > 0 && (
          <AnalysisSummary results={application.analysisResults} />
        )}

        {application.revision && (
          <div className="flex items-center gap-1.5">
            <code className="rounded bg-muted/50 px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground">
              @{application.revision.slice(0, 7)}
            </code>
            <span className="text-[10px] text-muted-foreground">
              {application.syncPolicy === "Auto" ? "auto-sync" : "manual"}
            </span>
          </div>
        )}

        {application.stages.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {application.stages.map((s) => (
              <StagePill key={s.name} stage={s} />
            ))}
          </div>
        )}

        {application.source && <SourceInfo source={application.source} />}
        <SourceHashInfo application={application} />
        {hasHealthChecks && <HealthChecksList checks={application.healthChecks} />}
        {application.gates && application.gates.length > 0 && (
          <ApprovalGateButton application={application} onApproved={() => onSynced && onSynced()} />
        )}
        {application.resources && application.resources.length > 0 && (
          <ResourceSyncList resources={application.resources} />
        )}
        {application.resourceHealth && application.resourceHealth.length > 0 && (
          <ResourceHealthList healths={application.resourceHealth} />
        )}
      </CardContent>
    </Card>
  )
}