import {
  AlertTriangle,
  ArchiveX,
  Clock3,
  LoaderCircle,
  ShieldX,
  Unplug,
} from "lucide-react"

import type { FleetDataStatus } from "@/lib/use-fleet-data"

export interface FleetStateNoticeProps {
  status: FleetDataStatus
}

const states = {
  loading: {
    title: "Loading fleet data",
    detail: "Reading the current application index.",
    role: "status" as const,
    icon: LoaderCircle,
  },
  empty: {
    title: "No applications match this scope",
    detail: "Adjust a filter or search term to widen the operational view.",
    role: "status" as const,
    icon: ArchiveX,
  },
  unauthorized: {
    title: "You do not have access to this fleet scope",
    detail: "The index excludes applications outside your authorized projects.",
    role: "alert" as const,
    icon: ShieldX,
  },
  unavailable: {
    title: "Fleet index unavailable",
    detail: "The deployment index is not ready. Existing application routes remain available.",
    role: "alert" as const,
    icon: Unplug,
  },
  stale: {
    title: "Showing previous fleet data",
    detail: "The requested presentation is loading; this snapshot may be out of date.",
    role: "status" as const,
    icon: Clock3,
  },
  partial: {
    title: "Some applications could not be loaded",
    detail: "Loaded rows remain available. Retry the next page when the service recovers.",
    role: "status" as const,
    icon: AlertTriangle,
  },
  error: {
    title: "Fleet query failed",
    detail: "Paprika could not complete this query. Your URL scope has been preserved.",
    role: "alert" as const,
    icon: AlertTriangle,
  },
}

export function FleetStateNotice({ status }: FleetStateNoticeProps) {
  if (status === "ready") return null

  const state = states[status]
  const Icon = state.icon
  const compact = status === "stale" || status === "partial"

  return (
    <div
      role={state.role}
      aria-live={state.role === "alert" ? "assertive" : "polite"}
      aria-atomic="true"
      className={
        compact
          ? "flex items-start gap-3 border-b border-border bg-muted/50 px-4 py-3 sm:px-6"
          : "mx-4 my-8 flex min-h-44 items-center gap-4 border border-border bg-card px-5 py-6 sm:mx-6 sm:px-7"
      }
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
        <Icon
          aria-hidden="true"
          className={status === "loading" ? "size-5 animate-spin motion-reduce:animate-none" : "size-5"}
        />
      </span>
      <span className="min-w-0">
        <strong className="block text-sm font-semibold text-foreground">{state.title}</strong>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{state.detail}</span>
      </span>
    </div>
  )
}
