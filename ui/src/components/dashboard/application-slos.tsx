"use client"

import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import type { Application, SLOSummary } from "@/gen/paprika/v1/api_pb"
import type { StatusTone } from "@/lib/status-tone"

function percentage(value: number): string {
  if (value > 0 && value < 0.1) return "<0.1%"
  return `${Number(value.toFixed(3))}%`
}

function tone(state: string): StatusTone {
  if (state === "Met") return "healthy"
  if (state === "Breached" || state === "Invalid") return "failed"
  if (state === "Stale") return "degraded"
  if (state === "Collecting") return "pending"
  return "unknown"
}

function explanation(state: string, window: string): string {
  if (state === "Collecting") return `Collecting the full ${window} window. Availability reflects observed probes only.`
  if (state === "InsufficientData") return "Missing or invalid observations prevent a conclusion about this target."
  if (state === "Stale") return "The monitor has stopped reporting fresh observations. Check controller availability."
  if (state === "Breached") return "Failed observations have exceeded the rolling window’s error budget."
  if (state === "Met") return "The full window meets the target, even treating unknown intervals as unavailable."
  return "The monitor configuration or clock needs attention before this target can be evaluated."
}

export function ApplicationSLOs({ application, compact = false, onOpenHealth }: {
  application: Application
  compact?: boolean
  onOpenHealth?: () => void
}) {
  const definitions = (application.healthCheckDefinitions ?? []).filter((check) => check.slo)
  if (!definitions.length) return null
  return <Blueprint>
    <BoardHeader title="Availability objectives" meta={`${definitions.length} SLO${definitions.length === 1 ? "" : "s"}`} />
    <ul className="divide-y divide-rule-soft">
      {definitions.map((definition) => {
        const result = application.healthChecks.find((check) => check.name === definition.name)?.slo
        const configured = definition.slo!
        const state = result?.state || "Collecting"
        const observed = Number(result?.healthy ?? 0) + Number(result?.unhealthy ?? 0)
        return <li key={definition.name} className="space-y-3 px-3.5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="break-all font-mono text-note">{definition.name}</h3>
            <StatusPill tone={tone(state)} label={state === "InsufficientData" ? "Insufficient data" : state} />
          </div>
          <p className="text-note"><strong>{percentage(configured.targetPercentage)}</strong> target · {configured.window} rolling window · {definition.interval || "30s"} probes</p>
          <div className={compact ? "space-y-1" : "grid gap-3 sm:grid-cols-2 xl:grid-cols-4"}>
            <Value label="Observed availability" value={observed ? percentage(result!.availabilityPercentage) : "No observations yet"} />
            <Value label="Window observed" value={percentage(result?.windowCoveragePercentage ?? 0)} />
            {!compact ? <>
              <Value label="Window budget remaining" value={observed ? percentage(result!.errorBudgetRemainingPercentage) : "—"} />
              <Value label="Observed burn rate" value={observed ? `${Number(result!.burnRate.toFixed(2))}×` : "—"} />
            </> : null}
          </div>
          <p className="text-note text-muted-foreground">{explanation(state, configured.window)}</p>
          {!compact && result ? <SLOEvidence result={result} /> : null}
        </li>
      })}
    </ul>
    {compact && onOpenHealth ? <button type="button" onClick={onOpenHealth} className="w-full cursor-pointer border-t border-rule px-3.5 py-2 text-left text-note hover:bg-inset">View uptime and error budget →</button> : null}
  </Blueprint>
}

function Value({ label, value }: { label: string; value: string }) {
  return <div><p className="text-meta text-muted-foreground">{label}</p><p className="font-mono text-note font-semibold">{value}</p></div>
}

function SLOEvidence({ result }: { result: SLOSummary }) {
  const first = Number(result.firstObservedAt)
  return <div className="space-y-3">
    <p className="text-note text-muted-foreground">
      {result.healthy.toString()} healthy · {result.unhealthy.toString()} failed · {result.unknown.toString()} missed or invalid slots.
      {first ? ` Monitoring since ${new Date(first * 1000).toLocaleString()}.` : ""}
      {` Coverage since monitoring began: ${percentage(result.coveragePercentage)}.`}
    </p>
    <p className="text-meta text-muted-foreground">The budget uses the configured window and observed failures. Unobserved time remains unknown. Historical SLO results do not replace the current health check or trigger rollback.</p>
    {result.timeline.length ? <details className="rounded border border-rule">
      <summary className="cursor-pointer px-3 py-2 text-note">Uptime observation history</summary>
      <div className="max-h-64 overflow-auto"><table className="w-full text-left text-meta">
        <caption className="sr-only">Availability observations grouped by time</caption>
        <thead className="sticky top-0 bg-muted"><tr>{["Period starting", "Healthy", "Failed", "Unknown"].map((label) => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead>
        <tbody>{[...result.timeline].reverse().map((bucket) => <tr key={bucket.startedAt.toString()} className="border-t border-rule-soft">
          <td className="px-3 py-2">{new Date(Number(bucket.startedAt) * 1000).toLocaleString()}</td>
          <td className="px-3 py-2">{bucket.healthy.toString()}</td><td className="px-3 py-2">{bucket.unhealthy.toString()}</td><td className="px-3 py-2">{bucket.unknown.toString()}</td>
        </tr>)}</tbody>
      </table></div>
    </details> : null}
  </div>
}
