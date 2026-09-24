import { ChevronRight, CircleAlert } from "lucide-react"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import type { Application } from "@/gen/paprika/v1/api_pb"
import styles from "./application-health.module.css"

const reasons: Record<string, string> = {
  Timeout: "Probe timed out", DNSFailure: "DNS lookup failed", TLSFailure: "TLS verification failed",
  ConnectionRefused: "Connection refused", RequestFailed: "Request failed", Canceled: "Probe canceled",
  InvalidRequest: "Invalid request", ResponseTooLarge: "Response too large", ResponseReadError: "Incomplete response",
  UnexpectedStatus: "Unexpected HTTP status", ExpressionFailed: "Health assertion failed", EvaluationError: "Check could not be evaluated",
}
export function failureReason(reason: string) { return reasons[reason] || reason || "Check did not pass" }
function observedTime(seconds: bigint) { return new Date(Number(seconds) * 1000).toLocaleString() }

type Dependency = { name: string; ok: boolean; latency?: string; error?: string }
export function responseEvidence(body: string): { formatted: string; checks: Dependency[] } {
  try {
    const json: unknown = JSON.parse(body)
    const candidates = json && typeof json === "object" && "checks" in json ? json.checks : undefined
    const checks = Array.isArray(candidates) ? candidates.filter((check): check is Dependency =>
      !!check && typeof check === "object" && typeof check.name === "string" && typeof check.ok === "boolean"
    ).slice(0, 32).map((check) => ({ name: check.name, ok: check.ok,
      latency: typeof check.latency === "string" ? check.latency : undefined,
      error: typeof check.error === "string" ? check.error : undefined })) : []
    return { formatted: JSON.stringify(json, null, 2), checks }
  } catch { return { formatted: body, checks: [] } }
}

export function ProbeResponse({ body, truncated }: { body: string; truncated?: boolean }) {
  if (!body) return <p className="text-note text-muted-foreground">No response body was captured.</p>
  const { formatted, checks } = responseEvidence(body)
  return <div className="min-w-0 space-y-3">
    {checks.length ? <div aria-label="Dependency check results" className="divide-y divide-rule-soft border border-rule-soft">
      {checks.map((check, index) => <div key={`${check.name}/${index}`} className="flex flex-wrap items-start gap-2 px-3 py-2">
        <StatusPill tone={check.ok ? "healthy" : "failed"} label={check.ok ? "Passed" : "Failed"} />
        <div className="min-w-0 flex-1"><p className="break-all font-mono text-note">{check.name}</p>{check.error ? <p className="mt-1 break-words text-note text-muted-foreground">{check.error}</p> : null}</div>
        {check.latency ? <span className="font-mono text-meta text-muted-foreground">{check.latency}</span> : null}
      </div>)}
    </div> : null}
    <details className={styles.response}>
      <summary>Captured response{truncated ? " · excerpt" : ""}</summary>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all border border-rule-soft bg-inset p-3 font-mono text-meta">{formatted}</pre>
    </details>
    {truncated ? <p className="text-meta text-muted-foreground">Response truncated to the diagnostic storage limit. The complete response is not retained.</p> : null}
  </div>
}

export function RecentCheckIssues({ application }: { application: Application }) {
  const failures = application.healthChecks.flatMap((check) => (check.recentFailures ?? []).map((failure) => ({ check, failure })))
    .sort((a, b) => Number(b.failure.checkedAt - a.failure.checkedAt))
  const historicalFailures = application.healthChecks.some((check) => Number(check.slo?.unhealthy ?? 0) > 0)
  if (!failures.length && !historicalFailures) return null
  return <Blueprint>
    <BoardHeader title="Recent check issues" meta={`${failures.length} retained`} />
    <p className="border-b border-rule-soft px-5 py-3 text-note text-muted-foreground">The latest five unsuccessful observations per check are kept for up to 30 days, including after recovery. Probe changes reset this evidence. This is a diagnostic sample, not the SLO failure count.</p>
    {!failures.length ? <p className="px-5 py-4 text-note text-muted-foreground">Earlier failures have counts only. Detailed evidence is captured for new observations; past responses cannot be reconstructed.</p> : <ul className="divide-y divide-rule-soft">
      {failures.map(({check, failure}) => <li key={`${check.name}/${failure.checkedAt}`}>
        <details className={styles.diagnostic} style={{ border: 0 }}>
          <summary><span className="shrink-0 text-destructive" aria-hidden="true"><CircleAlert size={18} /></span>
            <div className="min-w-0 flex-1"><h3>{failureReason(failure.reason)}</h3><p className="break-words">{check.name} · {observedTime(failure.checkedAt)} · {failure.httpStatusCode ? `HTTP ${failure.httpStatusCode}` : "No HTTP response"} · {failure.durationMillis.toString()}ms</p></div>
            <StatusPill tone={failure.status === "Unknown" ? "unknown" : failure.status === "Progressing" ? "progressing" : "failed"} label={failure.status === "Degraded" ? "Failed" : failure.status || "Unknown"} />
            <ChevronRight size={16} aria-hidden="true" />
          </summary>
          <div className="min-w-0 space-y-3 border-t border-rule-soft px-5 py-4">
            <p className="break-words text-note">{failure.message || "No additional message was captured."}</p>
            <ProbeResponse body={failure.httpBody} truncated={failure.bodyTruncated} />
          </div>
        </details>
      </li>)}
    </ul>}
  </Blueprint>
}
