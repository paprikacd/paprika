import { expect, type ConsoleMessage, type Page, type Request, type Response } from "@playwright/test"

import {
  QUERY_FLEET_MAP_PATH,
  flattenApplicationLeaves,
  independentStableIdDigest,
  sampledPreviewSignals,
  type ExactFleetMapExpectation,
  type WireFleetMapNode,
} from "./fleet-map-oracle"
import { auditRunScopedResponse } from "./run-scoped-response-audit"

interface ConnectFailureAllowance {
  path: string
  status: number
  remaining: number
}

interface ConsoleAllowance {
  pattern: RegExp
  remaining: number
}

interface RequestFailureAllowance {
  path: string | RegExp
  method: string
  errorText: string
  remaining: number
  required: boolean
}

interface UnscopedQueryAllowance {
  path: string
  remaining: number
}

interface RuntimeAuditOptions {
  allowIntentionalUnscoped?: boolean
}

/** Attaches before navigation and fails the test on any unreviewed runtime fault. */
export class RuntimeAudit {
  private readonly page: Page
  private readonly allowIntentionalUnscoped: boolean
  private readonly consoleErrors: string[] = []
  private readonly pageErrors: string[] = []
  private readonly failedRequests: string[] = []
  private readonly connectFailures: string[] = []
  private readonly eventRequests: string[] = []
  private readonly failedResourceResponses: string[] = []
  private readonly fixtureNamespaceViolations: string[] = []
  private readonly fleetSnapshotViolations: string[] = []
  private readonly sampledPreviewViolations: string[] = []
  private readonly responseAuditErrors: string[] = []
  private readonly connectAllowances: ConnectFailureAllowance[] = []
  private readonly consoleAllowances: ConsoleAllowance[] = []
  private readonly requestFailureAllowances: RequestFailureAllowance[] = []
  private readonly unscopedQueryAllowances: UnscopedQueryAllowance[] = []
  private readonly pendingResponseAudits = new Set<Promise<void>>()
  private expectedFleetMap?: ExactFleetMapExpectation
  private exactFleetMapObservations = 0
  private readonly initialization: Promise<void>
  private latestNavigationURL = ""

  private readonly onConsole = (message: ConsoleMessage) => {
    if (message.type() !== "error") return
    const allowed = this.consoleAllowances.find(
      (allowance) => allowance.remaining > 0 && allowance.pattern.test(message.text()),
    )
    if (allowed) {
      allowed.remaining -= 1
      return
    }
    this.consoleErrors.push(message.text())
  }

  private readonly onPageError = (error: Error) => {
    this.pageErrors.push(error.stack ?? error.message)
  }

  private readonly onRequest = (request: Request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document") {
      this.latestNavigationURL = request.url()
    }
    if (new URL(request.url()).pathname === "/events") this.eventRequests.push(request.url())
  }

  private readonly onRequestFailed = (request: Request) => {
    const errorText = request.failure()?.errorText ?? "unknown failure"
    if (isCancelledNextPrefetch(this.page, request, errorText)) return
    if (isCancelledAdminSessionProbe(this.page, request, errorText)) return
    if (isCancelledSupersededNextChunk(request, errorText, this.latestNavigationURL)) return
    const path = new URL(request.url()).pathname
    const allowance = this.requestFailureAllowances.find(
      (candidate) =>
        candidate.remaining > 0 &&
        pathMatches(candidate.path, path) &&
        candidate.method === request.method() &&
        candidate.errorText === errorText,
    )
    if (allowance) {
      allowance.remaining -= 1
      return
    }
    this.failedRequests.push(`${request.method()} ${request.url()}: ${errorText}`)
  }

  private readonly onResponse = (response: Response) => {
    const path = new URL(response.url()).pathname
    if (!response.ok() && isBrowserResource(response.request())) {
      this.failedResourceResponses.push(
        `${response.status()} ${response.request().resourceType()} ${response.url()}`,
      )
    }
    if (!path.startsWith("/paprika.v1.PaprikaService/")) return
    if (!response.ok()) {
      const allowance = this.connectAllowances.find(
        (candidate) =>
          candidate.remaining > 0 && candidate.path === path && candidate.status === response.status(),
      )
      if (allowance) {
        allowance.remaining -= 1
        return
      }
      this.connectFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
      return
    }
    if (!this.expectedFleetMap) return
    const audit = this.auditRunScopedResponse(response, path)
    this.pendingResponseAudits.add(audit)
    void audit.finally(() => this.pendingResponseAudits.delete(audit))
  }

  constructor(page: Page, options: RuntimeAuditOptions = {}) {
    this.page = page
    this.allowIntentionalUnscoped = options.allowIntentionalUnscoped ?? false
    this.initialization = installReviewedAdminSessionStub(page)
    page.on("console", this.onConsole)
    page.on("pageerror", this.onPageError)
    page.on("request", this.onRequest)
    page.on("requestfailed", this.onRequestFailed)
    page.on("response", this.onResponse)
  }

  allowConnectFailure(path: string, status: number, count = 1) {
    this.connectAllowances.push({ path, status, remaining: count })
  }

  allowConsoleError(pattern: RegExp, count = 1) {
    this.consoleAllowances.push({ pattern, remaining: count })
  }

  allowRequestFailure(path: string, method: string, errorText: string, count = 1) {
    this.requestFailureAllowances.push({ path, method, errorText, remaining: count, required: true })
  }

  allowOptionalRequestFailure(path: string | RegExp, method: string, errorText: string, count = 1) {
    this.requestFailureAllowances.push({ path, method, errorText, remaining: count, required: false })
  }

  allowUnscopedQueryOnce(path: string) {
    if (!this.allowIntentionalUnscoped) {
      throw new Error("intentional unscoped queries are disabled for this runtime audit")
    }
    if (path !== QUERY_FLEET_MAP_PATH) {
      throw new Error(`unscoped query allowance is restricted to ${QUERY_FLEET_MAP_PATH}`)
    }
    this.unscopedQueryAllowances.push({ path, remaining: 1 })
  }

  async assertUnscopedQueryAllowanceConsumed(path: string) {
    await this.settleResponseAudits()
    const allowance = [...this.unscopedQueryAllowances]
      .reverse()
      .find((candidate) => candidate.path === path)
    expect(allowance, `an unscoped query allowance must be armed for ${path}`).toBeDefined()
    expect(allowance?.remaining, `the unscoped query allowance for ${path} must be consumed`)
      .toBe(0)
  }

  expectFleetRun(expected: ExactFleetMapExpectation) {
    this.expectedFleetMap = {
      ...expected,
      stableIds: [...expected.stableIds],
    }
  }

  async ready() {
    await this.initialization
  }

  async assertClean() {
    await this.initialization
    await this.settleResponseAudits()
    this.stop()
    expect(this.consoleErrors, "browser console errors").toEqual([])
    expect(this.pageErrors, "uncaught page errors").toEqual([])
    expect(this.failedRequests, "failed browser requests").toEqual([])
    expect(this.failedResourceResponses, "non-success document/script/style/image/font responses")
      .toEqual([])
    expect(this.connectFailures, "unexpected non-success Connect responses").toEqual([])
    expect(this.eventRequests, "the compiled console must never request /events").toEqual([])
    expect(this.responseAuditErrors, "successful Connect response audit errors").toEqual([])
    expect(this.fixtureNamespaceViolations, "foreign-namespace fixture objects").toEqual([])
    expect(this.sampledPreviewViolations, "sampled or truncated fleet previews").toEqual([])
    expect(this.fleetSnapshotViolations, "exact run-scoped fleet map count/identity/digest")
      .toEqual([])
    if (this.expectedFleetMap) {
      expect(
        this.exactFleetMapObservations,
        "at least one exact unfiltered run-namespace fleet map must be accepted",
      ).toBeGreaterThan(0)
    }
    expect(
      this.connectAllowances.filter((allowance) => allowance.remaining !== 0),
      "every intentionally allowed Connect failure must occur exactly as declared",
    ).toEqual([])
    expect(
      this.consoleAllowances.filter((allowance) => allowance.remaining !== 0),
      "every intentionally allowed console error must occur exactly as declared",
    ).toEqual([])
    expect(
      this.requestFailureAllowances.filter(
        (allowance) => allowance.required && allowance.remaining !== 0,
      ),
      "every intentionally allowed request cancellation must occur exactly as declared",
    ).toEqual([])
    expect(
      this.unscopedQueryAllowances.filter((allowance) => allowance.remaining !== 0),
      "every intentionally allowed unscoped query must occur exactly once",
    ).toEqual([])
  }

  stop() {
    this.page.off("console", this.onConsole)
    this.page.off("pageerror", this.onPageError)
    this.page.off("request", this.onRequest)
    this.page.off("requestfailed", this.onRequestFailed)
    this.page.off("response", this.onResponse)
  }

  private async auditRunScopedResponse(response: Response, path: string) {
    try {
      const body = await response.json() as Record<string, unknown>
      for (const signal of sampledPreviewSignals(body)) {
        this.sampledPreviewViolations.push(`${path}: ${signal}`)
      }
      const expected = this.expectedFleetMap
      if (!expected) return
      const request = requestRecord(response.request())
      if (this.consumeUnscopedQueryAllowance(path, request)) return
      const runScopeAudit = auditRunScopedResponse(
        path,
        request,
        body,
        expected.namespace,
      )
      for (const violation of runScopeAudit.violations) {
        this.fixtureNamespaceViolations.push(`${path}: ${violation}`)
      }
      if (path !== "/paprika.v1.PaprikaService/QueryFleetMap") return
      if (!isExactNamespaceOnlyFleetRequest(request, expected.namespace)) return

      this.exactFleetMapObservations += 1
      const roots = Array.isArray(body.roots) ? body.roots as WireFleetMapNode[] : []
      const leaves = flattenApplicationLeaves(roots)
      const stableIds = leaves.flatMap((leaf) =>
        typeof leaf.stableId === "string" ? [leaf.stableId] : [],
      )
      const total = decimalResponseCount(body.total)
      const violations: string[] = []
      if (leaves.length !== expected.count || total !== expected.count) {
        violations.push(`count response=${total} leaves=${leaves.length} expected=${expected.count}`)
      }
      if (stableIds.length !== leaves.length) violations.push("one or more leaves omitted stableId")
      if (JSON.stringify([...stableIds].sort()) !== JSON.stringify([...expected.stableIds].sort())) {
        violations.push("stable identities differ from the exact fixture inventory")
      }
      const digest = independentStableIdDigest(stableIds)
      if (digest !== expected.digest) {
        violations.push(`digest=${digest} expected=${expected.digest}`)
      }
      if (violations.length > 0) {
        this.fleetSnapshotViolations.push(`${path}: ${violations.join("; ")}`)
      }
    } catch (error) {
      this.responseAuditErrors.push(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private consumeUnscopedQueryAllowance(
    path: string,
    request: Record<string, unknown>,
  ) {
    if (path !== QUERY_FLEET_MAP_PATH || !isUnscopedQueryRequest(request)) return false
    const allowance = this.unscopedQueryAllowances.find(
      (candidate) => candidate.path === path && candidate.remaining > 0,
    )
    if (!allowance) return false
    allowance.remaining -= 1
    return true
  }

  private async settleResponseAudits() {
    while (this.pendingResponseAudits.size > 0) {
      await Promise.allSettled([...this.pendingResponseAudits])
    }
  }
}

export function installRuntimeAudit(page: Page, options: RuntimeAuditOptions = {}) {
  return new RuntimeAudit(page, options)
}

function isCancelledNextPrefetch(page: Page, request: Request, errorText: string) {
  if (errorText !== "net::ERR_ABORTED") return false
  const requested = new URL(request.url())
  const current = new URL(page.url())
  if (requested.origin !== current.origin || !requested.pathname.startsWith("/dashboard/")) {
    return false
  }
  if (request.method() === "HEAD") {
    const headers = request.headers()
    if (request.resourceType() !== "fetch" || !headers.referer) return false
    const referringPage = new URL(headers.referer)
    return referringPage.origin === requested.origin &&
      (referringPage.pathname === "/dashboard" ||
        referringPage.pathname.startsWith("/dashboard/"))
  }
  const headers = request.headers()
  return request.method() === "GET" &&
    request.resourceType() === "fetch" &&
    headers["next-router-prefetch"] === "1" &&
    headers.rsc === "1" &&
    requested.searchParams.has("_rsc")
}

function isCancelledAdminSessionProbe(page: Page, request: Request, errorText: string) {
  if (
    process.env.PAPRIKA_E2E_ADMIN_SESSION_STUB !== "1" ||
    errorText !== "net::ERR_ABORTED" ||
    request.method() !== "GET" ||
    request.resourceType() !== "fetch"
  ) {
    return false
  }
  const requested = new URL(request.url())
  const current = new URL(page.url())
  return requested.origin === current.origin && requested.pathname === "/admin/session"
}

function isCancelledSupersededNextChunk(
  request: Request,
  errorText: string,
  latestNavigationURL: string,
) {
  if (
    errorText !== "net::ERR_ABORTED" ||
    request.method() !== "GET" ||
    request.resourceType() !== "script"
  ) {
    return false
  }
  const requested = new URL(request.url())
  if (!/^\/_next\/static\/chunks\/[A-Za-z0-9._-]+[.]js$/u.test(requested.pathname)) {
    return false
  }
  const referer = request.headers().referer
  if (!referer || !latestNavigationURL) return false
  const referringPage = new URL(referer)
  const destination = new URL(latestNavigationURL)
  return requested.origin === destination.origin &&
    referringPage.origin === destination.origin &&
    referringPage.pathname.startsWith("/dashboard") &&
    destination.pathname.startsWith("/dashboard") &&
    referringPage.href !== destination.href
}

function pathMatches(expected: string | RegExp, actual: string) {
  return typeof expected === "string" ? expected === actual : expected.test(actual)
}

function isBrowserResource(request: Request) {
  return ["document", "script", "stylesheet", "image", "font"]
    .includes(request.resourceType())
}

function requestRecord(request: Request): Record<string, unknown> {
  try {
    const body = request.postDataJSON()
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function isExactNamespaceOnlyFleetRequest(
  request: Record<string, unknown>,
  namespace: string,
) {
  const filter = request.filter
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return false
  const value = filter as Record<string, unknown>
  if (
    !Array.isArray(value.namespaces) ||
    value.namespaces.length !== 1 ||
    value.namespaces[0] !== namespace
  ) {
    return false
  }
  return ["projects", "clusters", "stages", "health"].every(
    (key) => !Array.isArray(value[key]) || (value[key] as unknown[]).length === 0,
  )
}

function isUnscopedQueryRequest(request: Record<string, unknown>) {
  const filter = request.filter
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return true
  const namespaces = (filter as Record<string, unknown>).namespaces
  return namespaces === undefined ||
    (Array.isArray(namespaces) && namespaces.length === 0)
}

function decimalResponseCount(value: unknown) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid fleet response total ${JSON.stringify(value)}`)
  }
  return parsed
}

async function installReviewedAdminSessionStub(page: Page) {
  if (process.env.PAPRIKA_E2E_ADMIN_SESSION_STUB !== "1") return
  const subject =
    process.env.PAPRIKA_E2E_ADMIN_SUBJECT ??
    "system:serviceaccount:paprika-e2e:reviewed-fleet-admin"
  await page.route("**/admin/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        absoluteExpiresAt: "2099-01-01T00:00:00Z",
        accessMode: "kubernetes-port-forward-admin",
        idleExpiresAt: "2098-01-01T00:00:00Z",
        subject,
      }),
    })
  })
}
