import type { PolicyResult, Release } from "@/gen/paprika/v1/api_pb"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { StatusBadge } from "@/components/ui/status-badge"
import { GitBranch, Target, Layers, ArrowRight, CheckCircle2, XCircle, AlertTriangle, RotateCcw, Boxes, Workflow, FileText } from "lucide-react"

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

function ReleaseCard({ release }: { release: Release }) {
  const completedHooks = release.hookStatuses.filter((h) => h.status === "Succeeded").length
  const totalHooks = release.hookStatuses.length

  return (
    <Card className="transition-all duration-200 hover:ring-primary/30 hover:shadow-lg hover:shadow-primary/5">
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-mono text-sm font-medium">
              {release.name}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              ns/{release.namespace}
            </p>
          </div>
          <StatusBadge status={release.phase} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center gap-1.5 rounded-lg bg-muted/50 px-2.5 py-2">
            <GitBranch className="size-3.5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground">Pipeline</p>
              <p className="truncate font-mono text-xs font-medium">
                {release.pipeline}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg bg-muted/50 px-2.5 py-2">
            <Target className="size-3.5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground">Target stage</p>
              <p className="truncate font-mono text-xs font-medium">
                {release.target}
              </p>
            </div>
          </div>
        </div>

        {release.currentStage && (
          <div className="flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-2">
            <Layers className="size-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Current stage:</span>
            <span className="font-mono text-xs font-medium">{release.currentStage}</span>
          </div>
        )}

        {(release.rolloutRef || release.canaryWeight > 0 || totalHooks > 0 || release.renderedManifestSnapshot) && (
          <div className="grid gap-2">
            {release.rolloutRef && (
              <div className="flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-2">
                <Boxes className="size-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Rollout</span>
                <span className="truncate font-mono text-xs font-medium">{release.rolloutRef}</span>
              </div>
            )}
            {release.canaryWeight > 0 && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <Workflow className="size-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium">Canary {release.canaryWeight}%</span>
                </div>
                <span className="font-mono text-xs text-muted-foreground">step {release.canaryStepIndex}</span>
              </div>
            )}
            {release.renderedManifestSnapshot && (
              <div className="flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-2">
                <FileText className="size-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Snapshot</span>
                <span className="truncate font-mono text-xs font-medium">{release.renderedManifestSnapshot}</span>
              </div>
            )}
            {totalHooks > 0 && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-3 py-2">
                <span className="text-xs text-muted-foreground">Hooks</span>
                <span className="font-mono text-xs font-medium tabular-nums">
                  {completedHooks}/{totalHooks}
                </span>
              </div>
            )}
          </div>
        )}

        {release.policyResults.length > 0 && (
          <PolicySummary results={release.policyResults} />
        )}

        {release.rolledBackTo && (
          <div className="flex items-center gap-1.5 rounded-lg border border-orange-500/20 bg-orange-500/10 px-3 py-2">
            <RotateCcw className="size-3.5 text-orange-400" />
            <span className="text-xs text-orange-400">
              Rolled back to <span className="font-mono font-medium">{release.rolledBackTo}</span>
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function ReleaseGrid({ releases }: { releases: Release[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {releases.map((r) => (
        <ReleaseCard key={r.name} release={r} />
      ))}
      {releases.length === 0 && (
        <div className="col-span-full flex flex-col items-center gap-2 py-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <ArrowRight className="size-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground">No releases yet</p>
          <p className="text-xs text-muted-foreground">
            Create a Release resource to start promoting pipelines
          </p>
        </div>
      )}
    </div>
  )
}
