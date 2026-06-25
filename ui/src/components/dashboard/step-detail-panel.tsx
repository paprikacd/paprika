"use client"

import { useEffect, useState } from "react"

import type { ArtifactRef, Step, StepStatus } from "@/gen/paprika/v1/api_pb"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/ui/status-badge"
import { ArtifactCard } from "@/components/dashboard/artifact-card"
import { useStepArtifacts } from "@/lib/use-step-artifacts"
import { Loader2 } from "lucide-react"

function useElapsedMs(startedAt?: bigint) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!startedAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  if (!startedAt) return null
  const startMs = Number(startedAt) * 1000
  if (now < startMs) return null
  return `${Math.floor((now - startMs) / 1000)}s`
}

interface StepDetailPanelProps {
  step: Step | null
  status: StepStatus | null
  logs: string | null
  logsLoading: boolean
  onRetry: () => void
  onSkip: () => void
  artifacts?: ArtifactRef[]
}

export function StepDetailPanel({
  step,
  status,
  logs,
  logsLoading,
  onRetry,
  onSkip,
  artifacts,
}: StepDetailPanelProps) {
  const stepName = step?.name ?? ""
  const stepArtifacts = useStepArtifacts(artifacts ?? [], stepName)

  if (!step) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select a step to view details
      </div>
    )
  }

  const phase = status?.phase ?? ""
  const elapsed = useElapsedMs(status?.startedAt)

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-sm font-semibold">{step.name}</h3>
        <div className="flex items-center gap-2">
          {phase && <StatusBadge status={phase} />}
          {phase === "Running" && elapsed && (
            <span className="text-xs text-muted-foreground">({elapsed})</span>
          )}
        </div>
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

      {stepArtifacts.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">Artifacts</h4>
          <div className="grid gap-2">
            {stepArtifacts.map((a) => (
              <ArtifactCard key={a.name} artifact={a} />
            ))}
          </div>
        </div>
      )}

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
