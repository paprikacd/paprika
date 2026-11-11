import { createContext, useContext } from "react"

/**
 * The live workspace's shared source list. "pending" while the first load or a
 * manual retry runs, "ready" once it loaded, and "unavailable" after a failure.
 * Tiles that need a shared source wait on it instead of reporting it missing.
 */
export type SourceStatus = "ready" | "pending" | "unavailable"

export const SourceStatusContext = createContext<SourceStatus>("ready")

export function useSourceStatus(): SourceStatus {
  return useContext(SourceStatusContext)
}

/** Explains why a source-dependent tile cannot query yet. */
export function sourceWaitMessage(status: Exclude<SourceStatus, "ready">): string {
  return status === "pending"
    ? "Waiting for data sources to load."
    : "Data sources are unavailable. Retry data sources to load this tile."
}
