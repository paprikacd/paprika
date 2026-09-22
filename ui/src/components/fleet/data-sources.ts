"use client"

import { useMemo } from "react"

import { DataClass, DataState } from "@/gen/paprika/v1/api_pb"
import { getFleetClient } from "@/lib/fleet-client"
import {
  DATA_SOURCES_QUERY_KEY,
  useDataSourceIndex,
  type DataSourceIndex,
} from "@/lib/data-state"

export { DATA_SOURCES_QUERY_KEY }

/**
 * `GetDataSources` is the console's boot-time capability probe: exactly one
 * status per data class, always, whether or not anything is configured. It is
 * what stops this view drawing a column the control plane cannot fill.
 *
 * The proto enums stop at this module. Everything downstream reads the same
 * lowercase names the rest of the fleet layer uses.
 */
export type DataClassName =
  | "cluster_inventory"
  | "cluster_capacity"
  | "application_signals"
  | "cost"
  | "source_events"
  | "rollout_history"
  | "pipeline_runs"
  | "commit_metadata"
  | "ownership"
  | "drift_detail"
  | "lifecycle"

export type DataStateName =
  | "unspecified"
  | "ok"
  | "not_configured"
  | "not_available"
  | "stale"
  | "error"
  | "forbidden"

export interface DataSourceStatusView {
  dataClass: DataClassName
  state: DataStateName
  provider: string
  observedAtUnixMs: bigint
  stalenessBudgetMs: bigint
  unavailableReason: string
  retentionLimit: number
  retentionWindowMs: bigint
}

export type DataSourceMap = Partial<Record<DataClassName, DataSourceStatusView>>

const DATA_CLASS_NAMES: Partial<Record<DataClass, DataClassName>> = {
  [DataClass.CLUSTER_INVENTORY]: "cluster_inventory",
  [DataClass.CLUSTER_CAPACITY]: "cluster_capacity",
  [DataClass.APPLICATION_SIGNALS]: "application_signals",
  [DataClass.COST]: "cost",
  [DataClass.SOURCE_EVENTS]: "source_events",
  [DataClass.ROLLOUT_HISTORY]: "rollout_history",
  [DataClass.PIPELINE_RUNS]: "pipeline_runs",
  [DataClass.COMMIT_METADATA]: "commit_metadata",
  [DataClass.OWNERSHIP]: "ownership",
  [DataClass.DRIFT_DETAIL]: "drift_detail",
  [DataClass.LIFECYCLE]: "lifecycle",
}

const DATA_STATE_NAMES: Record<DataState, DataStateName> = {
  [DataState.UNSPECIFIED]: "unspecified",
  [DataState.OK]: "ok",
  [DataState.NOT_CONFIGURED]: "not_configured",
  [DataState.NOT_AVAILABLE]: "not_available",
  [DataState.STALE]: "stale",
  [DataState.ERROR]: "error",
  [DataState.FORBIDDEN]: "forbidden",
}

/**
 * Projects the console-wide probe index onto the lowercase names the fleet
 * layer speaks. The proto enums stop here.
 */
export function toDataSourceMap(
  index: DataSourceIndex | undefined,
): DataSourceMap | undefined {
  if (!index) return undefined
  const map: DataSourceMap = {}
  for (const source of index.values()) {
    const dataClass = DATA_CLASS_NAMES[source.dataClass]
    if (!dataClass) continue
    map[dataClass] = {
      dataClass,
      state: DATA_STATE_NAMES[source.state] ?? "unspecified",
      provider: source.provider,
      observedAtUnixMs: source.observedAtUnixMs,
      stalenessBudgetMs: source.stalenessBudgetMs,
      unavailableReason: source.unavailableReason,
      retentionLimit: source.retentionLimit,
      retentionWindowMs: source.retentionWindowMs,
    }
  }
  return map
}

export interface UseDataSourcesResult {
  sources: DataSourceMap | undefined
  isLoading: boolean
  error: unknown
}

/**
 * Fetched once per session, through the console-wide probe in
 * `@/lib/data-state` — this view holds no query of its own, it only renames
 * the answer.
 */
export function useDataSources(): UseDataSourcesResult {
  const probe = useDataSourceIndex(getFleetClient())
  const sources = useMemo(() => toDataSourceMap(probe.index), [probe.index])
  return { sources, isLoading: probe.isLoading, error: probe.isError || null }
}

export interface DataSurface {
  /** Whether the surface exists at all. `false` means render nothing. */
  present: boolean
  /** Whether numerics on this surface are real and may be drawn. */
  numeric: boolean
  /** Numbers are the last good sample and must carry an age badge. */
  stale: boolean
  state: DataStateName
  reason: string
  observedAtUnixMs?: bigint
}

const HIDDEN: DataSurface = {
  present: false,
  numeric: false,
  stale: false,
  state: "not_configured",
  reason: "",
}

/**
 * The degraded-mode contract in one function.
 *
 * `NOT_CONFIGURED`, `FORBIDDEN` and an absent probe all mean the surface must
 * not appear — a zero beside a board that should not exist is a lie, not a
 * placeholder. `NOT_AVAILABLE` and `ERROR` keep the surface but grey it with
 * the server's reason. `STALE` is the only non-OK state carrying numbers, and
 * it owes the reader an age badge.
 */
export function dataSurface(
  sources: DataSourceMap | undefined,
  dataClass: DataClassName,
): DataSurface {
  const source = sources?.[dataClass]
  if (!source) return HIDDEN

  switch (source.state) {
    case "ok":
      return {
        present: true,
        numeric: true,
        stale: false,
        state: "ok",
        reason: "",
        observedAtUnixMs: source.observedAtUnixMs,
      }
    case "stale":
      return {
        present: true,
        numeric: true,
        stale: true,
        state: "stale",
        reason: source.unavailableReason,
        observedAtUnixMs: source.observedAtUnixMs,
      }
    case "not_available":
    case "error":
      return {
        present: true,
        numeric: false,
        stale: false,
        state: source.state,
        reason: source.unavailableReason,
        observedAtUnixMs: source.observedAtUnixMs,
      }
    default:
      return { ...HIDDEN, state: source.state }
  }
}

/** Short, human age for a `STALE` surface: `4m old`, `2h old`. */
export function formatObservedAge(
  observedAtUnixMs: bigint | undefined,
  now: number = Date.now(),
): string {
  if (observedAtUnixMs === undefined || observedAtUnixMs <= BigInt(0)) return ""
  const seconds = Math.max(0, Math.round((now - Number(observedAtUnixMs)) / 1000))
  if (seconds < 60) return `${seconds}s old`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m old`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h old`
  return `${Math.floor(hours / 24)}d old`
}
