import {
  savedQuerySchema,
  storedDashboardSchema,
  type Dashboard,
  type Provider,
  type QueryRequest,
  type QueryResult,
  type SavedQuery,
  type SavedQueryEntry,
} from "./schema"
import { CheckFinding, CheckReport, Severity, Source } from "@/gen/paprika/insights/v1/checks_pb"
import { dashboardAsSent } from "./layout-compaction"
import { validateSavedQueryTemplate } from "./saved-queries"
import { parseRecordFrame } from "./record-data"
import { parseDashboardBundle, type DashboardBundle } from "./workspace-transfer"

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
/** Why the shared catalog is missing from a listing that still has the local providers. */
export interface SharedCatalogStatus {
  status: "busy" | "forbidden" | "unavailable"
  code: number
  message: string
  /** Seconds to wait before replaying a busy listing; the gateway's Retry-After, or a default. */
  retryAfter?: number
}
export interface ProviderCatalog {
  providers: Provider[]
  sharedCatalog?: SharedCatalogStatus
}
/** A first-party starter as the empty-state picker lists it. Reading one saves nothing. */
export interface StarterSummary {
  id: string
  title: string
  description: string
  widgetCount: number
  /** Dashboard variables the starter's queries read. */
  variables: string[]
  /** Data kinds a provider must offer, such as metrics. */
  providers: string[]
  /** Each widget's grid rectangle, so the picker can draw a thumbnail. */
  tiles: { type: string; x: number; y: number; w: number; h: number }[]
}
export interface InsightsClient {
  /** The listing with its shared-catalog status. Absent for hosts that predate it; providers() still works. */
  providerCatalog?(signal?: AbortSignal): Promise<ProviderCatalog>
  /** Starts the host's sign-in flow, returning to this view afterwards. Absent when the host has no sign-in. */
  signIn?(): void
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
  /** Saves with ?checks=true, so a successful save reports its warnings. checks is absent from servers that predate it. */
  saveChecked?(dashboard: Dashboard, etag?: string): Promise<{ etag?: string; checks?: CheckReport }>
  /** Dry-run checks of a document as a save would send it. Absent for hosts that predate it. */
  validate?(document: Dashboard, signal?: AbortSignal): Promise<CheckReport>
  remove(id: string, etag?: string): Promise<void>
  /** First-party starter dashboards. Absent for hosts that predate them. */
  listStarters?(signal?: AbortSignal): Promise<StarterSummary[]>
  /** One starter as a portable bundle for the import review. Reading it writes nothing. */
  getStarter?(id: string, signal?: AbortSignal): Promise<DashboardBundle>
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

function canRetryCapacity(requestPath: string, init: RequestInit): boolean {
  // Query strings such as ?checks=true do not change what a route is.
  const path = requestPath.split("?")[0]
  // The query endpoint is read-only even though its bounded request is POST.
  // A 429 is a definite admission rejection, so replay is safe.
  if (path === "/query" && init.method === "POST") return true
  // A busy shared catalog is answered 200 with sharedCatalog.retryAfter, which
  // fetchProviderCatalog replays. This covers only an explicit 429 from the route.
  if (path === "/providers" && (!init.method || init.method === "GET")) return true
  if (!/^\/(dashboards|saved-queries|starters)(\/[^/?]+)?$/.test(path)) return false
  if (!init.method || init.method === "GET") return true
  const headers = new Headers(init.headers)
  return (init.method === "PUT" || init.method === "DELETE") &&
    (headers.has("If-Match") || headers.get("If-None-Match") === "*")
}

function capacityRetryDelay(response: Response, attempt: number): number | undefined {
  const header = response.headers.get("Retry-After")?.trim()
  let delay = 1000 * 2 ** attempt
  if (header) {
    const requested = /^\d+$/.test(header) ? Number(header) * 1000 :
      /^[A-Za-z]{3}, /.test(header) ? Date.parse(header) - Date.now() : NaN
    if (!Number.isNaN(requested)) delay = Math.max(100, requested)
  }
  // A long server cooldown should surface the error, never retry prematurely.
  return delay <= REPLAY_DELAY_CAP_MS ? jitter(delay) : undefined
}

// No replay waits longer than this, however large the server's Retry-After is.
const REPLAY_DELAY_CAP_MS = 10_000

/** Spreads a replay delay by +-30%, so viewers blocked by one busy spell do not replay in step. */
function jitter(delay: number): number {
  return Math.round(delay * (0.7 + 0.6 * Math.random()))
}

// A busy listing is replayed at most this many times, as a 429 read is.
const BUSY_LISTING_REPLAYS = 3

function waitForCapacity(delay: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal!.reason) }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, delay)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

/** A failed HTTP response, with the status and Retry-After header a caller needs to classify it. */
export class InsightsHTTPError extends Error {
  readonly status: number
  readonly retryAfter: string | null
  /** The findings a rejected document carried (a 400 save or dry run), when the body had any. */
  readonly checks?: CheckReport
  constructor(message: string, status: number, retryAfter: string | null, checks?: CheckReport) {
    super(message)
    this.name = "InsightsHTTPError"
    this.status = status
    this.retryAfter = retryAfter
    this.checks = checks
  }
}

const SEVERITY_BY_NAME: Record<string, Severity> = {
  SEVERITY_INFO: Severity.INFO,
  SEVERITY_WARNING: Severity.WARNING,
  SEVERITY_ERROR: Severity.ERROR,
}
const SOURCE_BY_NAME: Record<string, Source> = {
  SOURCE_SCHEMA: Source.SCHEMA,
  SOURCE_LINT: Source.LINT,
  SOURCE_DATA: Source.DATA,
  SOURCE_VISUAL: Source.VISUAL,
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : ""
}
function countField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Reads a check report from a 400 save body, a dry run, or a list response. Older bodies
 * may omit the counts or the truncation flag: those are derived from the listed issues.
 * Unknown enum names read as unspecified rather than failing the whole report.
 */
export function parseCheckReport(body: unknown): CheckReport {
  const raw = body && typeof body === "object" ? body as Record<string, unknown> : {}
  const list = Array.isArray(raw.issues) ? raw.issues : []
  const issues = list.map((item) => {
    const finding = item && typeof item === "object" ? item as Record<string, unknown> : {}
    return new CheckFinding({
      ruleId: textField(finding.ruleId),
      severity: SEVERITY_BY_NAME[textField(finding.severity)] ?? Severity.UNSPECIFIED,
      source: SOURCE_BY_NAME[textField(finding.source)] ?? Source.UNSPECIFIED,
      widgetId: textField(finding.widgetId),
      pointer: textField(finding.pointer),
      message: textField(finding.message),
      fix: textField(finding.fix),
    })
  })
  const total = countField(raw.total) ?? issues.length
  const tally = (key: string, matches: (severity: Severity) => boolean) =>
    countField(raw[key]) ?? issues.filter((issue) => matches(issue.severity)).length
  return new CheckReport({
    issues,
    total,
    truncated: typeof raw.truncated === "boolean" ? raw.truncated : total > issues.length,
    errorCount: tally("errorCount", (severity) => severity === Severity.ERROR),
    warningCount: tally("warningCount", (severity) => severity === Severity.WARNING),
    infoCount: tally("infoCount", (severity) => severity !== Severity.ERROR && severity !== Severity.WARNING),
  })
}

// A dry run is one bounded read; past this it is reported as a failed check.
const VALIDATE_TIMEOUT_MS = 10_000

/** The findings carried by a failed request, or undefined when the failure had none. */
export function checksFromError(error: unknown): CheckReport | undefined {
  return error instanceof InsightsHTTPError ? error.checks : undefined
}

export type SourceFailure = "access" | "busy" | "unavailable"

/**
 * Classifies a failed shared-source (provider catalog) request by its cause:
 * 401 and 403 end this viewer's access, a 429 or any response carrying
 * Retry-After is a busy gateway, and everything else is an unavailable source.
 */
export function classifySourceFailure(error: unknown): SourceFailure {
  if (!(error instanceof InsightsHTTPError)) return "unavailable"
  if (error.status === 401 || error.status === 403) return "access"
  if (error.status === 429 || error.retryAfter !== null) return "busy"
  return "unavailable"
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
  async function request(path: string, init: RequestInit = {}, context?: ReturnType<typeof requestContext>, allowNotModified = false, deferSession = false) {
    const current = context ?? requestContext(session ? await session.ensureToken() : token?.() ?? null)
    let bearer = current.bearer
    const send = async () => {
      const headers = new Headers(init.headers)
      headers.set("Content-Type", "application/json")
      if (bearer) headers.set("Authorization", `Bearer ${bearer}`)
      else headers.delete("Authorization")
      let response = await fetch(`${baseURL}${path}`, { ...init, headers })
      // Observe can reject a query or document validation before execution when
      // it reaches capacity. Replay only explicit 429 rejections, keeping
      // the exact body and conditional revision. Lost responses, 5xx errors and
      // conflicts remain with the importer's read-back reconciliation.
      for (let attempt = 0; response.status === 429 && attempt < 3 && canRetryCapacity(path, init); attempt++) {
        if (identity() !== current.principal) throw new Error("Your session changed. Refresh the workspace before continuing.")
        const delay = capacityRetryDelay(response, attempt)
        if (delay === undefined) break
        await response.body?.cancel()
        await waitForCapacity(delay, init.signal)
        if (identity() !== current.principal) throw new Error("Your session changed. Refresh the workspace before continuing.")
        init.signal?.throwIfAborted()
        response = await fetch(`${baseURL}${path}`, { ...init, headers })
      }
      return response
    }
    let response = await send()
    // A deferred read never renews or clears the session. Renewal that fails
    // clears it, which changes the identity and remounts the workspace. Its
    // 401 is shown as a banner that the user resolves with an explicit sign-in.
    if (response.status === 401 && session && !deferSession && identity() === current.principal) {
      const renewed = await session.recoverUnauthorized(bearer)
      if (renewed) {
        if (identity() !== current.principal) throw new Error("Your session changed. Refresh the workspace before continuing.")
        const readOnly = !init.method || init.method === "GET" ||
          (init.method === "POST" && (path === "/query" || path === "/dashboards/validate" || /^\/providers\/[^/]+\/test$/.test(path)))
        if (!readOnly) throw new Error("Your session was renewed. Please retry this action.")
        init.signal?.throwIfAborted()
        bearer = renewed
        response = await send()
        if (response.status === 401) session.clearRejectedSession(bearer)
      }
    }
    if (!response.ok && !(allowNotModified && response.status === 304)) {
      const failure = (message: string, checks?: CheckReport) =>
        new InsightsHTTPError(message, response.status, response.headers.get("Retry-After"), checks)
      if (response.status === 401) {
        // Parallel startup/query requests must not repeatedly navigate the host.
        // A late response from a previous session must not sign out a newer one.
        // A caller that can show its own sign-in prompt may defer the host's
        // navigation, so unsaved work stays mounted until the user chooses.
        if (!deferSession && !authenticationRequested && ((token?.() ?? null) === bearer || (session && !(token?.() ?? null)))) {
          authenticationRequested = true
          onUnauthorized?.()
        }
        throw failure("Sign in to access your dashboards.")
      }
      if (response.status === 403 && path.startsWith("/provider-configs"))
        throw failure("Managing data sources requires Insights administrator access.")
      if (response.status === 403 && path === "/observe-connection")
        throw failure("Your account does not have access to Paprika Observe. Check your Observability permissions.")
      if (response.status === 403 && (path === "/query" || path.startsWith("/providers/")))
        throw failure("Your account does not have access to this data source. Check its Observability permissions.")
      if (response.status === 403) throw failure("Your account does not have access to Insights.")
      if (response.status === 412 && path.startsWith("/saved-queries/"))
        throw failure("This saved query changed on the server. Reload it before saving to preserve someone else’s work.")
      if ((response.status === 412 || response.status === 409) && path.startsWith("/dashboards/"))
        throw failure(
          "This dashboard changed on the server. Reload before saving to avoid overwriting someone else’s work.",
        )
      let message = "Insights is unavailable. Check the service and provider configuration."
      let checks: CheckReport | undefined
      try {
        const body = await response.json()
        if (typeof body.error === "string") message = body.error
        // A rejected document carries its findings beside the error text.
        if (Array.isArray(body.issues)) checks = parseCheckReport(body)
      } catch {
        /* Non-JSON gateway response */
      }
      throw failure(message, checks)
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
  function sendSave(dashboard: Dashboard, etag: string | undefined, checked: boolean) {
    return request(`/dashboards/${encodeURIComponent(dashboard.id)}${checked ? "?checks=true" : ""}`, {
      method: "PUT",
      body: JSON.stringify(dashboardAsSent(dashboard)),
      headers: etag ? { "If-Match": etag } : { "If-None-Match": "*" },
    })
  }
  // A busy shared catalog arrives as 200 with sharedCatalog busy, so it is replayed
  // here by its retryAfter. The replay stops when the caller aborts, which is how
  // an unmount or a newer request ends it.
  async function fetchProviderCatalog(signal?: AbortSignal): Promise<ProviderCatalog> {
    for (let attempt = 0; ; attempt++) {
      const body = await readJSON<{ providers: Provider[]; sharedCatalog?: SharedCatalogStatus }>(
        await request("/providers", { signal }, undefined, false, true),
      )
      const shared = body.sharedCatalog
      if (shared?.status !== "busy" || attempt >= BUSY_LISTING_REPLAYS)
        return { providers: body.providers, ...(shared ? { sharedCatalog: shared } : {}) }
      await waitForCapacity(jitter(Math.min((shared.retryAfter ?? 1) * 1000, REPLAY_DELAY_CAP_MS)), signal)
    }
  }
  return {
    ...(onUnauthorized ? { signIn: () => onUnauthorized() } : {}),
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
    // The shared catalog loads behind a rendered workspace; its 401 becomes a banner, not a navigation.
    providerCatalog: fetchProviderCatalog,
    providers: async (signal) => (await fetchProviderCatalog(signal)).providers,
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
    listStarters: (signal) => cachedRead("/starters", body => {
      return (body.starters ?? []) as StarterSummary[]
    }, signal),
    getStarter: (id, signal) => cachedRead(`/starters/${encodeURIComponent(id)}`, body => {
      return parseDashboardBundle(JSON.stringify(body), "json")
    }, signal),
    // Reads keep a stored zone as saved (storedDashboardSchema), so one dashboard's zone never fails the whole list.
    list: (signal) => cachedRead("/dashboards", body => {
      return ((body.dashboards ?? []) as unknown[]).map((item: unknown) => storedDashboardSchema.parse(item))
    }, signal),
    get: (id, signal) => cachedRead(`/dashboards/${encodeURIComponent(id)}`, (body, etag) => ({
      dashboard: storedDashboardSchema.parse(body), etag,
    }), signal),
    // Every dashboard save goes through here, so the layout is sent as the canvas draws it. The server rejects
    // overlapping widgets, and a stored dashboard can overlap while the canvas still shows it settled.
    save: async (dashboard, etag) => documentETag(await sendSave(dashboard, etag, false)),
    saveChecked: async (dashboard, etag) => {
      const response = await sendSave(dashboard, etag, true)
      // The save is committed by a success status. A body that is not JSON only lacks its findings.
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      const checks = body && typeof body === "object" ? (body as Record<string, unknown>).checks : undefined
      return {
        etag: documentETag(response),
        // A server without checks sends none, which is not the same as no findings.
        ...(checks !== undefined ? { checks: parseCheckReport(checks) } : {}),
      }
    },
    validate: async (document, signal) => {
      // A dry run that does not answer is a failed check, so the caller can let the user proceed.
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), VALIDATE_TIMEOUT_MS)
      const forward = () => deadline.abort()
      signal?.addEventListener("abort", forward, { once: true })
      try {
        return parseCheckReport(await readJSON(await request("/dashboards/validate", {
          method: "POST",
          body: JSON.stringify({ document: dashboardAsSent(document) }),
          signal: deadline.signal,
        })))
      } catch (error) {
        if (!signal?.aborted && deadline.signal.aborted)
          throw new Error(`The check did not finish within ${VALIDATE_TIMEOUT_MS / 1000} seconds.`)
        throw error
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener("abort", forward)
      }
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

/**
 * The listing with its shared-catalog status, from any client. Hosts that predate
 * providerCatalog fall back to providers(), which carries no status.
 */
export function loadProviderCatalog(client: InsightsClient, signal?: AbortSignal): Promise<ProviderCatalog> {
  return client.providerCatalog
    ? client.providerCatalog(signal)
    : client.providers(signal).then((providers) => ({ providers }))
}
