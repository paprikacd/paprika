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

/** The embedding host owns authentication; standalone Insights needs no session implementation. */
export interface InsightsSession {
  ensureToken(): Promise<string | null>
  recoverUnauthorized(rejectedBearer: string | null): Promise<string | null>
  clearRejectedSession(rejectedBearer: string | null): void
  /** Stable during token rotation; changes on logout or principal/permissions changes. */
  identity(): string
}

export function createInsightsClient(
  baseURL = "/api/insights",
  token?: () => string | null,
  onUnauthorized?: () => void,
  session?: InsightsSession,
): InsightsClient {
  const snapshots = new Map<string, { identity: string | null; generation: number; etag?: string; value?: unknown }>()
  const responseIdentities = new WeakMap<Response, string | null>()
  let authenticationRequested = false
  const identity = () => session ? session.identity() : token?.() ?? null
  let previousIdentity = identity()
  function requestContext(bearer: string | null) {
    const principal = identity()
    if (principal !== previousIdentity) {
      snapshots.clear()
      authenticationRequested = false
      previousIdentity = principal
    }
    return { bearer, principal }
  }
  async function request(path: string, init: RequestInit = {}, context?: ReturnType<typeof requestContext>, allowNotModified = false) {
    const current = context ?? requestContext(session ? await session.ensureToken() : token?.() ?? null)
    let bearer = current.bearer
    const send = () => {
      const headers = new Headers(init.headers)
      headers.set("Content-Type", "application/json")
      if (bearer) headers.set("Authorization", `Bearer ${bearer}`)
      else headers.delete("Authorization")
      return fetch(`${baseURL}${path}`, { ...init, headers })
    }
    let response = await send()
    if (response.status === 401 && session && identity() === current.principal) {
      const renewed = await session.recoverUnauthorized(bearer)
      if (renewed) {
        if (identity() !== current.principal) throw new Error("Your session changed. Refresh the workspace before continuing.")
        const readOnly = !init.method || init.method === "GET" ||
          (init.method === "POST" && (path === "/query" || /^\/providers\/[^/]+\/test$/.test(path)))
        if (!readOnly) throw new Error("Your session was renewed. Please retry this action.")
        init.signal?.throwIfAborted()
        bearer = renewed
        response = await send()
        if (response.status === 401) session.clearRejectedSession(bearer)
      }
    }
    if (!response.ok && !(allowNotModified && response.status === 304)) {
      if (response.status === 401) {
        // Parallel startup/query requests must not repeatedly navigate the host.
        // A late response from a previous session must not sign out a newer one.
        if (!authenticationRequested && ((token?.() ?? null) === bearer || (session && !(token?.() ?? null)))) {
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
    if (identity() !== current.principal) throw new Error("Your session changed. Refresh the workspace before continuing.")
    authenticationRequested = false
    responseIdentities.set(response, current.principal)
    return response
  }
  async function readJSON<T>(response: Response): Promise<T> {
    const body = await response.json() as T
    if (identity() !== responseIdentities.get(response)) throw new Error("Your session changed. Refresh the workspace before continuing.")
    return body
  }
  async function cachedRead<T>(path: string, parse: (body: Record<string, unknown>, etag?: string) => T, signal?: AbortSignal): Promise<T> {
    const context = requestContext(session ? await session.ensureToken() : token?.() ?? null)
    let cached = snapshots.get(path)
    if (!cached || cached.identity !== context.principal) {
      cached = { identity: context.principal, generation: 0 }
      snapshots.set(path, cached)
    }
    // Bound revalidation memory when a session visits many dashboards.
    snapshots.delete(path)
    snapshots.set(path, cached)
    while (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value!)
    const generation = ++cached.generation
    const response = await request(path, { signal, headers: cached.etag ? { "If-None-Match": cached.etag } : {} }, context, true)
    if (response.status === 304) {
      if (cached.value === undefined) throw new Error("The workspace response has no cached document. Try again.")
      return cached.value as T
    }
    const value = parse(await readJSON<Record<string, unknown>>(response), documentETag(response))
    if (identity() !== context.principal) throw new Error("Your session changed. Refresh the workspace before continuing.")
    if (!signal?.aborted && snapshots.get(path) === cached && generation === cached.generation) {
      cached.value = value
      cached.etag = response.headers.get("ETag") ?? undefined
    }
    return value
  }
  return {
    observeConnection: async (signal) => readJSON(await request("/observe-connection", { signal })),
    listSavedQueries: (signal) => cachedRead("/saved-queries", body => {
      return ((body.queries ?? []) as SavedQueryEntry[]).map((entry: SavedQueryEntry) => {
        const { etag, ...document } = entry
        return { ...savedQuerySchema.parse(document), ...(typeof etag === "string" ? { etag } : {}) }
      })
    }, signal),
    getSavedQuery: async (id) => {
      const response = await request(`/saved-queries/${encodeURIComponent(id)}`)
      return { query: savedQuerySchema.parse(await readJSON(response)), etag: documentETag(response) }
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
    providers: async (signal) => (await readJSON<{ providers: Provider[] }>(await request("/providers", { signal }))).providers,
    providerConfigs: async (signal) =>
      (await readJSON<{ providers: ProviderConfig[] }>(await request("/provider-configs", { signal }))).providers,
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
      readJSON(
        await request(`/providers/${encodeURIComponent(id)}/test`, {
          method: "POST",
          signal,
        })
      ),
    metadata: async (id, options, signal) => {
      const params = new URLSearchParams({ kind: options.kind })
      if (options.label) params.set("label", options.label)
      if (options.metric) params.set("metric", options.metric)
      return readJSON(
        await request(`/providers/${encodeURIComponent(id)}/metadata?${params}`, { signal })
      )
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
      const result = await readJSON<QueryResult>(
        await request("/query", {
          method: "POST",
          body: JSON.stringify(body),
          signal,
        })
      )
      if (body.kind === "records") {
        const records = parseRecordFrame(result.records)
        return { records, truncated: result.truncated || records.truncated }
      }
      return result
    },
  }
}
