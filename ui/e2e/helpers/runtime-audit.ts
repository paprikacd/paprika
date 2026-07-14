import { expect, type ConsoleMessage, type Page, type Request, type Response } from "@playwright/test"

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

/** Attaches before navigation and fails the test on any unreviewed runtime fault. */
export class RuntimeAudit {
  private readonly page: Page
  private readonly consoleErrors: string[] = []
  private readonly pageErrors: string[] = []
  private readonly failedRequests: string[] = []
  private readonly connectFailures: string[] = []
  private readonly eventRequests: string[] = []
  private readonly connectAllowances: ConnectFailureAllowance[] = []
  private readonly consoleAllowances: ConsoleAllowance[] = []
  private readonly requestFailureAllowances: RequestFailureAllowance[] = []

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
    if (new URL(request.url()).pathname === "/events") this.eventRequests.push(request.url())
  }

  private readonly onRequestFailed = (request: Request) => {
    const errorText = request.failure()?.errorText ?? "unknown failure"
    if (isCancelledNextPrefetch(this.page, request, errorText)) return
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
    if (!path.startsWith("/paprika.v1.PaprikaService/") || response.ok()) return
    const allowance = this.connectAllowances.find(
      (candidate) =>
        candidate.remaining > 0 && candidate.path === path && candidate.status === response.status(),
    )
    if (allowance) {
      allowance.remaining -= 1
      return
    }
    this.connectFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
  }

  constructor(page: Page) {
    this.page = page
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

  async assertClean() {
    this.stop()
    expect(this.consoleErrors, "browser console errors").toEqual([])
    expect(this.pageErrors, "uncaught page errors").toEqual([])
    expect(this.failedRequests, "failed browser requests").toEqual([])
    expect(this.connectFailures, "unexpected non-success Connect responses").toEqual([])
    expect(this.eventRequests, "the compiled console must never request /events").toEqual([])
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
  }

  stop() {
    this.page.off("console", this.onConsole)
    this.page.off("pageerror", this.onPageError)
    this.page.off("request", this.onRequest)
    this.page.off("requestfailed", this.onRequestFailed)
    this.page.off("response", this.onResponse)
  }
}

export function installRuntimeAudit(page: Page) {
  return new RuntimeAudit(page)
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

function pathMatches(expected: string | RegExp, actual: string) {
  return typeof expected === "string" ? expected === actual : expected.test(actual)
}
