import {
  FleetHealth,
  FleetReleaseState,
  FleetRolloutState,
  FleetSyncState,
} from "@/gen/paprika/v1/api_pb"

/**
 * The console resolves every state it can show — health, sync, release,
 * rollout, step — onto one of seven tones. A tone carries a glyph, a label
 * and three colour roles: `text`, `line` and `fill`.
 *
 * Keeping the set closed is the point. A screen that invents an eighth
 * colour for one badge stops reading as one system.
 */
export type StatusTone =
  | "healthy"
  | "progressing"
  | "degraded"
  | "failed"
  | "missing"
  | "unknown"
  | "pending"

interface ToneSpec {
  /** Single character shown in compact tiles and glyph boxes. */
  readonly glyph: string
  readonly label: string
  /** Foreground for text and glyphs on the tinted fill. */
  readonly text: string
  /** Hairline border. */
  readonly line: string
  /** Tinted background. `pending` is deliberately transparent. */
  readonly fill: string
  /** Solid background for bars and strips, where a tint is too weak. */
  readonly bar: string
}

/**
 * Class strings are written out rather than composed, because Tailwind only
 * sees class names it can find as literals in the source.
 */
export const STATUS_TONES: Record<StatusTone, ToneSpec> = {
  healthy: {
    glyph: "✓",
    label: "Healthy",
    text: "text-status-healthy-text",
    line: "border-status-healthy-line",
    fill: "bg-status-healthy-fill",
    bar: "bg-status-healthy-line",
  },
  progressing: {
    glyph: "↻",
    label: "Progressing",
    text: "text-status-progressing-text",
    line: "border-status-progressing-line",
    fill: "bg-status-progressing-fill",
    bar: "bg-status-progressing-line",
  },
  degraded: {
    glyph: "!",
    label: "Degraded",
    text: "text-status-degraded-text",
    line: "border-status-degraded-line",
    fill: "bg-status-degraded-fill",
    bar: "bg-status-degraded-line",
  },
  failed: {
    glyph: "×",
    label: "Failed",
    text: "text-status-failed-text",
    line: "border-status-failed-line",
    fill: "bg-status-failed-fill",
    bar: "bg-status-failed-line",
  },
  missing: {
    glyph: "∅",
    label: "Missing",
    text: "text-status-missing-text",
    line: "border-status-missing-line",
    fill: "bg-status-missing-fill",
    bar: "bg-status-missing-line",
  },
  unknown: {
    glyph: "?",
    label: "Unknown",
    text: "text-status-unknown-text",
    line: "border-status-unknown-line",
    fill: "bg-status-unknown-fill",
    bar: "bg-status-unknown-line",
  },
  pending: {
    glyph: "·",
    label: "Pending",
    text: "text-status-pending-text",
    line: "border-status-pending-line",
    fill: "bg-status-pending-fill",
    bar: "bg-status-pending-line",
  },
}

/**
 * The same seven tones as literal values, for the canvas surfaces (treemap,
 * fleet map) that cannot read Tailwind classes. Kept beside `STATUS_TONES` so
 * the two cannot drift.
 */
export const STATUS_TONE_HEX: Record<
  StatusTone,
  { text: string; line: string; fill: string }
> = {
  healthy: { text: "#3f6b48", line: "#7fae86", fill: "#e6f2e8" },
  progressing: { text: "#2c455d", line: "#8bb0d0", fill: "#e7f0f8" },
  degraded: { text: "#8a5f22", line: "#e0ad66", fill: "#fdf2df" },
  failed: { text: "#9c3f39", line: "#dd9490", fill: "#fbe9e8" },
  missing: { text: "#5b5468", line: "#aea8bd", fill: "#efedf4" },
  unknown: { text: "#5d5d60", line: "#c2c2c6", fill: "#f4f4f6" },
  pending: { text: "#8e8e92", line: "#d4d4d7", fill: "#ffffff" },
}

/** Ground and ink for canvas surfaces, matching the token layer. */
export const CANVAS_COLORS = {
  ground: "#ffffff",
  groupFill: "#f5f5f8",
  rule: "rgba(29,31,32,0.16)",
  ink: "#1d1f20",
  muted: "#5d5d60",
  selected: "#5980a6",
} as const

/**
 * Worst-first. Used to roll a set of children up to a single parent tone and
 * to sort attention queues, so the thing most likely to be an incident is
 * what a reader's eye lands on first.
 */
const TONE_RANK: readonly StatusTone[] = [
  "failed",
  "missing",
  "degraded",
  "progressing",
  "unknown",
  "pending",
  "healthy",
]

export function worstTone(tones: readonly StatusTone[]): StatusTone {
  let worst: StatusTone = "healthy"
  let worstAt = TONE_RANK.length
  for (const tone of tones) {
    const at = TONE_RANK.indexOf(tone)
    if (at !== -1 && at < worstAt) {
      worstAt = at
      worst = tone
    }
  }
  return worst
}

export function toneRank(tone: StatusTone): number {
  const at = TONE_RANK.indexOf(tone)
  return at === -1 ? TONE_RANK.length : at
}

export function healthTone(health: FleetHealth | undefined): StatusTone {
  switch (health) {
    case FleetHealth.HEALTHY:
      return "healthy"
    case FleetHealth.PROGRESSING:
      return "progressing"
    case FleetHealth.DEGRADED:
      return "degraded"
    case FleetHealth.FAILED:
      return "failed"
    case FleetHealth.MISSING:
      return "missing"
    default:
      return "unknown"
  }
}

export function healthLabel(health: FleetHealth | undefined): string {
  return STATUS_TONES[healthTone(health)].label
}

export function syncTone(sync: FleetSyncState | undefined): StatusTone {
  switch (sync) {
    case FleetSyncState.SYNCED:
      return "healthy"
    case FleetSyncState.OUT_OF_SYNC:
      return "degraded"
    default:
      return "unknown"
  }
}

/** Sync has its own vocabulary — "Drifted" reads better than "Degraded". */
export function syncLabel(sync: FleetSyncState | undefined): string {
  switch (sync) {
    case FleetSyncState.SYNCED:
      return "Synced"
    case FleetSyncState.OUT_OF_SYNC:
      return "Drifted"
    default:
      return "Unknown"
  }
}

export function rolloutTone(state: FleetRolloutState | undefined): StatusTone {
  switch (state) {
    case FleetRolloutState.HEALTHY:
      return "healthy"
    case FleetRolloutState.PROGRESSING:
      return "progressing"
    case FleetRolloutState.PAUSED:
      return "pending"
    case FleetRolloutState.DEGRADED:
      return "degraded"
    case FleetRolloutState.FAILED:
    case FleetRolloutState.ABORTED:
      return "failed"
    case FleetRolloutState.ROLLED_BACK:
      return "degraded"
    case FleetRolloutState.PENDING:
      return "pending"
    default:
      return "unknown"
  }
}

export function rolloutLabel(state: FleetRolloutState | undefined): string {
  switch (state) {
    case FleetRolloutState.HEALTHY:
      return "Healthy"
    case FleetRolloutState.PROGRESSING:
      return "Progressing"
    case FleetRolloutState.PAUSED:
      return "Paused"
    case FleetRolloutState.DEGRADED:
      return "Degraded"
    case FleetRolloutState.FAILED:
      return "Failed"
    case FleetRolloutState.ABORTED:
      return "Aborted"
    case FleetRolloutState.ROLLED_BACK:
      return "Rolled back"
    case FleetRolloutState.PENDING:
      return "Pending"
    default:
      return "Unknown"
  }
}

export function releaseTone(state: FleetReleaseState | undefined): StatusTone {
  switch (state) {
    case FleetReleaseState.COMPLETE:
      return "healthy"
    case FleetReleaseState.PROMOTING:
    case FleetReleaseState.CANARYING:
    case FleetReleaseState.VERIFYING:
      return "progressing"
    case FleetReleaseState.AWAITING_APPROVAL:
    case FleetReleaseState.PENDING:
      return "pending"
    case FleetReleaseState.FAILED:
      return "failed"
    case FleetReleaseState.ROLLED_BACK:
      return "degraded"
    case FleetReleaseState.SUPERSEDED:
      return "unknown"
    default:
      return "unknown"
  }
}

export function releaseLabel(state: FleetReleaseState | undefined): string {
  switch (state) {
    case FleetReleaseState.PENDING:
      return "Pending"
    case FleetReleaseState.PROMOTING:
      return "Promoting"
    case FleetReleaseState.CANARYING:
      return "Canarying"
    case FleetReleaseState.VERIFYING:
      return "Verifying"
    case FleetReleaseState.COMPLETE:
      return "Complete"
    case FleetReleaseState.FAILED:
      return "Failed"
    case FleetReleaseState.ROLLED_BACK:
      return "Rolled back"
    case FleetReleaseState.SUPERSEDED:
      return "Superseded"
    case FleetReleaseState.AWAITING_APPROVAL:
      return "Awaiting approval"
    default:
      return "Unknown"
  }
}
