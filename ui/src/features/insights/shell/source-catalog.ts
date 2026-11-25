import { classifySourceFailure, InsightsHTTPError, type SharedCatalogStatus } from "../client"

export type SourceState =
  | { status: "pending" }
  | { status: "ready" }
  | { status: "unavailable"; reason: SourceFailureReason; message: string }

/** Why a shared source list is unavailable; each reason has its own banner copy and action. */
export type SourceFailureReason = "busy" | "signin" | "access" | "failed"

export function sourceBannerCopy(sources: Extract<SourceState, { status: "unavailable" }>): string {
  switch (sources.reason) {
    case "busy": return "Data sources are busy."
    case "signin": return "Your session has expired. Sign in again to load data sources."
    case "access": return "Your account cannot load data sources. Check its Observability permissions."
    case "failed": return `Data sources did not load: ${sources.message}`
  }
}

export function sourceFailureReason(error: unknown): SourceFailureReason {
  const failure = classifySourceFailure(error)
  if (failure === "busy") return "busy"
  if (failure === "access") return error instanceof InsightsHTTPError && error.status === 401 ? "signin" : "access"
  return "failed"
}

export function sharedFailureReason(status: SharedCatalogStatus["status"]): SourceFailureReason {
  if (status === "busy") return "busy"
  return status === "forbidden" ? "access" : "failed"
}
