import {
  dashboardSchema,
  savedQuerySchema,
  type Dashboard,
  type Provider,
  type QueryRequest,
  type QueryResult,
  type SavedQuery,
  type SavedQueryEntry,
} from "./schema"
import { validateSavedQueryTemplate } from "./saved-queries"
import { parseRecordFrame } from "./record-data"

export interface ProviderConfig {
  id: string
  name: string
  type: "prometheus" | "tempo"
  url: string
  bearerTokenEnv?: string
  headersEnv?: Record<string, string>
  managed?: boolean
  etag?: string
}
export interface ProviderMetadata {
  values: string[]
  truncated?: boolean
  series?: MetricSeriesMetadata
}
export interface ObserveConnection {
  configured: boolean
  connected: boolean
  transport: "mcp"
  tools: { name: string; description: string }[]
  providerCount: number
  protocolVersion?: string
}
export interface MetricSeriesMetadata {
  count: number
  limit: number
  start: number
  end: number
  truncated?: boolean
  labelsTruncated?: boolean
  sample?: boolean
  labels: { name: string; cardinality: number; values: string[]; valuesTruncated?: boolean }[]
}
export interface InsightsClient {
  /** Optional for embedded hosts that do not expose Paprika Observe. */
  observeConnection?(signal?: AbortSignal): Promise<ObserveConnection>
  listSavedQueries(signal?: AbortSignal): Promise<SavedQueryEntry[]>
  getSavedQuery(id: string): Promise<{ query: SavedQuery; etag?: string }>
  saveSavedQuery(query: SavedQuery, etag?: string): Promise<string | undefined>
  removeSavedQuery(id: string, etag?: string): Promise<void>
  providers(signal?: AbortSignal): Promise<Provider[]>
  list(signal?: AbortSignal): Promise<Dashboard[]>
  get(id: string, signal?: AbortSignal): Promise<{ dashboard: Dashboard; etag?: string }>
  save(dashboard: Dashboard, etag?: string): Promise<string | undefined>
  remove(id: string, etag?: string): Promise<void>
  query(request: QueryRequest, signal: AbortSignal): Promise<QueryResult>
  providerConfigs(signal?: AbortSignal): Promise<ProviderConfig[]>
  saveProvider(config: ProviderConfig): Promise<void>
  removeProvider(id: string, etag?: string): Promise<void>
  testProvider(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; durationMs: number; message: string }>
  metadata(
    id: string,
    options: {
      kind: "metrics" | "labels" | "values" | "series"
      label?: string
      metric?: string
    },
    signal?: AbortSignal,
  ): Promise<ProviderMetadata>
}

// A proxy may weaken the HTTP validator when compressing a response. Keep the
// server's exact document revision for writes; HTTP ETag remains the cache key.
function documentETag(response: Response): string | undefined {
  return response.headers.get("X-Paprika-Document-ETag") ?? response.headers.get("ETag") ?? undefined
}

export function createInsightsClient(
  baseURL = "/api/insights",
  token?: () => string | null,
  onUnauthorized?: () => void,
): InsightsClient {
  const snapshots = new Map<string, { bearer: string | null; generation: number; etag?: string; value?: unknown }>()
  let authenticationRequested = false
  async function request(path: string, init: RequestInit = {}, bearer = token?.() ?? null, allowNotModified = false) {
    const headers = new Headers(init.headers)
    headers.set("Content-Type", "application/json")
    if (bearer) headers.set("Authorization", `Bearer ${bearer}`)
    const response = await fetch(`${baseURL}${path}`, { ...init, headers })
    if (!response.ok && !(allowNotModified && response.status === 304)) {
      if (response.status === 401) {
        // Parallel startup/query requests must not repeatedly navigate the host.
        // A late response from a previous session must not sign out a newer one.
        if (!authenticationRequested && (token?.() ?? null) === bearer) {
          authenticationRequested = true
          onUnauthorized?.()
        }
        throw new Error("Sign in to access your dashboards.")
      }
      if (response.status === 403 && path.startsWith("/provider-configs"))
        throw new Error("Managing data sources requires Insights administrator access.")
      if (response.status === 403 && path === "/observe-connection")
        throw new Error("Your account does not have access to Paprika Observe. Check your Observability permissions.")
      if (response.status === 403 && (path === "/query" || path.startsWith("/providers/")))
        throw new Error("Your account does not have access to this data source. Check its Observability permissions.")
      if (response.status === 403) throw new Error("Your account does not have access to Insights.")
      if (response.status === 412 && path.startsWith("/saved-queries/"))
        throw new Error("This saved query changed on the server. Reload it before saving to preserve someone else’s work.")
      if ((response.status === 412 || response.status === 409) && path.startsWith("/dashboards/"))
        throw new Error(
          "This dashboard changed on the server. Reload before saving to avoid overwriting someone else’s work.",
        )
      let message = "Insights is unavailable. Check the service and provider configuration."
      try {
        const body = await response.json()
        if (typeof body.error === "string") message = body.error
      } catch {
        /* Non-JSON gateway response */
      }
      throw new Error(message)
    }
    return response
  }
  async function cachedRead<T>(path: string, parse: (body: Record<string, unknown>, etag?: string) => T, signal?: AbortSignal): Promise<T> {
    const bearer = token?.() ?? null
    let cached = snapshots.get(path)
    if (!cached || cached.bearer !== bearer) {
      cached = { bearer, generation: 0 }
      snapshots.set(path, cached)
    }
    // Bound revalidation memory when a session visits many dashboards.
    snapshots.delete(path)
    snapshots.set(path, cached)
    while (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value!)
    const generation = ++cached.generation
    const response = await request(path, { signal, headers: cached.etag ? { "If-None-Match": cached.etag } : {} }, bearer, true)
    if ((token?.() ?? null) !== bearer) throw new Error("Your session changed. Refresh the workspace before continuing.")
    if (response.status === 304) {
      if (cached.value === undefined) throw new Error("The workspace response has no cached document. Try again.")
      return cached.value as T
    }
    const value = parse(await response.json(), documentETag(response))
    if (!signal?.aborted && snapshots.get(path) === cached && generation === cached.generation) {
      cached.value = value
      cached.etag = response.headers.get("ETag") ?? undefined
    }
    return value
  }
  return {
    observeConnection: async (signal) => (await request("/observe-connection", { signal })).json(),
    listSavedQueries: (signal) => cachedRead("/saved-queries", body => {
      return ((body.queries ?? []) as SavedQueryEntry[]).map((entry: SavedQueryEntry) => {
        const { etag, ...document } = entry
        return { ...savedQuerySchema.parse(document), ...(typeof etag === "string" ? { etag } : {}) }
      })
    }, signal),
    getSavedQuery: async (id) => {
      const response = await request(`/saved-queries/${encodeURIComponent(id)}`)
      return { query: savedQuerySchema.parse(await response.json()), etag: documentETag(response) }
    },
    saveSavedQuery: async (query, etag) => {
      const document = savedQuerySchema.parse(query)
      validateSavedQueryTemplate(document)
      const response = await request(`/saved-queries/${encodeURIComponent(document.id)}`, {
        method: "PUT", body: JSON.stringify(document),
        headers: etag ? { "If-Match": etag } : { "If-None-Match": "*" },
      })
      return documentETag(response)
    },
    removeSavedQuery: async (id, etag) => {
      if (!etag) throw new Error("Reload this saved query before deleting it.")
      await request(`/saved-queries/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "If-Match": etag } })
    },
    providers: async (signal) => (await (await request("/providers", { signal })).json()).providers,
    providerConfigs: async (signal) =>
      (await (await request("/provider-configs", { signal })).json()).providers,
    saveProvider: async ({ managed: _managed, etag, ...config }) => {
      void _managed
      await request(`/provider-configs/${encodeURIComponent(config.id)}`, {
        method: "PUT",
        body: JSON.stringify(config),
        headers: etag ? { "If-Match": etag } : { "If-None-Match": "*" },
      })
    },
    removeProvider: async (id, etag) => {
      await request(`/provider-configs/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: etag ? { "If-Match": etag } : {},
      })
    },
    testProvider: async (id, signal) =>
      (
        await request(`/providers/${encodeURIComponent(id)}/test`, {
          method: "POST",
          signal,
        })
      ).json(),
    metadata: async (id, options, signal) => {
      const params = new URLSearchParams({ kind: options.kind })
      if (options.label) params.set("label", options.label)
      if (options.metric) params.set("metric", options.metric)
      return (
        await request(`/providers/${encodeURIComponent(id)}/metadata?${params}`, { signal })
      ).json()
    },
    list: (signal) => cachedRead("/dashboards", body => {
      return ((body.dashboards ?? []) as unknown[]).map((item: unknown) => dashboardSchema.parse(item))
    }, signal),
    get: (id, signal) => cachedRead(`/dashboards/${encodeURIComponent(id)}`, (body, etag) => ({
      dashboard: dashboardSchema.parse(body), etag,
    }), signal),
    save: async (dashboard, etag) => {
      const response = await request(`/dashboards/${encodeURIComponent(dashboard.id)}`, {
        method: "PUT",
        body: JSON.stringify(dashboardSchema.parse(dashboard)),
        headers: etag ? { "If-Match": etag } : { "If-None-Match": "*" },
      })
      return documentETag(response)
    },
    remove: async (id, etag) => {
      await request(`/dashboards/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: etag ? { "If-Match": etag } : {},
      })
    },
    query: async (body, signal) => {
      if (body.queryRef) throw new Error("Resolve the saved query through the Insights workspace before executing it.")
      const result: QueryResult = await (
        await request("/query", {
          method: "POST",
          body: JSON.stringify(body),
          signal,
        })
      ).json()
      if (body.kind === "records") {
        const records = parseRecordFrame(result.records)
        return { records, truncated: result.truncated || records.truncated }
      }
      return result
    },
  }
}
