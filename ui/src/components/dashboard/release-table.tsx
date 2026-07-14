import Link from "next/link"
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  FileText,
  GitBranch,
  Layers,
  RotateCcw,
  Target,
  Workflow,
  XCircle,
} from "lucide-react"

import type { PolicyResult, Release } from "@/gen/paprika/v1/api_pb"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { serializeReleaseQuery, type ReleaseQueryState } from "@/lib/release-query"
import { fleetDetailHref } from "@/lib/fleet-navigation"

type ReleaseQueryInput = string | URLSearchParams | ReleaseQueryState

export interface ReleaseGridProps {
  releases: Release[]
  query?: ReleaseQueryInput
  loading?: boolean
  search?: string
  error?: string | null
  onRetry?: () => void
}

const phaseTone: Record<string, string> = {
  Pending: "border-warning/30 bg-warning/10 text-warning",
  Promoting: "border-primary/30 bg-primary/10 text-primary",
  Canarying: "border-primary/30 bg-primary/10 text-primary",
  Verifying: "border-blue-500/30 bg-blue-500/10 text-blue-400",
  Complete: "border-success/30 bg-success/10 text-success",
  Failed: "border-destructive/30 bg-destructive/10 text-destructive",
  RolledBack: "border-orange-500/30 bg-orange-500/10 text-orange-400",
  AwaitingApproval: "border-warning/30 bg-warning/10 text-warning",
}

function ReleaseStatus({ phase }: { phase: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
        phaseTone[phase] ?? "border-border bg-muted text-muted-foreground"
      }`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {phase || "Unknown"}
    </span>
  )
}

function PolicySummary({ results }: { results?: PolicyResult[] }) {
  if (!results || results.length === 0) return null

  const pass = results.filter((result) => result.passed).length
  const warning = results.filter(
    (result) => !result.passed && result.severity.toLowerCase() === "warning",
  ).length
  const fail = results.filter(
    (result) => !result.passed && result.severity.toLowerCase() !== "warning",
  ).length

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-muted-foreground">Policies</span>
      <Badge className="gap-1 border-emerald-500/20 bg-emerald-500/10 text-emerald-500">
        <CheckCircle2 className="size-3" aria-hidden="true" />
        {pass}
      </Badge>
      {warning > 0 && (
        <Badge className="gap-1 border-amber-500/20 bg-amber-500/10 text-amber-500">
          <AlertTriangle className="size-3" aria-hidden="true" />
          {warning}
        </Badge>
      )}
      {fail > 0 && (
        <Badge className="gap-1 border-destructive/20 bg-destructive/10 text-destructive">
          <XCircle className="size-3" aria-hidden="true" />
          {fail}
        </Badge>
      )}
    </div>
  )
}

function Fact({ label, value, icon: Icon }: { label: string; value: string; icon: typeof GitBranch }) {
  return (
    <div className="min-w-0 border-t border-border/60 py-2.5 first:border-t-0 xl:border-t-0 xl:py-0">
      <dt className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground xl:block">
        <Icon className="size-3.5 shrink-0 xl:mb-1" aria-hidden="true" />
        {label}
      </dt>
      <dd className="ml-5 truncate font-mono text-xs font-medium xl:ml-0">{value || "—"}</dd>
    </div>
  )
}

function ReleaseItem({ release, query }: { release: Release; query: ReleaseQueryInput }) {
  const completedHooks = release.hookStatuses.filter((hook) => hook.status === "Succeeded").length
  const totalHooks = release.hookStatuses.length

  return (
    <li className="border-b border-border/70 bg-card px-4 py-4 last:border-b-0 sm:px-5">
      <article aria-labelledby={`release-${release.namespace}-${release.name}`} className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3
              id={`release-${release.namespace}-${release.name}`}
              className="truncate font-mono text-sm font-semibold"
            >
              {release.name}
            </h3>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              {release.namespace}/{release.name}
            </p>
          </div>
          <ReleaseStatus phase={release.phase} />
        </div>

        <dl className="border-y border-border/60 xl:grid xl:grid-cols-4 xl:gap-5 xl:py-3">
          <Fact label="Pipeline" value={release.pipeline} icon={GitBranch} />
          <Fact label="Target stage" value={release.target} icon={Target} />
          <Fact label="Current stage" value={release.currentStage} icon={Layers} />
          <Fact
            label="Hooks"
            value={totalHooks > 0 ? `${completedHooks}/${totalHooks}` : "—"}
            icon={Workflow}
          />
        </dl>

        <div className="grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
          {release.application && (
            <Link
              className="inline-flex min-w-0 items-center gap-2 rounded-md border border-border/70 px-3 py-2 font-mono hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={fleetDetailHref("application", {
                namespace: release.namespace,
                name: release.application,
              }, releaseQueryParameters(query))}
              aria-label={`Open application ${release.application}`}
            >
              <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{release.application}</span>
            </Link>
          )}
          {release.rolloutRef && (
            <Link
              className="inline-flex min-w-0 items-center gap-2 rounded-md border border-border/70 px-3 py-2 font-mono hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={fleetDetailHref("rollout", {
                namespace: release.namespace,
                name: release.rolloutRef,
              }, releaseQueryParameters(query))}
              aria-label={`Open rollout ${release.rolloutRef}`}
            >
              <Boxes className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{release.rolloutRef}</span>
            </Link>
          )}
          {release.canaryWeight > 0 && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border/70 px-3 py-2">
              <span className="font-medium">Canary {release.canaryWeight}%</span>
              <span className="font-mono text-muted-foreground">step {release.canaryStepIndex}</span>
            </div>
          )}
          {release.renderedManifestSnapshot && (
            <div className="flex min-w-0 items-center gap-2 rounded-md border border-border/70 px-3 py-2">
              <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">Snapshot</span>
              <span className="truncate font-mono">{release.renderedManifestSnapshot}</span>
            </div>
          )}
        </div>

        <PolicySummary results={release.policyResults} />

        {release.rolledBackTo && (
          <div className="flex items-center gap-2 border-l-2 border-orange-500 bg-orange-500/10 px-3 py-2 text-xs text-orange-400">
            <RotateCcw className="size-3.5" aria-hidden="true" />
            Rolled back to <span className="font-mono font-medium">{release.rolledBackTo}</span>
          </div>
        )}
      </article>
    </li>
  )
}

function releaseQueryParameters(query: ReleaseQueryInput): URLSearchParams {
  if (typeof query === "string") return new URLSearchParams(query)
  if (query instanceof URLSearchParams) return new URLSearchParams(query)
  return serializeReleaseQuery(query)
}

function LoadingSkeleton() {
  return (
    <div data-testid="release-grid-skeleton" className="space-y-3 p-5" aria-hidden="true">
      {[0, 1, 2].map((item) => (
        <div key={item} className="space-y-3 border-b border-border/70 pb-4 last:border-0">
          <div className="h-4 w-44 animate-pulse rounded bg-muted" />
          <div className="h-12 animate-pulse rounded bg-muted/70" />
        </div>
      ))}
    </div>
  )
}

export function ReleaseGrid({
  releases,
  query = "",
  loading = false,
  search = "",
  error,
  onRetry,
}: ReleaseGridProps) {
  let status = ""
  if (error) status = error
  else if (loading && releases.length === 0) status = "Loading releases…"
  else if (loading) status = "Updating releases…"
  else if (releases.length === 0 && search) status = `No releases match “${search}”`
  else if (releases.length === 0) status = "No releases yet"
  else status = `${releases.length} releases shown`

  return (
    <section aria-labelledby="release-inventory-heading" className="overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-5">
        <h2 id="release-inventory-heading" className="text-sm font-semibold">
          Release inventory
        </h2>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{releases.length} shown</span>
      </div>

      <div role="status" aria-live="polite" aria-atomic="true" className={status ? "border-b border-border/70 px-4 py-2 text-xs text-muted-foreground sm:px-5" : "sr-only"}>
        <span>{status}</span>
        {error && onRetry && (
          <Button className="ml-3" size="xs" variant="outline" onClick={onRetry}>
            Retry releases
          </Button>
        )}
      </div>

      {loading && releases.length === 0 ? (
        <LoadingSkeleton />
      ) : error && releases.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
          <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium">Release inventory unavailable</p>
          <p className="text-xs text-muted-foreground">Retry to restore the latest release state.</p>
        </div>
      ) : releases.length > 0 ? (
        <ul aria-label="Releases">
          {releases.map((release) => (
            <ReleaseItem
              key={`${release.namespace}/${release.name}`}
              release={release}
              query={query}
            />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
          <span className="flex size-10 items-center justify-center rounded-full border border-border bg-muted/50">
            <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <p className="text-sm font-medium">
            {search ? `No releases match “${search}”` : "No releases yet"}
          </p>
          {!search && (
            <p className="text-xs text-muted-foreground">
              Create a Release resource to start promoting pipelines
            </p>
          )}
        </div>
      )}
    </section>
  )
}
