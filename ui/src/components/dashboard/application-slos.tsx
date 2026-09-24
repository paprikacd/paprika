"use client"

import { useState, type ReactNode } from "react"
import { Activity, CircleAlert, Gauge, Timer } from "lucide-react"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import { UptimeHistory } from "./uptime-history"
import type { Application, SLOSummary } from "@/gen/paprika/v1/api_pb"
import type { StatusTone } from "@/lib/status-tone"
import styles from "./application-health.module.css"

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

export function ApplicationSLOs({ application, compact = false, onOpenHealth, observedAt }: {
  application: Application; compact?: boolean; onOpenHealth?: () => void; observedAt?: number
}) {
  const [mountedAt] = useState(() => Date.now())
  const now = (observedAt ?? mountedAt) / 1000
  const definitions = (application.healthCheckDefinitions ?? []).filter((check) => check.slo)
  if (!definitions.length) return null
  const objectives = definitions.map((definition) => {
    const check = application.healthChecks.find((check) => check.name === definition.name)
    const result = check?.slo
    const configured = definition.slo!
    const state = result?.state || "Collecting"
    const observed = Number(result?.healthy ?? 0) + Number(result?.unhealthy ?? 0)
    const availability = observed ? percentage(result!.availabilityPercentage) : "No observations yet"
    const header = <div className={styles.objectiveHeader}>
      <div><h3 className={styles.checkName}>{definition.name}</h3><p className={styles.objectiveMeta}><strong>{percentage(configured.targetPercentage)}</strong> target · {configured.window} rolling window · {definition.interval || "30s"} probes</p></div>
      <StatusPill tone={tone(state)} label={state === "InsufficientData" ? "Insufficient data" : state} />
    </div>
    if (compact) return <li key={definition.name} className="px-3.5 py-4">
      {header}<div className={styles.compactKpi}><strong>{availability}</strong><span>observed uptime</span></div>
      <UptimeHistory result={result} window={configured.window} now={now} compact />
      <p className={styles.note}>{explanation(state, configured.window)}</p>
    </li>
    return <section key={definition.name} className={styles.objective} aria-label={`${definition.name} availability objective`}>
      {header}
      <div className={styles.kpis}>
        <KPI label="Observed uptime" value={observed ? percentage(result!.availabilityPercentage) : "—"} icon={<Activity size={16} />} hint={observed ? `${Number(result!.healthy).toLocaleString()} of ${observed.toLocaleString()} observed probes passed` : "No observations yet"} />
        <KPI label="Error budget remaining" value={observed ? percentage(result!.errorBudgetRemainingPercentage) : "—"} icon={<Gauge size={16} />} hint={observed ? `${Number(result!.burnRate.toFixed(2))}× observed burn · ${configured.window} budget` : "Waiting for the first observation"}>
          {observed ? <div className={styles.budget} data-low={result!.errorBudgetRemainingPercentage < 20} aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, result!.errorBudgetRemainingPercentage))}%` }} /></div> : null}
        </KPI>
        <KPI label="Latest probe" value={check?.checkedAt ? `${check.durationMillis.toString()} ms` : "—"} icon={<Timer size={16} />} hint={check?.checkedAt ? `${check.httpStatusCode ? `HTTP ${check.httpStatusCode} · ` : ""}${new Date(Number(check.checkedAt) * 1000).toLocaleTimeString()}` : "No probe result yet"} />
        <KPI label="Failed probes" value={observed ? Number(result!.unhealthy).toLocaleString() : "—"} icon={<CircleAlert size={16} />} hint={observed ? `${Number(result!.unknown).toLocaleString()} missed / invalid · ${percentage(result!.windowCoveragePercentage)} of window observed` : "Unobserved time remains unknown"} />
      </div>
      <div className={styles.panel}>
        <div className={styles.panelHeader}><div><h3 className={styles.panelTitle}>Uptime history</h3><p>{explanation(state, configured.window)}</p></div><span className="font-mono text-meta text-muted-foreground">{percentage(result?.windowCoveragePercentage ?? 0)} window observed</span></div>
        <UptimeHistory result={result} window={configured.window} now={now} />
        {result ? <SLOEvidence result={result} /> : null}
      </div>
    </section>
  })
  if (!compact) return <div className="flex min-w-0 flex-col gap-6">{objectives}</div>
  return <Blueprint><BoardHeader title="Availability objectives" meta={`${definitions.length} SLO${definitions.length === 1 ? "" : "s"}`} /><ul className="divide-y divide-rule-soft">{objectives}</ul>{onOpenHealth ? <button type="button" onClick={onOpenHealth} className="w-full cursor-pointer border-t border-rule px-3.5 py-2 text-left text-note hover:bg-inset">View uptime and error budget →</button> : null}</Blueprint>
}

function KPI({ label, value, hint, icon, children }: { label: string; value: string; hint: string; icon: ReactNode; children?: ReactNode }) {
  return <div className={styles.kpi}><p className={styles.kpiLabel}>{label}<span aria-hidden="true">{icon}</span></p><p className={styles.kpiValue}>{value}</p>{children}<p className={styles.kpiHint}>{hint}</p></div>
}

function SLOEvidence({ result }: { result: SLOSummary }) {
  const first = Number(result.firstObservedAt)
  return <details className={styles.evidence}>
    <summary>Calculation &amp; observation details</summary>
    <p className={styles.note}>{result.healthy.toString()} healthy · {result.unhealthy.toString()} failed · {result.unknown.toString()} missed or invalid slots.
      {first ? ` Monitoring since ${new Date(first * 1000).toLocaleString()}.` : ""}{` Coverage since monitoring began: ${percentage(result.coveragePercentage)}.`}</p>
    <p className={styles.note}>Availability excludes unknown time. The budget uses the configured window and observed failures, so a new monitor’s remaining budget is provisional. Historical SLO results do not replace the current health check or trigger rollback.</p>
    {result.timeline.length ? <details className="mt-3 border border-rule">
      <summary className="px-3 py-2 text-note">Uptime observation history</summary>
      <div className="max-h-64 overflow-auto"><table className="w-full text-left text-meta">
        <caption className="sr-only">Availability observations grouped by time</caption>
        <thead className="sticky top-0 bg-muted"><tr>{["Period starting", "Healthy", "Failed", "Unknown"].map((label) => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead>
        <tbody>{[...result.timeline].reverse().map((bucket) => <tr key={bucket.startedAt.toString()} className="border-t border-rule-soft"><td className="px-3 py-2">{new Date(Number(bucket.startedAt) * 1000).toLocaleString()}</td><td className="px-3 py-2">{bucket.healthy.toString()}</td><td className="px-3 py-2">{bucket.unhealthy.toString()}</td><td className="px-3 py-2">{bucket.unknown.toString()}</td></tr>)}</tbody>
      </table></div>
    </details> : null}
  </details>
}
