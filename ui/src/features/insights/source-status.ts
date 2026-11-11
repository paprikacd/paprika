import { createContext, useContext } from "react"

/**
 * The live workspace's shared source list. "pending" while the first load or a
 * manual retry runs, "ready" once it loaded, and "unavailable" after a failure.
 * Tiles that need a shared source wait on it instead of reporting it missing.
 */
export type SourceStatus = "ready" | "pending" | "unavailable" | "signin"

export const SourceStatusContext = createContext<SourceStatus>("ready")

export function useSourceStatus(): SourceStatus {
  return useContext(SourceStatusContext)
}

/**
 * Explains why a source-dependent tile cannot query yet. The copy names the
 * action the banner actually offers, so a session-expired tile never points at
 * a retry that does not exist.
 */
export function sourceWaitMessage(status: Exclude<SourceStatus, "ready">): string {
  switch (status) {
    case "pending": return "Waiting for data sources to load."
    case "signin": return "Sign in again to load this tile."
    case "unavailable": return "Data sources are unavailable. Retry data sources to load this tile."
  }
}
