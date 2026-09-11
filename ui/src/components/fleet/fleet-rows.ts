import type {
  FleetApplicationSummary,
  FleetHealthStatus,
  FleetSyncStatus,
} from "@/lib/fleet-client"
import type { FleetGroup, NamespacedKey } from "@/lib/fleet-query"
import { STATUS_TONES, toneRank, type StatusTone } from "@/lib/status-tone"

/**
 * The fleet layer speaks lowercase string unions; `status-tone.ts` resolves
 * the protobuf enums. These two bridge the gap without either side learning
 * about the other.
 */
export function healthToneOf(health: FleetHealthStatus): StatusTone {
  switch (health) {
    case "healthy":
      return "healthy"
    case "progressing":
      return "progressing"
    case "degraded":
      return "degraded"
    case "failed":
      return "failed"
    case "missing":
      return "missing"
    default:
      return "unknown"
  }
}

export function healthLabelOf(health: FleetHealthStatus): string {
  return STATUS_TONES[healthToneOf(health)].label
}

export function syncToneOf(sync: FleetSyncStatus): StatusTone {
  switch (sync) {
    case "synced":
      return "healthy"
    case "out_of_sync":
      return "degraded"
    default:
      return "unknown"
  }
}

/** Sync has its own word for a drifted target. */
export function syncLabelOf(sync: FleetSyncStatus): string {
  switch (sync) {
    case "synced":
      return "Synced"
    case "out_of_sync":
      return "Drifted"
    default:
      return "Unknown"
  }
}

export function identityOf(identity: NamespacedKey | undefined): string {
  return identity ? `${identity.namespace}/${identity.name}` : ""
}

export function projectLabelOf(application: FleetApplicationSummary): string {
  return application.project ? identityOf(application.project) : ""
}

export function targetLabelOf(application: FleetApplicationSummary): string {
  const cluster = application.currentClusterLabel
  const stage = application.currentStage
  if (cluster && stage) return `${cluster} · ${stage}`
  return cluster || stage
}

/**
 * Why this application is in the attention queue, in the operator's words.
 * Every branch is backed by a field the fleet index actually returns.
 */
export function attentionReasonOf(application: FleetApplicationSummary): string {
  const drifted = application.sync === "out_of_sync"
  switch (application.health) {
    case "failed":
      return drifted ? "workload failing · drifted" : "workload failing"
    case "missing":
      return "source unreachable"
    case "degraded":
      return drifted ? "degraded · drifted" : "degraded"
    case "progressing":
      return drifted ? "rollout in progress · drifted" : "rollout in progress"
    default:
      if (drifted) return "drifted"
      return application.blockedGateCount > 0 ? "gate blocked" : "needs review"
  }
}

export interface ApplicationGroup {
  key: string
  /** `PROJECT` / `CLUSTER` / `STAGE`, or empty when ungrouped. */
  kicker: string
  label: string
  applications: readonly FleetApplicationSummary[]
  targetCount: number
  unhealthyCount: number
  driftedCount: number
  worst: StatusTone
  mix: readonly { tone: StatusTone; count: number }[]
}

export type GroupDimension = FleetGroup | "none"

const GROUP_KICKERS: Record<FleetGroup, string> = {
  project: "PROJECT",
  cluster: "CLUSTER",
  stage: "STAGE",
  health: "HEALTH",
}

/** Fixed order, worst first, so a mix bar always reads the same way. */
const MIX_ORDER: readonly StatusTone[] = [
  "failed",
  "missing",
  "degraded",
  "progressing",
  "unknown",
  "pending",
  "healthy",
]

function groupKeyOf(
  application: FleetApplicationSummary,
  dimension: FleetGroup,
): string {
  switch (dimension) {
    case "project":
      return projectLabelOf(application) || "No project"
    case "cluster":
      return application.currentClusterLabel || "No target"
    case "stage":
      return application.currentStage || "No stage"
    case "health":
      return healthLabelOf(application.health)
  }
}

/**
 * Grouping is computed over the loaded window only — the applications index
 * groups the map and the matrix server-side, but not the list — so a group's
 * counts describe the rows on screen, never the whole fleet.
 */
export function groupApplications(
  applications: readonly FleetApplicationSummary[],
  dimension: GroupDimension,
): ApplicationGroup[] {
  if (dimension === "none") {
    return applications.length === 0
      ? []
      : [summarize("all", "", "All applications", applications)]
  }

  const buckets = new Map<string, FleetApplicationSummary[]>()
  for (const application of applications) {
    const key = groupKeyOf(application, dimension)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(application)
    else buckets.set(key, [application])
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) =>
      summarize(`${dimension}:${key}`, GROUP_KICKERS[dimension], key, rows),
    )
}

function summarize(
  key: string,
  kicker: string,
  label: string,
  applications: readonly FleetApplicationSummary[],
): ApplicationGroup {
  const counts = new Map<StatusTone, number>()
  let targetCount = 0
  let unhealthyCount = 0
  let driftedCount = 0
  let worst: StatusTone = "healthy"

  for (const application of applications) {
    const tone = healthToneOf(application.health)
    counts.set(tone, (counts.get(tone) ?? 0) + 1)
    targetCount += application.targets.length
    if (tone !== "healthy") unhealthyCount += 1
    if (application.sync === "out_of_sync") driftedCount += 1
    if (toneRank(tone) < toneRank(worst)) worst = tone
  }

  return {
    key,
    kicker,
    label,
    applications,
    targetCount,
    unhealthyCount,
    driftedCount,
    worst,
    mix: MIX_ORDER.filter((tone) => (counts.get(tone) ?? 0) > 0).map((tone) => ({
      tone,
      count: counts.get(tone) ?? 0,
    })),
  }
}

/** `4 apps · 6 targets · 1 unhealthy · 1 drifted` */
export function groupMetaOf(group: ApplicationGroup): string {
  const parts = [plural(group.applications.length, "app")]
  if (group.targetCount > 0) parts.push(plural(group.targetCount, "target"))
  if (group.unhealthyCount > 0) parts.push(`${group.unhealthyCount} unhealthy`)
  if (group.driftedCount > 0) parts.push(`${group.driftedCount} drifted`)
  return parts.join(" · ")
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`
}
