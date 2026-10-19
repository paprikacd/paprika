"use client"

import Link from "next/link"

import { healthLabelOf, healthToneOf, syncLabelOf, syncToneOf } from "@/components/fleet/fleet-rows"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import type { FleetApplicationSummary, FleetConnectionStatus } from "@/lib/fleet-client"

const CONNECTION_LABELS: Record<FleetConnectionStatus, string> = {
  healthy: "Connected",
  unhealthy: "Disconnected",
  disabled: "Disabled",
  not_configured: "Not configured",
  unspecified: "Unknown",
}

export function ApplicationPlacements({ application }: { application: FleetApplicationSummary }) {
  if (application.targets.length === 0) return null
  return (
    <Blueprint aria-label="Cluster placements">
      <BoardHeader title="Cluster placements" meta={`${application.targets.length} placements`} />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-note">
          <thead className="border-b border-rule bg-muted font-mono text-meta text-muted-foreground">
            <tr>
              <th scope="col" className="px-3.5 py-2">Cluster</th>
              <th scope="col" className="px-3.5 py-2">Stage</th>
              <th scope="col" className="px-3.5 py-2">Health</th>
              <th scope="col" className="px-3.5 py-2">Connection</th>
            </tr>
          </thead>
          <tbody>
            {application.targets.map((target) => (
              <tr key={target.stableId} className="border-b border-rule-soft last:border-b-0">
                <th scope="row" className="px-3.5 py-2 font-normal">
                  <span className="block font-cond text-label font-semibold">{target.clusterLabel || target.cluster?.name || "Unknown cluster"}</span>
                  {target.cluster ? <span className="block font-mono text-meta text-muted-foreground">{target.cluster.namespace}/{target.cluster.name}</span> : null}
                </th>
                <td className="px-3.5 py-2">{target.stage || "—"}</td>
                <td className="px-3.5 py-2"><StatusPill tone={healthToneOf(target.health)} label={healthLabelOf(target.health)} /></td>
                <td className="px-3.5 py-2">{CONNECTION_LABELS[target.clusterConnection]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Blueprint>
  )
}

export function ObservedApplicationDetail({ application, refreshError }: { application: FleetApplicationSummary; refreshError?: boolean }) {
  const identity = application.identity
  return (
    <div className="bg-background">
      <div className="border-b border-rule bg-card px-5 py-4">
        <nav aria-label="Breadcrumb" className="font-mono text-meta text-muted-foreground">
          <Link href="/dashboard/applications/" className="text-steel-700">Applications</Link>
          <span aria-hidden> / </span>{identity?.namespace}/{identity?.name}
        </nav>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-cond text-title font-semibold">{identity?.name}</h1>
          <StatusPill tone={healthToneOf(application.health)} label={healthLabelOf(application.health)} />
          <StatusPill tone={syncToneOf(application.sync)} label={syncLabelOf(application.sync)} />
          <span className="font-mono text-meta text-muted-foreground">Read-only observation</span>
        </div>
        <p className="mt-2 text-note text-muted-foreground">Satellites report this application&apos;s state across its clusters.</p>
        {refreshError ? <p role="alert" className="mt-2 text-note text-status-degraded-text">Could not refresh cluster observations. Showing the last available report.</p> : null}
        {application.attentionDetail ? <p role="status" className="mt-2 text-note text-muted-foreground">{application.attentionDetail}</p> : null}
      </div>
      <div className="space-y-4 p-5">
        <Blueprint aria-label="Application observation">
          <BoardHeader title="Observed state" />
          <dl className="grid gap-4 p-3.5 text-note sm:grid-cols-3">
            <div><dt className="text-muted-foreground">Reported resources</dt><dd className="mt-1 font-mono">{application.resourceCount}</dd></div>
            <div><dt className="text-muted-foreground">Drift</dt><dd className="mt-1 font-mono">{application.sync === "unknown" || application.sync === "unspecified" ? "Unknown" : `${application.driftCount} out of sync`}</dd></div>
            <div><dt className="text-muted-foreground">Source revision</dt><dd className="mt-1 break-all font-mono">{application.sourceRevision || "Unknown"}</dd></div>
          </dl>
        </Blueprint>
        <ApplicationPlacements application={application} />
      </div>
    </div>
  )
}
