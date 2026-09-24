"use client"

import { useState } from "react"
import { CheckCircle2, CircleAlert, Clock3, ChevronRight } from "lucide-react"
import { durationSeconds } from "./uptime-history"
import styles from "./application-health.module.css"
import { useHealthClock } from "./use-health-clock"

import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import { ResourceKindIcon } from "@/components/dashboard/resource-kind-icon"
import { ApplicationSLOs } from "@/components/dashboard/application-slos"
import { resourceHealthTone, type FlatTreeNode } from "@/components/dashboard/resource-list-table"
import type { InspectedResource } from "@/components/dashboard/resource-detail-panel"
import type { Application, Condition, Release } from "@/gen/paprika/v1/api_pb"
import type { StatusTone } from "@/lib/status-tone"

function time(value: bigint | string | number | undefined): string {
  if (!value || value === BigInt(0)) return "Not recorded"
  const date = new Date(typeof value === "bigint" ? Number(value) * 1000 : value)
  return Number.isNaN(date.getTime()) ? "Not recorded" : date.toLocaleString()
}

function resultTone(status: string): StatusTone {
  if (["Healthy", "Succeeded", "Passed", "Complete"].includes(status)) return "healthy"
  if (["Failed", "Unhealthy", "Error"].includes(status)) return "failed"
  if (["Degraded", "RolledBack"].includes(status)) return "degraded"
  if (["Running", "Progressing", "Verifying"].includes(status)) return "progressing"
  return "unknown"
}

export function ApplicationHealth({ application, release, resources, observedAt, releaseLoading, onSelectResource }: {
  application: Application
  release: Release | null
  resources: FlatTreeNode[]
  observedAt?: number
  releaseLoading: boolean
  onSelectResource: (resource: InspectedResource) => void
}) {
  const [attentionOnly, setAttentionOnly] = useState(false)
  const now = useHealthClock()
  const checks = application.healthChecks ?? []
  const definitions = application.healthCheckDefinitions ?? []
  const checkNames = [...new Set([...definitions.map((check) => check.name), ...checks.map((check) => check.name)])]
  const health = application.resourceHealth ?? []
  const healthy = health.filter((resource) => resource.health === "Healthy").length
  const visibleHealth = attentionOnly ? health.filter((resource) => resource.health !== "Healthy") : health
  const nodes = new Map(resources.map((node) => [`${node.namespace}/${node.kind}/${node.name}`, node]))

  const freshChecks = checkNames.filter((name) => {
    const check = checks.find((item) => item.name === name)
    const interval = durationSeconds(definitions.find((item) => item.name === name)?.interval || "30s") || 30
    return check?.checkedAt && now - Number(check.checkedAt) <= interval * 2 && Number(check.checkedAt) <= now
  })
  const passing = checks.filter((check) => check.status === "Healthy" && freshChecks.includes(check.name)).length
  const allPassing = checkNames.length > 0 && passing === checkNames.length
  const hasFailures = checks.some((check) => ["Failed", "Unhealthy", "Error", "Degraded"].includes(check.status))
  const statusTitle = !checkNames.length ? "No application checks configured" : allPassing ? "All checks passing" : hasFailures ? "Checks need attention" : "Waiting for fresh checks"
  const StatusIcon = allPassing ? CheckCircle2 : hasFailures ? CircleAlert : Clock3

  return <div className="flex min-w-0 flex-col gap-5" aria-label="Application health details">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h2 className="font-cond text-board font-semibold">Service health</h2>
        <p className="mt-1 text-note text-muted-foreground">Current checks, rolling availability and the evidence behind them.</p>
      </div>
      <p className="font-mono text-meta text-muted-foreground">Fetched {time(observedAt)} · refreshes every 15s while visible</p>
    </div>

    <div className={styles.status} data-tone={allPassing ? "healthy" : hasFailures ? "degraded" : "unknown"}>
      <div className={styles.statusIcon}><StatusIcon size={30} strokeWidth={1.6} aria-hidden="true" /><div><h3 className={styles.statusTitle}>{statusTitle}</h3><p>{checkNames.length ? `${passing} of ${checkNames.length} checks passing with fresh results` : "Configure an HTTP or CEL check to start monitoring availability."}</p></div></div>
      <span className={styles.statusMeta}>{healthy}/{health.length} resources healthy</span>
    </div>
    <ApplicationSLOs application={application} />
    <div className="flex min-w-0 flex-col gap-4">
      <Blueprint>
        <BoardHeader title="Application checks" meta={`${checkNames.length} checks`} />
        {checkNames.length === 0 ? <Empty>No application-level CEL or HTTP checks are configured or reported. Resource readiness and release verification are shown separately below.</Empty> :
          <ul className="divide-y divide-rule-soft">
            {checkNames.map((name) => {
              const check = checks.find((item) => item.name === name)
              const definition = definitions.find((item) => item.name === name)
              const probe = definition?.httpProbe
              return <li key={name}><details className={styles.diagnostic} style={{ border: 0 }} open={!!check && check.status !== "Healthy"}>
                <summary><div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3"><div><h3 className="break-all font-mono text-note">{name}</h3><p>{check?.checkedAt ? `Latest probe ${check.durationMillis.toString()}ms${check.httpStatusCode ? ` · HTTP ${check.httpStatusCode}` : ""} · every ${definition?.interval || "30s"}` : "Waiting for the first result"}</p></div><StatusPill tone={check?.status === "Healthy" && !freshChecks.includes(name) ? "unknown" : resultTone(check?.status ?? "")} label={check?.status === "Healthy" && !freshChecks.includes(name) ? "Stale" : check?.status || "Not evaluated"} /></div><ChevronRight size={16} aria-hidden="true" /></summary>
                <div className="space-y-2 border-t border-rule-soft px-5 py-4">
                {probe ? <p className="break-all font-mono text-meta">{probe.method || "GET"} {probe.url} · expected HTTP {probe.expectedStatus || 200} · timeout {probe.timeout || 5}s</p> : null}
                {definition?.expression ? <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-rule bg-inset p-2 text-meta">{definition.expression}</pre> : null}
                <p className="text-note text-muted-foreground">{check?.message || "No result message reported."}</p>
                {check?.checkedAt ? <p className="font-mono text-meta text-muted-foreground">Probe duration {(check.durationMillis ?? BigInt(0)).toString()}ms</p> : null}
                <p className="font-mono text-meta text-muted-foreground">Checked {time(check?.checkedAt)}{check?.httpStatusCode ? ` · HTTP ${check.httpStatusCode}` : ""}{definition ? ` · interval ${definition.interval || "30s"}` : ""}</p>
                </div></details></li>
            })}
          </ul>}
      </Blueprint>

      <details className={styles.diagnostic} open={!!release && !["Complete", "Succeeded"].includes(release.phase)}>
        <summary><div><h3>Release verification</h3><p>{release?.name || "No current release"} · {release?.phase || "Unknown"}</p></div><ChevronRight size={16} aria-hidden="true" /></summary>
        {!release ? <Empty>{releaseLoading ? "Loading release verification…" : "No current release evidence is available."}</Empty> : <div className="space-y-3 px-3.5 py-3">
          <StatusPill tone={resultTone(release.phase)} label={release.phase || "Unknown"} />
          <p className="text-note text-muted-foreground">{release.phase === "Complete" ? "The release completed its configured verification gates. Individual gate timings and responses are not retained by the controller." : "The release phase is the aggregate outcome. A missing check result is not a pass."}</p>
          {(release.verificationChecks ?? []).length ? <ul className="divide-y divide-rule-soft border-y border-rule">
            {release.verificationChecks.map((check, index) => <li key={`${check.type}/${index}`} className="space-y-1 py-2">
              <p className="font-cond text-label font-semibold">{check.type}</p>
              {check.endpoint ? <p className="break-all font-mono text-meta">{check.endpoint}</p> : null}
              <p className="text-meta text-muted-foreground">{check.timeoutSeconds ? `${check.timeoutSeconds}s limit` : "Controller default timeout"}</p>
            </li>)}
          </ul> : <p className="text-note text-muted-foreground">No verification gate configuration was reported.</p>}
          {(release.hookStatuses ?? []).map((hook) => <div key={`${hook.phase}/${hook.kind}/${hook.name}`} className="border-l-2 border-rule-strong pl-3">
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-meta">{hook.phase} · {hook.kind}/{hook.name}</span><StatusPill tone={resultTone(hook.status)} label={hook.status || "Unknown"} /></div>
            <p className="mt-1 text-note text-muted-foreground">{hook.message || "No hook message reported."}</p>
            <p className="mt-1 font-mono text-meta text-muted-foreground">Started {time(hook.startedAt)} · finished {time(hook.completedAt)}</p>
          </div>)}
        </div>}
      </details>
    </div>

    <details className={styles.diagnostic} open={healthy < health.length}>
      <summary><div><h3>Resource health</h3><p>{healthy} of {health.length} resources reported healthy</p></div><ChevronRight size={16} aria-hidden="true" /></summary>
      <BoardHeader title="Kubernetes resources" meta={`${healthy}/${health.length} reported healthy`} actions={<button type="button" aria-pressed={attentionOnly} onClick={() => setAttentionOnly(!attentionOnly)} className="cursor-pointer border border-rule px-2 py-1 text-meta">{attentionOnly ? "Show all resources" : "Needs attention"}</button>} />
      <p className="border-b border-rule px-3.5 py-2 text-note text-muted-foreground">Controller observations of Kubernetes resources. Open a resource for live manifests and events. These are not synthetic endpoint tests.</p>
      {health.length === 0 ? <Empty>No resource health observations have been reported yet.</Empty> : <div className="max-h-[30rem] overflow-auto">
        <table className="w-full text-left text-note"><caption className="sr-only">Resource health observations</caption>
          <thead className="sticky top-0 bg-muted"><tr><Head>Resource</Head><Head>Health</Head><Head>Ready</Head><Head>Evidence</Head></tr></thead>
          <tbody>{visibleHealth.map((resource) => {
            const key = `${resource.namespace}/${resource.kind}/${resource.name}`
            const node = nodes.get(key)
            return <tr key={key} className="border-t border-rule-soft">
              <Cell><button type="button" onClick={() => onSelectResource({ ...resource, syncStatus: node?.syncStatus ?? "", healthMessage: resource.message })} className="flex cursor-pointer items-center gap-2 text-left hover:underline"><ResourceKindIcon kind={resource.kind} className="size-6" /><span><span className="block font-mono text-meta text-muted-foreground">{resource.kind}</span><span className="break-all">{resource.name}</span></span></button></Cell>
              <Cell><StatusPill tone={resourceHealthTone(resource.health)} label={resource.health || "Unknown"} /></Cell>
              <Cell>{node && typeof node.total === "number" && node.total > 0 ? `${node.ready ?? 0}/${node.total}` : "—"}</Cell>
              <Cell>{resource.message || "No additional detail reported."}</Cell>
            </tr>
          })}</tbody>
        </table>
        {attentionOnly && visibleHealth.length === 0 ? <Empty>All reported resource checks are healthy.</Empty> : null}
      </div>}
    </details>

    {(application.analysisResults ?? []).length ? <Blueprint><BoardHeader title="Analysis results" /><ul className="divide-y divide-rule-soft">{application.analysisResults.map((result) => <li key={`${result.name}/${result.phase}`} className="space-y-1 px-3.5 py-3"><div className="flex items-center gap-2"><span>{result.name} · {result.phase}</span><StatusPill tone={result.passed ? "healthy" : "failed"} label={result.passed ? "Passed" : "Failed"} /></div><p className="text-note">{result.message}</p><p className="font-mono text-meta text-muted-foreground">{time(result.checkedAt)}</p></li>)}</ul></Blueprint> : null}
    <Conditions title="Application conditions" conditions={application.conditions ?? []} />
    <Conditions title="Release conditions" conditions={release?.conditions ?? []} />
  </div>
}

function Conditions({ title, conditions }: { title: string; conditions: Condition[] }) {
  if (!conditions.length) return null
  return <details className={styles.diagnostic}><summary><div><h3>{title}</h3><p>{conditions.length} conditions reported</p></div><ChevronRight size={16} aria-hidden="true" /></summary><ul className="divide-y divide-rule-soft">{conditions.map((condition) => <li key={condition.type} className="space-y-1 px-3.5 py-3"><p className="font-cond text-label font-semibold">{condition.type}: {condition.status} <span className="font-mono text-meta font-normal text-muted-foreground">· {condition.reason}</span></p><p className="text-note">{condition.message || "No message reported."}</p><p className="font-mono text-meta text-muted-foreground">Changed {time(condition.lastTransitionTime)} · observed generation {condition.observedGeneration.toString()}</p></li>)}</ul></details>
}
function Empty({ children }: { children: React.ReactNode }) { return <p className="px-3.5 py-5 text-note text-muted-foreground">{children}</p> }
function Head({ children }: { children: React.ReactNode }) { return <th className="px-3.5 py-2 font-medium">{children}</th> }
function Cell({ children }: { children: React.ReactNode }) { return <td className="px-3.5 py-2 align-top">{children}</td> }
