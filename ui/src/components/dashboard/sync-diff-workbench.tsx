"use client"

import { useMemo, useState } from "react"
import { CheckCircle2, FileDiff, GitCompare, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  mergeResourcesFromApplication,
  type MergedResource,
} from "@/components/dashboard/resource-list-table"

type SyncFilter = "all" | "drifted" | "missing" | "pruned" | "degraded" | "synced"

interface SyncApplicationLike {
  name: string
  namespace: string
  outOfSync?: number
  prunedResources?: number
  resources?: { kind: string; name: string; namespace: string; status: string }[]
  resourceHealth?: { kind: string; name: string; namespace: string; health: string; message: string }[]
}

const filters: { id: SyncFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "drifted", label: "Drifted" },
  { id: "missing", label: "Missing" },
  { id: "pruned", label: "Pruned" },
  { id: "degraded", label: "Degraded" },
  { id: "synced", label: "Synced" },
]

export function SyncDiffWorkbench({
  application,
  onSelectResource,
}: {
  application: SyncApplicationLike
  onSelectResource: (resource: MergedResource) => void
}) {
  const [filter, setFilter] = useState<SyncFilter>("all")
  const resources = useMemo(() => mergeResourcesFromApplication(application), [application])
  const stats = useMemo(() => summarizeResources(resources, application.prunedResources), [resources, application.prunedResources])
  const filtered = useMemo(
    () =>
      resources.filter((resource) => {
        if (filter === "all") return true
        if (filter === "drifted") return isDrifted(resource)
        if (filter === "missing") return resource.syncStatus === "Missing"
        if (filter === "pruned") return resource.syncStatus === "Pruned"
        if (filter === "degraded") return isDegraded(resource)
        return resource.syncStatus === "Synced"
      }),
    [filter, resources],
  )

  return (
    <Card data-testid="sync-diff-workbench">
      <CardHeader>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-balance">
              <GitCompare className="size-5" />
              Sync Diff
            </CardTitle>
            <CardDescription className="text-pretty">
              Application-level drift queue. Open a resource to inspect desired, live, events, logs, and diff.
            </CardDescription>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[30rem]">
            <Metric value={resources.length} label="resources" />
            <Metric value={stats.drifted} label="drifted" tone={stats.drifted > 0 ? "warning" : "neutral"} />
            <Metric value={stats.degraded} label="degraded" tone={stats.degraded > 0 ? "danger" : "neutral"} />
            <Metric value={stats.pruned} label="pruned" tone={stats.pruned > 0 ? "warning" : "neutral"} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Search className="size-4 text-muted-foreground" />
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={`min-h-10 rounded-lg px-3 text-xs font-medium transition-[background-color,color,box-shadow,scale] active:scale-[0.96] ${
                filter === item.id
                  ? "bg-foreground text-background shadow-sm"
                  : "bg-muted/30 text-muted-foreground ring-1 ring-foreground/10 hover:text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {resources.length === 0 ? (
          <EmptyDiffState title="No resources reported" message="This application has not published resource sync status yet." />
        ) : filtered.length === 0 ? (
          <EmptyDiffState title="No matching resources" message="Change the filter to inspect another sync state." />
        ) : (
          <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
            <div className="grid grid-cols-[minmax(0,1.3fr)_8rem_8rem_7rem] bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground max-md:hidden">
              <span>Resource</span>
              <span>Sync</span>
              <span>Health</span>
              <span className="text-right">Action</span>
            </div>
            <div className="divide-y divide-foreground/5">
              {filtered.map((resource) => (
                <ResourceDiffRow
                  key={`${resource.kind}/${resource.namespace}/${resource.name}`}
                  resource={resource}
                  onSelectResource={onSelectResource}
                />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ResourceDiffRow({
  resource,
  onSelectResource,
}: {
  resource: MergedResource
  onSelectResource: (resource: MergedResource) => void
}) {
  return (
    <div className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(0,1.3fr)_8rem_8rem_7rem] md:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <FileDiff className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-mono text-xs font-medium">{resource.kind}</span>
          <span className="min-w-0 truncate font-mono text-xs text-foreground">{resource.name}</span>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{resource.namespace || "cluster-scoped"}</p>
        {resource.healthMessage && (
          <p className="mt-1 text-xs text-muted-foreground text-pretty">{resource.healthMessage}</p>
        )}
      </div>
      <StatusPill value={resource.syncStatus || "Unknown"} />
      <StatusPill value={resource.health || "Unknown"} />
      <div className="flex justify-start md:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Open diff for ${resource.kind} ${resource.name}`}
          onClick={() => onSelectResource(resource)}
          className="transition-[scale] active:scale-[0.96]"
        >
          Open
        </Button>
      </div>
    </div>
  )
}

function EmptyDiffState({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl bg-muted/20 px-4 py-8 text-center ring-1 ring-foreground/10">
      <CheckCircle2 className="size-6 text-emerald-500" />
      <p className="text-sm font-medium text-foreground/80">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground text-pretty">{message}</p>
    </div>
  )
}

function Metric({
  value,
  label,
  tone = "neutral",
}: {
  value: number
  label: string
  tone?: "neutral" | "warning" | "danger"
}) {
  const toneClass = tone === "danger" ? "text-destructive" : tone === "warning" ? "text-amber-600 dark:text-amber-300" : "text-foreground"
  return (
    <div className="rounded-xl bg-muted/25 px-3 py-2 ring-1 ring-foreground/10">
      <span className="sr-only">
        {value} {label}
      </span>
      <div className={`text-lg font-semibold tabular-nums ${toneClass}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function StatusPill({ value }: { value: string }) {
  const normalized = value.toLowerCase()
  const variant =
    normalized === "synced" || normalized === "healthy"
      ? "default"
      : normalized === "degraded" || normalized === "failed" || normalized === "outofsync" || normalized === "missing"
        ? "destructive"
        : "secondary"

  return (
    <div>
      <Badge variant={variant} className="max-w-full truncate">
        {value}
      </Badge>
    </div>
  )
}

function summarizeResources(resources: MergedResource[], prunedResources?: number) {
  const summary = resources.reduce(
    (summary, resource) => {
      if (isDrifted(resource)) summary.drifted += 1
      if (isDegraded(resource)) summary.degraded += 1
      if (prunedResources === undefined && resource.syncStatus === "Pruned") summary.pruned += 1
      return summary
    },
    { drifted: 0, degraded: 0, pruned: prunedResources ?? 0 },
  )
  return summary
}

function isDrifted(resource: MergedResource) {
  return resource.syncStatus !== "" && resource.syncStatus !== "Synced"
}

function isDegraded(resource: MergedResource) {
  return ["Degraded", "Failed"].includes(resource.health)
}
