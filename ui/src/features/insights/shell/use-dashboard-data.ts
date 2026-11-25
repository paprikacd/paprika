import { useMemo } from "react"
import { type QueryRequest } from "../schema"
import { assertProviderQueryTemplate } from "../provider-query-template"
import { resolveSavedQueryReference } from "../saved-queries"
import { createQueryScheduler, createResolvedQueryFetcher } from "../query"
import { alignedDashboardEnd, dashboardRange } from "../time-range"
import { sourceWaitMessage } from "../source-status"
import { sourceQueryStep, variableValueScope, type VariableValueLoaders } from "../variable-options"
import type { VariableSourceCatalog } from "../variable-source-editor"
import { interpolateQuery } from "../drilldown"
import { MANUAL_REFRESH_BYPASS_MS } from "./constants"
import type { AfterWorkspaceBoot } from "./types"

export function useDashboardData(
  activeExample: AfterWorkspaceBoot["activeExample"],
  client: AfterWorkspaceBoot["client"],
  end: AfterWorkspaceBoot["end"],
  principal: AfterWorkspaceBoot["principal"],
  providers: AfterWorkspaceBoot["providers"],
  queriesError: AfterWorkspaceBoot["queriesError"],
  queriesLoading: AfterWorkspaceBoot["queriesLoading"],
  queryRevision: AfterWorkspaceBoot["queryRevision"],
  refreshedAt: AfterWorkspaceBoot["refreshedAt"],
  savedQueries: AfterWorkspaceBoot["savedQueries"],
  sourceContext: AfterWorkspaceBoot["sourceContext"],
  variableValues: AfterWorkspaceBoot["variableValues"],
  viewDashboard: AfterWorkspaceBoot["viewDashboard"],
) {
  const scheduledFetcher = useMemo(() => {
    // A refresh or provider edit invalidates cached fixed-range observations too.
    void queryRevision
    // The scheduler owns the capacity backoff, so its slot is free while a refused query waits.
    const query = activeExample ? activeExample.repositoryWorkspaceQuery : (request: QueryRequest, signal: AbortSignal) => client.query(request, signal, { replayCapacity: false, refresh: Date.now() - refreshedAt < MANUAL_REFRESH_BYPASS_MS })
    return createQueryScheduler(query)
  }, [client, activeExample, queryRevision, refreshedAt])
  // Resolve each authoring scope once, before sharing the bounded scheduler.
  // Tooltip label values may themselves contain {{text}}; never interpolate
  // those resolved query literals again as dashboard variables.
  // A saved query whose source is loaded runs even when the shared catalog failed.
  const fetcher = useMemo(() => createResolvedQueryFetcher(scheduledFetcher, (request: QueryRequest) => {
    const { queryRef, ...resolved } = request
    if (queryRef) {
      if (queriesLoading) throw new Error("Loading the saved-query library…")
      if (queriesError) throw new Error(queriesError)
      const authored = savedQueries.find(query => query.id === queryRef.id)
      if (authored) assertProviderQueryTemplate(providers.find(provider => provider.id === authored.providerId)?.type, authored.query)
      const definition = resolveSavedQueryReference(queryRef, savedQueries, variableValues, request.kind)
      if (!providers.some(provider => provider.id === definition.providerId)) {
        if (sourceContext !== "ready") throw new Error(sourceWaitMessage(sourceContext))
        throw new Error("The saved query’s data source is unavailable. Choose a connected source in Explore.")
      }
      if (!providers.some(provider => provider.id === definition.providerId && provider.capabilities.includes(definition.kind)))
        throw new Error("The saved query’s data source is unavailable. Choose a connected source in Explore.")
      return { ...resolved, ...definition }
    }
    assertProviderQueryTemplate(providers.find(provider => provider.id === request.providerId)?.type, request.query)
    return { ...resolved, query: interpolateQuery(request.query, variableValues) }
  }), [scheduledFetcher, variableValues, savedQueries, queriesLoading, queriesError, providers, sourceContext])
  // The view reads its window to the shared grain, so viewers and query_dashboard ask for the same window.
  const alignedEnd = alignedDashboardEnd(viewDashboard, end)
  const range = dashboardRange(viewDashboard, alignedEnd)
  // Values for variable sources come from the same metadata and query paths the widgets use.
  const variableLoaders = useMemo<VariableValueLoaders>(() => ({
    // The principal is the scope, so values loaded under one sign-in never serve another; a token renewal keeps them.
    scope: variableValueScope(!!activeExample, principal),
    metadata: async (request, signal) => {
      // Example workspaces read a fixed fixture that has no selectors, so a selector is refused rather than ignored.
      if (activeExample && request.selector !== undefined) throw new Error("Selector-filtered values are not available in examples")
      const metadata = activeExample ? activeExample.repositoryWorkspaceMetadata : client.metadata
      const response = await metadata(request.providerId, { kind: "values", label: request.label, selector: request.selector, start: request.start, end: request.end }, signal)
      return { values: response.values, truncated: response.truncated }
    },
    query: (request, signal) => {
      // Resolve with the values the plan was keyed on, not the route's current values, so the result matches its key.
      if (queriesLoading) throw new Error("Loading the saved-query library…")
      if (queriesError) throw new Error(queriesError)
      const saved = savedQueries.find(query => query.id === request.queryRef.id)
      if (!saved) throw new Error(`Saved query “${request.queryRef.id}” is unavailable.`)
      assertProviderQueryTemplate(providers.find(provider => provider.id === saved.providerId)?.type, saved.query)
      const definition = resolveSavedQueryReference(request.queryRef, savedQueries, request.variables, saved.kind)
      if (!providers.some(provider => provider.id === definition.providerId && provider.capabilities.includes(definition.kind)))
        throw new Error("The saved query’s data source is unavailable. Choose a connected source in Explore.")
      const minStepSeconds = providers.find(provider => provider.id === definition.providerId)?.minStepSeconds
      return scheduledFetcher({ ...definition, start: request.start, end: request.end, step: sourceQueryStep(request.start, request.end, minStepSeconds) }, signal)
    },
  }), [client, activeExample, scheduledFetcher, savedQueries, queriesLoading, queriesError, providers, principal])
  // The variable editor reads providers, label names and saved queries; its preview runs the same loaders as the bar.
  const variableCatalog = useMemo<VariableSourceCatalog>(() => ({
    loaders: variableLoaders,
    providers,
    savedQueries,
    range: { start: range.start, end: range.end },
    labels: async (providerId, signal) => {
      const metadata = activeExample ? activeExample.repositoryWorkspaceMetadata : client.metadata
      return (await metadata(providerId, { kind: "labels" }, signal)).values
    },
  }), [variableLoaders, providers, savedQueries, client, activeExample, range.start, range.end])
  const builderClient = useMemo(
    () =>
      activeExample
        ? { ...client, metadata: activeExample.repositoryWorkspaceMetadata, query: activeExample.repositoryWorkspaceQuery }
        : client,
    [client, activeExample],
  )
  return [
    alignedEnd,
    builderClient,
    fetcher,
    range,
    scheduledFetcher,
    variableCatalog,
    variableLoaders,
  ] as const
}
