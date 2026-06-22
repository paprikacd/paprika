"use client"

import type { Step, StepStatus } from "@/gen/paprika/v1/api_pb"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/ui/status-badge"
import { Loader2 } from "lucide-react"

interface StepDetailPanelProps {
  step: Step | null
  status: StepStatus | null
  logs: string | null
  logsLoading: boolean
  onRetry: () => void
  onSkip: () => void
}

export function StepDetailPanel({ step, status, logs, logsLoading, onRetry, onSkip }: StepDetailPanelProps) {
  if (!step) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select a step to view details
      </div>
    )
  }

  const phase = status?.phase ?? ""

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-sm font-semibold">{step.name}</h3>
        {phase && <StatusBadge status={phase} />}
      </div>

      <div className="flex gap-2">
        {phase === "Failed" && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        )}
        {phase === "Pending" && (
          <Button size="sm" variant="outline" onClick={onSkip}>
            Skip
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <h4 className="mb-2 text-xs font-medium text-muted-foreground">Logs</h4>
        {logsLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Loading logs...
          </div>
        ) : logs ? (
          <pre className="whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs leading-relaxed">
            {logs}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">No logs available</p>
        )}
      </div>
    </div>
  )
}
