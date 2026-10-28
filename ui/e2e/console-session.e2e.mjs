// Real console auth + local RSA OIDC issuer. No browser profile or credential
// from a real user is read. Run from ui/: node e2e/console-session.e2e.mjs
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, expect as baseExpect } from "@playwright/test"

const expect = baseExpect.configure({ timeout: 20_000 })

const ui = fileURLToPath(new URL("../", import.meta.url))
const repository = path.dirname(ui.replace(/\/$/, ""))
const output = path.resolve(ui, process.env.SESSION_E2E_OUTPUT || "test-results/console-session")
const temporary = await mkdtemp(path.join(tmpdir(), "paprika-console-session-"))
const children = []
const contexts = []
const checks = []
const themeChecks = []
let browser
let ready
let activePage
let cleanupPromise

function start(command, args, cwd = repository) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.output = ""
  const capture = (data) => { child.output = (child.output + data).slice(-12_000) }
  child.stdout.on("data", capture)
  child.stderr.on("data", capture)
  children.push(child)
  return child
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  const force = setTimeout(() => child.kill("SIGKILL"), 5000)
  force.unref()
  await exited
  clearTimeout(force)
}

function cleanup() {
  cleanupPromise ??= (async () => {
    for (const ctx of contexts) await ctx.close().catch(() => {})
    await browser?.close()
    for (const child of children.reverse()) await stop(child)
    await rm(temporary, { recursive: true, force: true })
  })()
  return cleanupPromise
}

process.once("SIGINT", () => { void cleanup().finally(() => process.exit(130)) })
process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(143)) })
const watchdog = setTimeout(() => {
  console.error("Console session E2E exceeded its four-minute limit")
  void cleanup().finally(() => process.exit(1))
}, 240_000)
watchdog.unref()

async function freePort() {
  const socket = createServer()
  socket.listen(0, "127.0.0.1")
  await once(socket, "listening")
  const port = socket.address().port
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()))
  return port
}

async function eventually(fn, message, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) { last = error }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ""}`)
}

async function control(command) {
  const response = await fetch(`${ready.baseURL}/__session_fixture/control`, {
    method: command ? "POST" : "GET",
    headers: { "X-Session-Fixture": ready.controlKey, ...(command ? { "Content-Type": "application/json" } : {}) },
    body: command ? JSON.stringify(command) : undefined,
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(response.status, 200, "fixture control should succeed")
  return response.json()
}

async function context(options = {}) {
  const result = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options })
  result.setDefaultTimeout(20_000)
  contexts.push(result)
  return result
}

async function newPage(ctx) {
  activePage = await ctx.newPage()
  return activePage
}

async function login(page, destination = "/dashboard/?service=uptime-api&range=1h") {
  await page.goto(`${ready.baseURL}/login/`)
  await page.evaluate((target) => localStorage.setItem("paprika_return_to", target), destination)
  await expect(page.getByRole("button", { name: /google|single sign-on|continue as/i }).first()).toBeVisible()
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: /google|single sign-on|continue as/i }).first().click()
  await page.waitForURL(`${ready.baseURL}${destination}`)
  if (destination.startsWith("/dashboard/")) {
    await expect(page.getByRole("button", { name: "Sign out", exact: true }).first()).toBeVisible()
  }
}

async function expire(page) {
  const state = await control()
  await page.evaluate((token) => localStorage.setItem("paprika_id_token", token), state.expiredToken)
}

async function proveAuthenticated(page) {
  const status = await page.evaluate(async () => {
    const response = await fetch("/__session_fixture/protected", { headers: { Authorization: `Bearer ${localStorage.getItem("paprika_id_token")}` } })
    return response.status
  })
  assert.equal(status, 200, "real OIDC verifier must accept the restored/refreshed token")
}

async function signOut(page) {
  await page.getByRole("button", { name: "Sign out", exact: true }).first().click()
  await page.waitForURL(`${ready.baseURL}/login/`)
  await expect(page.getByRole("button", { name: /google|single sign-on|continue as/i }).first()).toBeVisible()
}

async function captureLogin(page, name) {
  await page.evaluate(() => {
    localStorage.setItem("paprika-insights-theme", "system")
    window.dispatchEvent(new Event("paprika-insights-theme-change"))
  })
  for (const [mode, width, height] of [["light", 1440, 1000], ["dark", 1440, 1000], ["light", 375, 812], ["dark", 375, 812]]) {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: mode, reducedMotion: "reduce" })
    await expect(page.locator("[data-entry-theme]")).toHaveAttribute("data-entry-theme", mode)
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} must fit ${width}px without horizontal overflow`)
    const theme = await page.evaluate(() => {
      const scope = document.querySelector("[data-entry-theme]")
      const heading = scope.querySelector("h1")
      const canvas = document.createElement("canvas").getContext("2d")
      const luminance = (color) => {
        canvas.clearRect(0, 0, 1, 1)
        canvas.fillStyle = color
        canvas.fillRect(0, 0, 1, 1)
        const rgb = Array.from(canvas.getImageData(0, 0, 1, 1).data).slice(0, 3).map((channel) => channel / 255)
        return rgb.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
      }
      const background = getComputedStyle(scope).backgroundColor
      const contrast = (element) => {
        let surface = element
        while (surface !== scope && getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)") surface = surface.parentElement
        const ink = luminance(getComputedStyle(element).color)
        const paper = luminance(getComputedStyle(surface).backgroundColor)
        return (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05)
      }
      return {
        background, luminance: luminance(background), colorScheme: getComputedStyle(scope).colorScheme,
        contrast: contrast(heading), buttonContrast: contrast(scope.querySelector("button")), mutedContrast: contrast(scope.querySelector("p.text-muted-foreground")),
      }
    })
    assert.equal(theme.colorScheme, mode, "entry must declare the resolved color scheme")
    assert.ok(mode === "dark" ? theme.luminance < 0.12 : theme.luminance > 0.65, `${mode} entry background must actually match the theme`)
    assert.ok(theme.contrast >= 4.5, "entry heading must retain readable text contrast")
    assert.ok(theme.buttonContrast >= 4.5, "entry primary button must retain readable text contrast")
    assert.ok(theme.mutedContrast >= 4.5, "entry supporting text must retain readable contrast")
    themeChecks.push({ name, mode, width, ...theme })
    await page.screenshot({ path: path.join(output, `${name}-${width < 600 ? "mobile" : "desktop"}-${mode}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" })
  const primary = page.getByRole("button", { name: /google|single sign-on|continue as/i }).first()
  await primary.focus()
  await expect(primary).toBeFocused()
}

async function check(name, fn) {
  if (process.env.SESSION_E2E_FILTER && !name.includes(process.env.SESSION_E2E_FILTER)) return
  await control({ reset: true })
  await fn()
  checks.push(name)
  console.log(`PASS ${name}`)
}

try {
  await mkdir(output, { recursive: true })
  const binary = path.join(temporary, "console-session-fixture")
  const build = start("go", ["build", "-o", binary, "./hack/console-session-e2e"])
  const [buildCode] = await once(build, "exit")
  if (buildCode !== 0) throw new Error(`Build session fixture failed:\n${build.output}`)

  let uiURL = process.env.SESSION_E2E_UI_URL
  if (!uiURL && process.env.SESSION_E2E_STATIC !== "1") {
    uiURL = `http://127.0.0.1:${await freePort()}`
    const next = start(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", new URL(uiURL).port], ui)
    await eventually(async () => {
      if (next.exitCode !== null) throw new Error(`Next exited: ${next.output}`)
      return (await fetch(`${uiURL}/login/`, { signal: AbortSignal.timeout(10_000) })).ok
    }, "Next dev server did not become ready", 120_000)
  }

  const readyFile = path.join(temporary, "ready.json")
  const fixture = start(binary, ["--ready-file", readyFile, ...(uiURL ? ["--ui-url", uiURL] : ["--ui-dir", path.join(ui, "out")])])
  ready = await eventually(async () => {
    if (fixture.exitCode !== null) throw new Error(`Session fixture exited: ${fixture.output}`)
    return JSON.parse(await readFile(readyFile, "utf8"))
  }, "Session fixture did not become ready")
  console.log(`Console session E2E: app ${ready.baseURL}; issuer ${ready.issuerURL}; UI ${uiURL || "static export"}`)
  browser = await chromium.launch({ headless: true })

  await check("OIDC PKCE login preserves a dashboard query and hides disabled basic auth", async () => {
    const ctx = await context()
    const page = await newPage(ctx)
    await page.goto(`${ready.baseURL}/login/`)
    await expect(page.getByRole("button", { name: /google|single sign-on/i }).first()).toBeVisible()
    await captureLogin(page, "first-visit")
    await login(page)
    await proveAuthenticated(page)
    const stats = await control()
    assert.equal(stats.authorize, 1)
    assert.equal(stats.exchange, 1)
    const cookies = await ctx.cookies(`${ready.baseURL}/auth/refresh`)
    assert.ok(cookies.some((cookie) => cookie.httpOnly && cookie.path === "/auth"), "refresh must be an HttpOnly cookie scoped to auth")
    const sessionCookie = cookies.find((cookie) => cookie.httpOnly)
    assert.ok(sessionCookie.expires > Date.now() / 1000 + 6 * 24 * 60 * 60, "browser restart must retain the bounded persistent session")
    assert.equal(await page.evaluate((name) => document.cookie.includes(name), sessionCookie.name), false)
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some((key) => /refresh.*token/i.test(key))), false)
    await page.reload()
    await proveAuthenticated(page)
    assert.equal((await control()).authorize, 1, "valid reload should reuse the session")
    await page.screenshot({ path: path.join(output, "signed-in.png") })
    await ctx.close()
  })

  await check("expired token refresh is shared across concurrently restored tabs", async () => {
    const ctx = await context()
    const first = await newPage(ctx)
    await login(first)
    const second = await newPage(ctx)
    await second.goto(`${ready.baseURL}/dashboard/`)
    await control({ reset: true, refreshDelay: 200 })
    await expire(first)
    await Promise.all([first.reload(), second.reload()])
    await eventually(async () => (await control()).refresh > 0, "refresh did not begin")
    await expect(first.getByRole("button", { name: "Sign out", exact: true }).first()).toBeVisible()
    await expect(second.getByRole("button", { name: "Sign out", exact: true }).first()).toBeVisible()
    await proveAuthenticated(first)
    await proveAuthenticated(second)
    assert.equal((await control()).refresh, 1, "tabs must share one rotating-token refresh")
    assert.ok(!first.url().includes("/login/") && !second.url().includes("/login/"))
    await ctx.close()
  })

  await check("browser storage state resumes the HttpOnly session without an access token", async () => {
    const original = await context()
    const page = await newPage(original)
    await login(page)
    const state = await original.storageState()
    for (const origin of state.origins) origin.localStorage = origin.localStorage.filter(({ name }) => !["paprika_id_token", "paprika_auth_user"].includes(name))
    await original.close()
    await control({ reset: true })
    const restored = await context({ storageState: state })
    const returning = await newPage(restored)
    const signInNavigations = []
    returning.on("request", (request) => {
      if (request.isNavigationRequest() && new URL(request.url()).pathname === "/login/") signInNavigations.push(request.url())
    })
    await returning.goto(`${ready.baseURL}/dashboard/?service=uptime-api`)
    await expect(returning.getByRole("button", { name: "Sign out", exact: true }).first()).toBeVisible()
    await proveAuthenticated(returning)
    assert.equal((await control()).refresh, 1)
    assert.equal((await control()).authorize, 0)
    assert.equal(signInNavigations.length, 0, "restoration must not bounce through sign-in")
    await restored.close()
  })

  await check("temporary provider failure keeps the refresh session recoverable", async () => {
    const ctx = await context()
    const page = await newPage(ctx)
    await login(page)
    await expire(page)
    await control({ reset: true, refreshMode: "unavailable" })
    await page.reload()
    await eventually(async () => (await control()).refresh > 0, "transient refresh was not attempted")
    await expect(page.getByRole("button", { name: "Retry connection", exact: true })).toBeVisible()
    assert.ok((await ctx.cookies(`${ready.baseURL}/auth/refresh`)).some((cookie) => cookie.httpOnly), "503 must preserve refresh cookie")
    await control({ reset: true })
    await page.getByRole("button", { name: "Retry connection", exact: true }).click()
    await expect(page.getByRole("button", { name: "Sign out", exact: true }).first()).toBeVisible()
    await expect(page.getByText("Connection interrupted", { exact: true })).toHaveCount(0)
    await proveAuthenticated(page)
    assert.equal((await control()).authorize, 0, "network recovery should not require another OIDC login")
    await ctx.close()
  })

  await check("an interrupted refresh request can recover without signing in again", async () => {
    const ctx = await context()
    const page = await newPage(ctx)
    await login(page)
    await expire(page)
    await ctx.route("**/auth/refresh", (route) => route.abort("internetdisconnected"))
    await page.reload()
    await expect(page.getByRole("button", { name: "Retry connection", exact: true })).toBeVisible()
    assert.ok((await ctx.cookies(`${ready.baseURL}/auth/refresh`)).some((cookie) => cookie.httpOnly), "network interruption must preserve refresh cookie")
    await ctx.unroute("**/auth/refresh")
    await control({ reset: true })
    await page.getByRole("button", { name: "Retry connection", exact: true }).click()
    await expect(page.getByRole("button", { name: "Sign out", exact: true }).first()).toBeVisible()
    await expect(page.getByText("Connection interrupted", { exact: true })).toHaveCount(0)
    assert.equal(new URL(page.url()).pathname, "/dashboard/")
    await proveAuthenticated(page)
    assert.equal((await control()).authorize, 0)
    await ctx.close()
  })

  await check("revoked refresh returns to sign-in and preserves the dashboard destination", async () => {
    const ctx = await context()
    const page = await newPage(ctx)
    await login(page)
    const destination = new URL(page.url()).pathname + new URL(page.url()).search
    await expire(page)
    await control({ reset: true, refreshMode: "revoked" })
    await page.reload()
    await page.waitForURL(`${ready.baseURL}/login/`)
    assert.equal(await page.evaluate(() => localStorage.getItem("paprika_id_token")), null)
    assert.equal(await page.evaluate(() => localStorage.getItem("paprika_return_to")), destination)
    assert.equal((await ctx.cookies(`${ready.baseURL}/auth/refresh`)).filter((cookie) => cookie.httpOnly).length, 0)
    await ctx.close()
  })

  await check("logout synchronizes tabs and remembers the account without retaining its session", async () => {
    const ctx = await context()
    const first = await newPage(ctx)
    await login(first)
    const second = await newPage(ctx)
    await second.goto(`${ready.baseURL}/dashboard/`)
    await expect(second.getByRole("button", { name: "Sign out", exact: true }).first()).toBeVisible()
    await signOut(first)
    await second.waitForURL(`${ready.baseURL}/login/`)
    await expect(first.getByText("robin@example.test", { exact: true })).toBeVisible()
    await expect(first.getByText("Last used · Single sign-on", { exact: true })).toBeVisible()
    assert.equal((await ctx.cookies(`${ready.baseURL}/auth/refresh`)).filter((cookie) => cookie.httpOnly).length, 0)
    await captureLogin(first, "returning-user")
    await first.keyboard.press("Tab")
    await expect(first.getByRole("button", { name: /another account|different account|switch account/i })).toBeFocused()
    await first.keyboard.press("Tab")
    await expect(first.getByRole("button", { name: /forget/i })).toBeFocused()
    await ctx.close()
  })

  await check("sign-out wins over an in-flight refresh in another tab", async () => {
    const ctx = await context()
    const first = await newPage(ctx)
    await login(first)
    const second = await newPage(ctx)
    await second.goto(`${ready.baseURL}/dashboard/`)
    await expect(second.getByRole("button", { name: "Sign out", exact: true }).first()).toBeVisible()
    await control({ reset: true, refreshDelay: 1000 })
    await expire(first)
    const restoring = first.reload()
    await eventually(async () => (await control()).refresh > 0, "delayed refresh did not begin")
    await signOut(second)
    await restoring
    await first.waitForURL(`${ready.baseURL}/login/`)
    await eventually(async () => (await control()).logout > 0, "logout endpoint was not called")
    assert.equal(await first.evaluate(() => localStorage.getItem("paprika_id_token")), null)
    assert.equal((await ctx.cookies(`${ready.baseURL}/auth/refresh`)).filter((cookie) => cookie.httpOnly).length, 0, "a late refresh must not restore the cookie after logout")
    await first.reload()
    await expect(first.getByRole("button", { name: /google|single sign-on|continue as/i }).first()).toBeVisible()
    assert.equal(new URL(first.url()).pathname, "/login/")
    await ctx.close()
  })

  await check("remembered account can continue, switch account, or be forgotten", async () => {
    const ctx = await context()
    const page = await newPage(ctx)
    await login(page)
    await signOut(page)
    await page.getByRole("button", { name: /continue as|google|single sign-on/i }).first().click()
    await page.waitForURL(/\/dashboard\//)
    assert.equal((await control()).loginHint, "robin@example.test")
    await signOut(page)
    await page.getByRole("button", { name: /another account|different account|switch account/i }).click()
    await page.waitForURL(/\/dashboard\//)
    assert.ok((await control()).prompt.includes("select_account"))
    assert.equal((await control()).loginHint, "")
    await signOut(page)
    await page.getByRole("button", { name: /forget/i }).click()
    await expect(page.getByText("robin@example.test", { exact: true })).toHaveCount(0)
    assert.equal(await page.evaluate(() => localStorage.getItem("paprika_login_preference")), null)
    await page.reload()
    await expect(page.getByText("robin@example.test", { exact: true })).toHaveCount(0)
    await ctx.close()
  })

  await check("login resumes an Observe consent URL without changing its query string", async () => {
    const ctx = await context()
    const page = await newPage(ctx)
    await login(page, "/observe/consent?rid=fixture%3Fservice%3Duptime-api&scope=observe")
    await expect(page.getByRole("heading", { name: "Observe consent resumed" })).toBeVisible()
    await ctx.close()
  })

  await writeFile(path.join(output, "report.json"), JSON.stringify({ passed: checks, count: checks.length, themes: themeChecks, backend: "real auth handlers; loopback RSA OIDC issuer; no cluster" }, null, 2))
  console.log(`Console session E2E passed ${checks.length} scenarios.`)
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: path.join(output, "failure.png") }).catch(() => {})
  const diagnostic = activePage && !activePage.isClosed() ? await activePage.evaluate(() => ({
    path: location.pathname + location.search,
    hasAccessToken: Boolean(localStorage.getItem("paprika_id_token")),
    hasUser: Boolean(localStorage.getItem("paprika_auth_user")),
    session: JSON.parse(localStorage.getItem("paprika_session_state") || "null"),
    visibleText: document.body.innerText.slice(-2500),
  })).catch(() => null) : null
  const counts = ready ? await control().catch(() => ({})) : {}
  delete counts.expiredToken
  await writeFile(path.join(output, "report.json"), JSON.stringify({ passed: checks, themes: themeChecks, failure: error.message, diagnostic, counts }, null, 2))
  console.error(error)
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await cleanup()
}
