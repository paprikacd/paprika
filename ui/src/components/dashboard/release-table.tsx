import type { Release } from "@/gen/paprika/v1/api_pb"
import { Card, CardContent } from "@/components/ui/card"
import { StatusBadge } from "@/components/ui/status-badge"
import { GitBranch, Target, Layers, ArrowRight } from "lucide-react"

function ReleaseCard({ release }: { release: Release }) {
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
              <p className="text-[11px] text-muted-foreground">Target</p>
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
