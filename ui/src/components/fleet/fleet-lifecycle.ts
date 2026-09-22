import type { FleetApplicationSummary } from "@/lib/fleet-client"
import type { StatusTone } from "@/lib/status-tone"

/**
 * The six delivery phases, in wire order. `LifecycleVector.states` is
 * positional — index 0 is source, index 5 is verify — so the names live here
 * rather than travelling with every row.
 */
export const LIFECYCLE_PHASES = [
  "source",
  "build",
  "test",
  "render",
  "deploy",
  "verify",
] as const

export type LifecyclePhaseName = (typeof LIFECYCLE_PHASES)[number]

export type LifecyclePhaseStateName =
  | "unspecified"
  | "not_applicable"
  | "pending"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "unknown"

export interface FleetLifecycleVector {
  /** Exactly six entries, in `LIFECYCLE_PHASES` order. */
  states: readonly LifecyclePhaseStateName[]
  observedAtUnixMs?: bigint
}

const PHASE_STATE_NAMES = new Set<string>([
  "unspecified",
  "not_applicable",
  "pending",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "unknown",
])

/**
 * `ApplicationSummary.lifecycle` exists on the wire but is not yet carried
 * through `fromApplicationSummary`, so this reads it defensively and returns
 * `undefined` when the row has no vector. A row without a vector draws no
 * strip: the six cells are a claim about six phases, and drawing them empty
 * would assert that all six are pending.
 */
export function applicationLifecycle(
  application: FleetApplicationSummary,
): FleetLifecycleVector | undefined {
  const candidate = (application as { lifecycle?: unknown }).lifecycle
  if (!candidate || typeof candidate !== "object") return undefined
  const states = (candidate as { states?: unknown }).states
  if (!Array.isArray(states) || states.length !== LIFECYCLE_PHASES.length) {
    return undefined
  }
  if (!states.every((state) => typeof state === "string" && PHASE_STATE_NAMES.has(state))) {
    return undefined
  }
  const observedAtUnixMs = (candidate as { observedAtUnixMs?: unknown })
    .observedAtUnixMs
  return {
    states: states as LifecyclePhaseStateName[],
    observedAtUnixMs:
      typeof observedAtUnixMs === "bigint" ? observedAtUnixMs : undefined,
  }
}

export function lifecyclePhaseTone(state: LifecyclePhaseStateName): StatusTone {
  switch (state) {
    case "succeeded":
      return "healthy"
    case "failed":
      return "failed"
    case "running":
      return "progressing"
    case "blocked":
      return "degraded"
    case "pending":
    case "not_applicable":
      return "pending"
    default:
      return "unknown"
  }
}

export function lifecyclePhaseLabel(state: LifecyclePhaseStateName): string {
  switch (state) {
    case "not_applicable":
      return "Not applicable"
    case "succeeded":
      return "Succeeded"
    case "failed":
      return "Failed"
    case "running":
      return "Running"
    case "blocked":
      return "Blocked"
    case "pending":
      return "Pending"
    default:
      return "Unknown"
  }
}

/** `test · Failed` — the strip cell's own description. */
export function lifecycleCellLabel(
  phase: LifecyclePhaseName,
  state: LifecyclePhaseStateName,
): string {
  return `${phase} · ${lifecyclePhaseLabel(state)}`
}
