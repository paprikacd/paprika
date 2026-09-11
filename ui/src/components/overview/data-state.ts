/**
 * The overview's window onto the console-wide degraded-mode contract.
 *
 * The contract itself — the gate, the probe, the query key, the age
 * formatting — lives in `@/lib/data-state` and is shared by every view. This
 * module re-exports it so the overview's call sites read locally, and adds
 * only what is genuinely overview-specific.
 */
export {
  dataSourceFor,
  dataStateOf,
  formatAge,
  formatDuration,
  indexDataSources,
  isStale,
  isUnavailable,
  numbersAreReal,
  surfaceExists,
  type DataSourceIndex,
} from "@/lib/data-state"

export function plural(count: number, singular: string, pluralForm?: string) {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`)
}
