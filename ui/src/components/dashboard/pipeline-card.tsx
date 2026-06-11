import type { Pipeline } from "@/gen/paprika/v1/api_pb"
import { Card, CardContent } from "@/components/ui/card"
import { StatusBadge } from "@/components/ui/status-badge"
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react"

function StepIcon({ phase }: { phase?: string }) {
  switch (phase) {
    case "Succeeded":
      return <CheckCircle2 className="size-3.5 text-success" />
    case "Failed":
      return <XCircle className="size-3.5 text-destructive" />
    case "Running":
      return <Loader2 className="size-3.5 animate-spin text-primary" />
    default:
      return <Circle className="size-3.5 text-muted-foreground" />
  }
}

function TimeAgo({ time }: { time?: bigint }) {
  if (!time) return null
  const elapsed = Date.now() - Number(time) * 1_000
  const mins = Math.floor(elapsed / 60000)
  const secs = Math.floor((elapsed % 60000) / 1000)
  return (
    <span className="text-xs text-muted-foreground">
      {mins > 0 ? `${mins}m` : `${secs}s`} ago
    </span>
  )
}

export function PipelineCard({ pipeline }: { pipeline: Pipeline }) {
  const stepCount = pipeline.steps.length
  const statuses = pipeline.stepStatuses
  const doneSteps = statuses.filter(
    (s) => s.phase === "Succeeded" || s.phase === "Failed"
  ).length
  const progress = stepCount > 0 ? Math.round((doneSteps / stepCount) * 100) : 0

  const startedAt = statuses.find((s) => s.startedAt)?.startedAt
  const completedAt = statuses.find((s) => s.completedAt)?.completedAt
  const duration =
    completedAt && startedAt
      ? Math.round(Number(completedAt) - Number(startedAt))
      : null

  return (
    <Card className="group transition-all duration-200 hover:ring-primary/30 hover:shadow-lg hover:shadow-primary/5">
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-mono text-sm font-medium">
              {pipeline.name}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              ns/{pipeline.namespace}
              {duration !== null && (
                <>
                  <span className="mx-1.5">&middot;</span>
                  {duration}s
                </>
              )}
              {startedAt && (
                <>
                  <span className="mx-1.5">&middot;</span>
                  <TimeAgo time={startedAt} />
                </>
              )}
            </p>
          </div>
          <StatusBadge status={pipeline.phase} />
        </div>

        <div className="space-y-1.5">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="rounded-full bg-primary transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {doneSteps}/{stepCount} steps completed
          </p>
        </div>

        <div className="space-y-1">
          {pipeline.steps.map((step, i) => {
            const ss = statuses.find((s) => s.name === step.name)
            const isLast = i === pipeline.steps.length - 1
            return (
              <div key={step.name} className="flex items-center gap-2">
                <div className="flex flex-col items-center">
                  <StepIcon phase={ss?.phase} />
                  {!isLast && (
                    <div className="mt-0.5 h-3 w-px bg-border" />
                  )}
                </div>
                <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-foreground/80">
                    {step.name}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {step.image.split("/").pop()}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
