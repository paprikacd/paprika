"use client"

import { createConnectTransport } from "@connectrpc/connect-web"
import { sessionFetch, sessionIdentity } from "./session-request"
import { ensureValidSession } from "./browser-session"

// Explicit read-only RPCs, reviewed against PaprikaService. New methods default
// to no replay, including streaming calls and anything that can apply changes.
const renewableReads = new Set([
  "ListPipelines", "ListReleases", "ListStages", "ListApplications", "ListPolicies",
  "ListApplicationSets", "GetApplicationSet", "ListNotificationConfigs", "GetApplication",
  "ListGateStatus", "ListRollouts", "GetRollout", "ListAnalysisRuns", "GetAnalysisRun",
  "GetPipeline", "GetArtifact", "ListArtifacts", "GetStepLogs", "GetResource",
  "GetResourceTree", "GetResourceLogs", "GetResourceTreeDetailed", "ListInvestigatorPlugins",
  "QueryApplications", "QueryFleetMap", "QueryFleetMatrix", "GetSystemStatus", "GetDataSources",
  "ListClusters", "GetCluster", "QueryApplicationSignals", "QueryCost", "ListSourceEvents",
  "ListRolloutHistory", "ListPipelineRuns", "GetPipelineRun", "GetRevisionInfo",
  "GetApplicationOwnership", "ListDriftDetails", "GetApplicationLifecycle", "GetRolloutHold",
  "ListObservabilityProviders", "GetObservabilityUsage", "ListObservabilityProviderTypes",
  "GetObservabilityProviderType", "GetSystemHealth",
])

export function isRenewableRead(input: RequestInfo | URL): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const path = new URL(url, "http://localhost").pathname
  const prefix = "/paprika.v1.PaprikaService/"
  return path.startsWith(prefix) && renewableReads.has(path.slice(prefix.length))
}

export function createTransport() {
  return createConnectTransport({
    baseUrl: "",
    interceptors: [(next) => async (request) => {
      await ensureValidSession()
      const principal = sessionIdentity()
      const response = await next(request)
      // Unary decoding may finish after the fetch returned headers.
      if (sessionIdentity() !== principal) throw new Error("Your session changed. Refresh before continuing.")
      return response
    }],
    fetch: (input, init) => sessionFetch(input, init, isRenewableRead(input)),
  })
}
