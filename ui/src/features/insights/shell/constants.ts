import { type Dashboard } from "../schema"

/** After a manual refresh, queries ask the server for a fresh execution for this long, so the refreshed window is not served from the cache. */
export const MANUAL_REFRESH_BYPASS_MS = 5_000

export const NO_VARIABLES: NonNullable<Dashboard["variables"]> = []

// Shown after a save that leaves a dirty chart draft out of the dashboard. Closing the chart editor clears it.
export const UNAPPLIED_CHART_NOTICE = "Saved. Chart changes are still unapplied."
