"use client"

import { Loader2 } from "lucide-react"

import type { Step, StepStatus } from "@/gen/paprika/v1/api_pb"
import {
  formatDuration,
  phaseLabel,
  phaseTone,
  stepElapsedMs,
} from "@/app/dashboard/pipelines/pipeline-model"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-chip"
import { cn } from "@/lib/utils"

interface StepDetailPanelProps {
  step: Step | null
  status: StepStatus | null
  logs: string | null
  logsLoading: boolean
  onRetry: () => void
  onSkip: () => void
  /**
   * `4 CPU / 8 GiB`, from the PIPELINE_RUNS record. Null when that class
   * cannot supply it — the segment is then absent rather than zeroed.
   */
  resourceLabel?: string | null
  /** Renders the "Full logs" action when the caller can widen the tail. */
  onLoadFullLogs?: () => void
  showingFullLogs?: boolean
  /** Clock for a running step's elapsed time. */
  nowMs?: number
  className?: string
}

export function StepDetailPanel({
  step,
  status,
  logs,
  logsLoading,
  onRetry,
  onSkip,
  resourceLabel,
  onLoadFullLogs,
  showingFullLogs = false,
  nowMs,
  className,
}: StepDetailPanelProps) {
  if (!step) {
    return (
      <div
        className={cn(
          "flex h-full items-center justify-center p-6 text-console text-muted-foreground",
          className
        )}
      >
        Select a step to view details
      </div>
    )
  }

  const phase = status?.phase ?? ""
  const elapsed = nowMs ? stepElapsedMs(status, nowMs) : null
  const meta = [
    step.image,
    resourceLabel ?? "",
    elapsed === null ? "" : formatDuration(elapsed),
  ].filter(Boolean)

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="border-b border-rule px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="min-w-0 truncate font-cond text-card font-semibold tracking-[0.04em]">
            {step.name}
          </h3>
          <StatusPill tone={phaseTone(phase)} label={phaseLabel(phase)} />
        </div>
        {meta.length > 0 ? (
          <p className="mt-1 truncate font-mono text-meta text-neutral-600">
            {meta.join(" · ")}
          </p>
        ) : null}
      </div>

      <section
        aria-labelledby="step-log-heading"
        className="min-h-0 border-b border-rule bg-ink-surface"
      >
        <h4 id="step-log-heading" className="sr-only">
          Logs for {step.name}
        </h4>
        {logsLoading ? (
          <p className="flex items-center gap-2 p-3 font-mono text-note text-ink-muted">
            <Loader2 aria-hidden className="size-3 animate-spin" />
            Loading logs…
          </p>
        ) : logs ? (
          <pre
            tabIndex={0}
            className="m-0 max-h-[280px] overflow-auto p-[11px] font-mono text-note leading-[1.7] whitespace-pre-wrap text-log-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink-accent"
          >
            {logs}
          </pre>
        ) : (
          <p className="p-3 font-mono text-note text-ink-faint">
            No logs available
          </p>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        <Button
          variant="outline"
          size="sm"
          className="text-note"
          disabled={phase !== "Failed"}
          onClick={onRetry}
        >
          Retry step
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-note"
          disabled={phase !== "" && phase !== "Pending"}
          onClick={onSkip}
        >
          Skip
        </Button>
        {onLoadFullLogs ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-note text-primary"
            disabled={showingFullLogs}
            onClick={onLoadFullLogs}
          >
            {showingFullLogs ? "Showing full logs" : "Full logs"}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
