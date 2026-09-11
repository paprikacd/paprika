"use client"

import { useQuery } from "@tanstack/react-query"

import {
  DataClass,
  DataState,
  type DataSourceStatus,
} from "@/gen/paprika/v1/api_pb"

/**
 * The degraded-mode contract of 01-backend-design.md §4, in one module.
 *
 * `GetDataSources` is the console's boot-time capability probe: it answers
 * with exactly one `DataSourceStatus` per `DataClass`, always, whether or not
 * anything is configured. A surface asks the probe "does this class exist
 * here?" once, instead of firing the RPC behind it and guessing from an empty
 * result — because "empty because nothing is configured" and "empty because
 * there is genuinely nothing to show" read identically on the wire, and
 * telling an operator the wrong one of those wastes an afternoon.
 *
 * This file is the *only* place that decision is spelled out, and the only
 * place the probe is fetched. Six views previously carried their own copy;
 * three of them cached different shapes under the same react-query key, which
 * crashed the app on the second route visited. One module, one key, one shape.
 */

/** The canonical cached shape. Every projection is derived from this. */
export type DataSourceIndex = ReadonlyMap<DataClass, DataSourceStatus>

/**
 * One key for the whole console. Changing this is a breaking change: every
 * view shares this cache entry so the probe is fetched once per session.
 */
export const DATA_SOURCES_QUERY_KEY = ["console", "data-sources"] as const

export function indexDataSources(
  sources: readonly DataSourceStatus[] | undefined,
): DataSourceIndex {
  const index = new Map<DataClass, DataSourceStatus>()
  for (const source of sources ?? []) index.set(source.dataClass, source)
  return index
}

/**
 * Accepts either the indexed probe or the raw `sources` array a response
 * carries, because both turn up at call sites and neither is worth a
 * conversion at the point of asking.
 */
export function findDataSource(
  sources: DataSourceIndex | readonly DataSourceStatus[] | undefined | null,
  dataClass: DataClass,
): DataSourceStatus | undefined {
  if (!sources) return undefined
  if (Array.isArray(sources)) {
    return sources.find((source) => source.dataClass === dataClass)
  }
  return (sources as DataSourceIndex).get(dataClass)
}

/** Alias of `findDataSource`, kept for call sites that read better this way. */
export const dataSourceFor = findDataSource

export function dataStateOf(
  index: DataSourceIndex | undefined | null,
  dataClass: DataClass,
): DataState | undefined {
  return findDataSource(index, dataClass)?.state
}

/* ── The gate ─────────────────────────────────────────────────────────── */

/**
 * What a surface should do about the `DataState` of the class behind it.
 *
 * - `render`      the data is fresh and real
 * - `stale`       last-good numerics, shown with an age badge
 * - `unavailable` greyed with a reason; never a number
 * - `absent`      not rendered at all — no board, no column, no zero
 */
export type SurfaceDisposition = "render" | "stale" | "unavailable" | "absent"

export interface SurfaceGate {
  disposition: SurfaceDisposition
  state: DataState
  /** Server-authored, already sanitized. Empty when the server gave none. */
  reason: string
  observedAtUnixMs: bigint
  stalenessBudgetMs: bigint
}

/**
 * `NOT_CONFIGURED` and `FORBIDDEN` both mean "do not draw this surface", for
 * different reasons: nothing is collecting the data, or the caller may not see
 * it. `UNSPECIFIED` joins them because an unstated state is not a licence to
 * render — the console has not been told the data is real.
 */
export function dispositionFor(state: DataState): SurfaceDisposition {
  switch (state) {
    case DataState.OK:
      return "render"
    case DataState.STALE:
      return "stale"
    case DataState.NOT_AVAILABLE:
    case DataState.ERROR:
      return "unavailable"
    default:
      return "absent"
  }
}

const DISPOSITION_SEVERITY: Record<SurfaceDisposition, number> = {
  render: 0,
  stale: 1,
  unavailable: 2,
  absent: 3,
}

/**
 * Combines the boot-time capability probe with the state an individual
 * response reports about itself. The more restrictive of the two wins: a feed
 * that answers `NOT_CONFIGURED` is unconfigured even if the probe has not
 * caught up, and vice versa.
 */
export function gateFor(
  source: DataSourceStatus | undefined,
  responseState?: DataState,
): SurfaceGate {
  const states: DataState[] = []
  if (source) states.push(source.state)
  if (responseState !== undefined) states.push(responseState)
  if (states.length === 0) {
    return {
      disposition: "absent",
      state: DataState.UNSPECIFIED,
      reason: "",
      observedAtUnixMs: BigInt(0),
      stalenessBudgetMs: BigInt(0),
    }
  }

  let worst = states[0]
  for (const state of states) {
    if (
      DISPOSITION_SEVERITY[dispositionFor(state)] >
      DISPOSITION_SEVERITY[dispositionFor(worst)]
    ) {
      worst = state
    }
  }

  return {
    disposition: dispositionFor(worst),
    state: worst,
    reason: source?.unavailableReason ?? "",
    observedAtUnixMs: source?.observedAtUnixMs ?? BigInt(0),
    stalenessBudgetMs: source?.stalenessBudgetMs ?? BigInt(0),
  }
}

/** Convenience: gate a class straight off the index. */
export function gateForClass(
  index: DataSourceIndex | undefined | null,
  dataClass: DataClass,
  responseState?: DataState,
): SurfaceGate {
  return gateFor(findDataSource(index, dataClass), responseState)
}

/**
 * Whether a surface may be drawn at all. `NOT_CONFIGURED` means nothing
 * produces this class here, so the board, column or chip is absent — not
 * zeroed, not dashed. An unknown or absent state is treated the same way: the
 * console has not been told the class exists, so it must not draw it.
 */
export function surfaceExists(state: DataState | undefined): boolean {
  const disposition = dispositionFor(state ?? DataState.UNSPECIFIED)
  return disposition !== "absent"
}

/**
 * Whether the numerics on a surface are real. `STALE` is the only non-`OK`
 * state the server populates numbers in, and they must be rendered with an
 * age rather than as current.
 */
export function numbersAreReal(state: DataState | undefined): boolean {
  return state === DataState.OK || state === DataState.STALE
}

/** The two states in which a class carries numbers worth rendering. */
export const hasData = numbersAreReal

/** Numbers are real but are the last good sample, so they need an age. */
export function isStale(state: DataState | undefined): boolean {
  return state === DataState.STALE
}

/** Configured, but carrying no numbers: greyed, with the server's reason. */
export function isUnavailable(state: DataState | undefined): boolean {
  return state === DataState.NOT_AVAILABLE || state === DataState.ERROR
}

/* ── The one query ────────────────────────────────────────────────────── */

/**
 * The minimum client surface the probe needs. Every view already holds a
 * ConnectRPC `PromiseClient`, and tests inject a stub with this one method.
 */
export interface DataSourcesClient {
  getDataSources: (
    request: Record<string, never>,
    options?: { signal?: AbortSignal },
  ) => Promise<{ sources: DataSourceStatus[]; indexGeneration?: bigint }>
}

const FIVE_MINUTES = 5 * 60_000

/**
 * The one cached value. It keeps `indexGeneration` alongside the index
 * because the shell header stamps every view with the generation the probe
 * answered for, and re-fetching the probe to read it would defeat the point.
 */
export interface DataSourcesSnapshot {
  index: DataSourceIndex
  indexGeneration: bigint
}

export interface DataSourceProbe {
  index: DataSourceIndex | undefined
  indexGeneration: bigint | undefined
  isLoading: boolean
  isError: boolean
  /** True once the probe has answered either way — the point boards may draw. */
  isSettled: boolean
  /** Undefined until the probe answers, or if the server omitted the class. */
  reading: (dataClass: DataClass) => DataSourceStatus | undefined
  gate: (dataClass: DataClass, responseState?: DataState) => SurfaceGate
}

/**
 * The single probe query for the whole console. Capabilities change when an
 * operator installs a source, not between renders, so this is deliberately a
 * slow-moving query and is never refetched on window focus.
 */
export function useDataSourceIndex(client: DataSourcesClient): DataSourceProbe {
  const query = useQuery<DataSourcesSnapshot>({
    queryKey: DATA_SOURCES_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const response = await client.getDataSources({}, { signal })
      return {
        index: indexDataSources(response.sources),
        indexGeneration: response.indexGeneration ?? BigInt(0),
      }
    },
    staleTime: FIVE_MINUTES,
    refetchOnWindowFocus: false,
  })

  return {
    index: query.data?.index,
    indexGeneration: query.data?.indexGeneration,
    isLoading: query.isPending,
    isError: query.isError,
    isSettled: query.isSuccess || query.isError,
    reading: (dataClass) => findDataSource(query.data?.index, dataClass),
    gate: (dataClass, responseState) =>
      gateForClass(query.data?.index, dataClass, responseState),
  }
}

/* ── Ages ─────────────────────────────────────────────────────────────── */

/**
 * Ages are shown the way an operator says them: `6m`, `1h 12m`, `2d`. An
 * absent timestamp has no age, and says so rather than claiming "now".
 */
export function formatAge(
  unixMs: bigint | number | undefined,
  now: number = Date.now(),
): string {
  const at = unixMs === undefined ? 0 : Number(unixMs)
  if (!at || !now) return "unknown"
  return formatDuration(Math.max(0, now - at))
}

export function formatDuration(ms: bigint | number | undefined): string {
  const value = ms === undefined ? 0 : Number(ms)
  if (!Number.isFinite(value) || value <= 0) return "0m"
  const minutes = Math.floor(value / 60_000)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours < 24) return remainder ? `${hours}h ${remainder}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d`
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
