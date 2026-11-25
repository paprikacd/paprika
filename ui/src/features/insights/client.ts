import {
  savedQuerySchema,
  storedDashboardSchema,
  parseQueryDiagnostics,
  type Dashboard,
  type Provider,
  type QueryRequest,
  type QueryResult,
  type QueryDiagnostics,
  type SavedQuery,
  type SavedQueryEntry,
} from "./schema"
import type { JsonValue } from "@bufbuild/protobuf"
import { CheckFinding, CheckReport, Severity, Source } from "@/gen/paprika/insights/v1/checks_pb"
import { DashboardRevisionList } from "@/gen/paprika/insights/v1/revisions_pb"
import { jitter, REPLAY_DELAY_CAP_MS } from "./replay-timing"
import { dashboardAsSent } from "./layout-compaction"
import { validateSavedQueryTemplate } from "./saved-queries"
import { parseRecordFrame } from "./record-data"
import { parseTruncation } from "./truncation"
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
/** A shared provider the gateway lists but Insights cannot query. Message is fixed Insights wording. */
export interface UnsupportedProvider {
  name: string
  type: string
  /** Catalog display name for a known type; absent for an unknown one. */
  typeLabel?: string
  reason: string
  message: string
}
export interface ProviderCatalog {
  providers: Provider[]
  /** Listed shared providers Insights cannot query. Absent when there are none. */
  unsupportedProviders?: UnsupportedProvider[]
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
  /** The retained revisions of a dashboard, newest first. Absent for hosts that predate revision history. */
  listRevisions?(id: string, signal?: AbortSignal): Promise<DashboardRevisionList>
  /** The stored document of one retained revision. Reading it writes nothing. Absent for hosts that predate revision history. */
  getRevision?(id: string, revision: number, signal?: AbortSignal): Promise<{ dashboard: Dashboard; etag?: string }>
  /**
   * Restores a stored revision as the dashboard's new revision. etag is the dashboard's current ETag; a stale one is
   * rejected with the reload message. revision is the number the restore created, or 0 when the server named none,
   * which happens only when the dashboard's history is unavailable.
   */
  restoreRevision?(
    id: string,
    revision: number,
    etag: string,
    message?: string,
  ): Promise<{ dashboard: Dashboard; etag?: string; revision: number }>
  query(request: QueryRequest, signal: AbortSignal, options?: QueryCallOptions): Promise<QueryResult>
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
      /** A Prometheus series selector, such as up{cluster="omega"}. Label values only. */
      selector?: string
      /** The window in Unix seconds. Both are needed together; without them the trailing day is used. */
      start?: number
      end?: number
    },
    signal?: AbortSignal,
  ): Promise<ProviderMetadata>
}

// A proxy may weaken the HTTP validator when compressing a response. Keep the
// server's exact document revision for writes; HTTP ETag remains the cache key.
function documentETag(response: Response): string | undefined {
  return response.headers.get("X-Paprika-Document-ETag") ?? response.headers.get("ETag") ?? undefined
}

/** Per-call choices for a query. */
export interface QueryCallOptions {
  /**
   * False leaves an admission 429 to the caller, which owns the wait (the query
   * scheduler releases its slot while it backs off). Defaults to true.
   */
  replayCapacity?: boolean;
  /**
   * Asks the server for a fresh execution: it skips its result cache and stores the new result. Used by a manual refresh,
   * so the refreshed window is not answered from an earlier one.
   */
  refresh?: boolean;
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

/**
 * A failed query. It is still an InsightsHTTPError, so busy and access handling
 * is unchanged; the fixed code and the sanitized receipt, when sent, ride along.
 */
export class InsightsQueryError extends InsightsHTTPError {
  constructor(
    message: string,
    status: number,
    retryAfter: string | null,
    readonly code: string,
    readonly diagnostics?: QueryDiagnostics,
    /** The gateway limit that refused a 429 (edge, budget, provider or queue), when it named one. */
    readonly limitScope?: string,
  ) {
    super(message, status, retryAfter)
    this.name = "InsightsQueryError"
  }
}

// The gateway limits a 429 can name. Anything else is dropped, so it holds the whole board.
const limitScopes = new Set(["edge", "budget", "provider", "queue", "principal"])

const queryErrorCodes = new Set(["canceled", "timeout", "rate_limited", "forbidden", "invalid_query", "provider_not_found", "provider_error", "gateway_unavailable"])

// Fallback copy by code, for a failure whose body is not Insights' JSON envelope
// (a proxy page) or carries no error text. Insights writes its query failures
// as fixed, safe strings, so the envelope's own text is shown when present.
const queryFailureMessages: Record<string, string> = {
  canceled: "The query was cancelled.",
  timeout: "The query timed out. Narrow the time range or simplify the query and try again.",
  rate_limited: "Query capacity is busy; retry shortly.",
  forbidden: "Access to this data source was refused. Check its Observability permissions or provider credentials.",
  invalid_query: "The data source rejected this query. Check the expression and time bounds.",
  provider_not_found: "The data source is unavailable. Choose a connected source.",
  provider_error: "The data source could not complete this query. Retry, or check its connection.",
  gateway_unavailable: "Insights could not reach the observability gateway. Retry shortly.",
}

const serviceUnavailableMessage = "Insights is unavailable. Check the service and provider configuration."

// The code for a failure whose body carries none, such as a proxy's own page.
function defaultQueryFailureCode(status: number): string {
  switch (status) {
    case 400: return "invalid_query"
    case 403: return "forbidden"
    case 404: return "provider_not_found"
    case 408: return "canceled"
    case 429: return "rate_limited"
    case 504: return "timeout"
    default: return "provider_error"
  }
}

async function queryFailure(response: Response): Promise<InsightsQueryError> {
  let envelope: Record<string, unknown> = {}
  try {
    const body: unknown = await response.json()
    if (body && typeof body === "object") envelope = body as Record<string, unknown>
  } catch { /* A proxy may return a non-JSON error. */ }
  const envelopeCode = typeof envelope.code === "string" && queryErrorCodes.has(envelope.code) ? envelope.code : undefined
  const code = envelopeCode ?? defaultQueryFailureCode(response.status)
  // A 403 body is a bare refusal; keep the data-source permission explanation for it.
  const envelopeText = typeof envelope.error === "string" && envelope.error.trim() !== "" ? envelope.error : ""
  // A 5xx with no envelope code (an Envoy 503, or a 500/502 during a deploy) says nothing about the
  // data source, so it gets the service-level copy that master shows. 504 keeps its timeout copy.
  const serviceFailure = envelopeCode === undefined && response.status >= 500 && response.status !== 504
  // Insights sends a recognised code with every query failure, so its classified copy replaces the server text.
  // Without a code (a proxy or a custom backend) the server's own text is kept.
  const message = envelopeCode !== undefined ? queryFailureMessages[envelopeCode]
    : envelopeText && response.status !== 403 ? envelopeText
    : serviceFailure ? serviceUnavailableMessage : queryFailureMessages[code]
  const limitScope = typeof envelope.limitScope === "string" && limitScopes.has(envelope.limitScope) ? envelope.limitScope : undefined
  return new InsightsQueryError(message, response.status, response.headers.get("Retry-After"), code, parseQueryDiagnostics(envelope.diagnostics), limitScope)
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
  async function request(path: string, init: RequestInit = {}, context?: ReturnType<typeof requestContext>, allowNotModified = false, deferSession = false, replayCapacity = true) {
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
      for (let attempt = 0; response.status === 429 && replayCapacity && attempt < 3 && canRetryCapacity(path, init); attempt++) {
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
      if (path === "/query") {
        // A receipt is bound to the principal that asked for it, like a body.
        if (identity() !== current.principal) throw new Error("Your session changed. Refresh the workspace before continuing.")
        const failure = await queryFailure(response)
        if (identity() !== current.principal) throw new Error("Your session changed. Refresh the workspace before continuing.")
        throw failure
      }
      if (response.status === 403 && path.startsWith("/provider-configs"))
        throw failure("Managing data sources requires Insights administrator access.")
      if (response.status === 403 && path === "/observe-connection")
        throw failure("Your account does not have access to Paprika Observe. Check your Observability permissions.")
      if (response.status === 403 && path.startsWith("/providers/"))
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
      const body = await readJSON<{ providers: Provider[]; unsupportedProviders?: UnsupportedProvider[]; sharedCatalog?: SharedCatalogStatus }>(
        await request("/providers", { signal }, undefined, false, true),
      )
      const shared = body.sharedCatalog
      const catalog: ProviderCatalog = {
        providers: body.providers,
        ...(body.unsupportedProviders?.length ? { unsupportedProviders: body.unsupportedProviders } : {}),
        ...(shared ? { sharedCatalog: shared } : {}),
      }
      if (shared?.status !== "busy" || attempt >= BUSY_LISTING_REPLAYS)
        return catalog
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
      if (options.selector) params.set("selector", options.selector)
      if (options.start !== undefined && options.end !== undefined) {
        params.set("start", String(Math.floor(options.start)))
        params.set("end", String(Math.floor(options.end)))
      }
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
    // The listing is the server's protojson, so it is read with the generated decoder. Unknown fields are ignored so an
    // older client keeps working when the server adds one.
    listRevisions: async (id, signal) => DashboardRevisionList.fromJson(
      await readJSON<JsonValue>(await request(`/dashboards/${encodeURIComponent(id)}/revisions`, { signal })),
      { ignoreUnknownFields: true },
    ),
    // The bytes of one revision, parsed as a stored dashboard. Its ETag is the content ETag of those bytes.
    getRevision: async (id, revision, signal) => {
      const response = await request(`/dashboards/${encodeURIComponent(id)}/revisions/${revision}`, { signal })
      return {
        dashboard: storedDashboardSchema.parse(await readJSON<Record<string, unknown>>(response)),
        etag: documentETag(response),
      }
    },
    // A restore is a conditional write: If-Match carries the dashboard's current ETag, so a stale view is refused with
    // the same reload message as a stale save. The message is percent-encoded, as the server expects.
    restoreRevision: async (id, revision, etag, message) => {
      const headers: Record<string, string> = { "If-Match": etag }
      if (message) headers["X-Insights-Revision-Message"] = encodeURIComponent(message)
      const response = await request(`/dashboards/${encodeURIComponent(id)}/revisions/${revision}/restore`, {
        method: "POST",
        headers,
      })
      return {
        dashboard: storedDashboardSchema.parse(await readJSON<Record<string, unknown>>(response)),
        etag: documentETag(response),
        revision: Number(response.headers.get("X-Paprika-Revision") ?? 0),
      }
    },
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
    query: async (body, signal, options) => {
      if (body.queryRef) throw new Error("Resolve the saved query through the Insights workspace before executing it.")
      const result = await readJSON<QueryResult>(
        await request("/query", {
          method: "POST",
          body: JSON.stringify(body),
          headers: options?.refresh ? { "X-Insights-Diagnostics": "1", "X-Insights-Cache": "refresh" } : { "X-Insights-Diagnostics": "1" },
          signal,
        }, undefined, false, false, options?.replayCapacity ?? true)
      )
      const diagnostics = parseQueryDiagnostics(result.diagnostics)
      if (body.kind === "records") {
        const records = parseRecordFrame(result.records)
        const truncation = parseTruncation(result.truncation)
        return {
          records,
          truncated: result.truncated || records.truncated,
          ...(truncation ? { truncation } : {}),
          ...(diagnostics ? { diagnostics } : {}),
        }
      }
      // Keep optional diagnostics on an allowlisted contract, including when an
      // older or custom backend adds unrecognized endpoint/credential fields.
      const data = { ...result }
      delete data.diagnostics
      return diagnostics ? { ...data, diagnostics } : data
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

export { jitter, REPLAY_DELAY_CAP_MS }
