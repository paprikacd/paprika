"use client"

import { clearBrowserQueryCache } from "@/lib/query-provider"

export const AUTH_TOKEN_KEY = "paprika_id_token"
export const AUTH_USER_KEY = "paprika_auth_user"
export const LOGIN_PREFERENCE_KEY = "paprika_login_preference"
const SESSION_STATE_KEY = "paprika_session_state"
const LOCK_KEY = "paprika_session_lock"
const REFRESH_WINDOW = 60_000

export interface AuthUser { sub: string; email: string; name: string; picture?: string }
export interface LoginPreference { method: "oidc" | "basic"; provider?: "google" | "oidc"; user: AuthUser }
export interface AuthConfiguration {
  oidc: { enabled: boolean; provider: "google" | "oidc"; label: string }
  basic: { enabled: boolean }
  session: { refreshEnabled: boolean }
}
export interface SessionSnapshot {
  status: "loading" | "authenticated" | "anonymous" | "unavailable"
  idToken: string | null
  user: AuthUser | null
  identityKey: string | null
  identityEpoch: number
  revision: number
  error: string | null
  logoutPending: boolean
}
interface SessionState { refreshAvailable?: boolean; loggedOut?: boolean; revision?: string }
type TokenOptions = Pick<LoginPreference, "method" | "provider"> & { sessionRefreshAvailable?: boolean }
const initialSnapshot: SessionSnapshot = { status: "loading", idToken: null, user: null, identityKey: null, identityEpoch: 0, revision: 0, error: null, logoutPending: false }
let snapshot = initialSnapshot
let hydrated = false
let refreshFlight: Promise<string | null> | undefined
let configurationFlight: Promise<AuthConfiguration> | undefined
let configuration: AuthConfiguration | undefined
let retryAfter = 0
let listening = false
const listeners = new Set<() => void>()
// Browsers that deny storage still support an in-memory session for this tab.
const memory = new Map<string, string>()
const failedWrites = new Map<string, string | null>()

export function readBrowserStorage(key: string): string | null {
  if (failedWrites.has(key)) return failedWrites.get(key) ?? null
  try { return localStorage.getItem(key) } catch { return memory.get(key) ?? null }
}
export function writeBrowserStorage(key: string, value: string | null) {
  if (value === null) memory.delete(key)
  else memory.set(key, value)
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); failedWrites.delete(key) } catch { failedWrites.set(key, value) }
}
function readState(): SessionState {
  try {
    const value = JSON.parse(readBrowserStorage(SESSION_STATE_KEY) ?? "{}")
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return { refreshAvailable: typeof value.refreshAvailable === "boolean" ? value.refreshAvailable : undefined, loggedOut: typeof value.loggedOut === "boolean" ? value.loggedOut : undefined, revision: typeof value.revision === "string" ? value.revision : undefined }
  } catch { return {} }
}
function writeState(state: SessionState) {
  writeBrowserStorage(SESSION_STATE_KEY, JSON.stringify({ ...state, revision: crypto.randomUUID() }))
}
function parseToken(token: string | null): Record<string, unknown> | null {
  if (!token) return null
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const raw = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))))
    return payload && typeof payload === "object" && typeof payload.sub === "string" && typeof payload.exp === "number" ? payload : null
  } catch { return null }
}
function string(value: unknown) { return typeof value === "string" ? value : "" }
function profile(payload: Record<string, unknown>): AuthUser {
  const picture = string(payload.picture)
  return { sub: string(payload.sub), email: string(payload.email), name: string(payload.name), ...(picture.startsWith("https://") ? { picture } : {}) }
}
function normalized(value: unknown): unknown {
  return Array.isArray(value) ? [...value].map(String).sort() : value ?? null
}
function identity(payload: Record<string, unknown>): string {
  // Expiry, issued-at and signature rotate without changing authorization.
  return JSON.stringify([payload.iss ?? null, payload.sub, normalized(payload.aud), payload.email ?? null, normalized(payload.groups), normalized(payload.roles), typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean).sort() : normalized(payload.scope)])
}
function expiresAt(token: string | null) { return Number(parseToken(token)?.exp ?? 0) * 1000 }
function refreshWindow(token: string | null) {
  const payload = parseToken(token)
  const lifetime = typeof payload?.iat === "number" ? (Number(payload.exp) - payload.iat) * 1000 : REFRESH_WINDOW * 5
  return Math.min(REFRESH_WINDOW, Math.max(1_000, lifetime * .2))
}
export function sessionRefreshDelay() { return Math.max(1_000, expiresAt(snapshot.idToken) - Date.now() - refreshWindow(snapshot.idToken)) }

function publish(next: Partial<SessionSnapshot>, invalidate = false) {
  const identityChanged = "identityKey" in next && next.identityKey !== snapshot.identityKey
  if (identityChanged || invalidate) clearBrowserQueryCache()
  snapshot = { ...snapshot, ...next, revision: snapshot.revision + 1, identityEpoch: snapshot.identityEpoch + (identityChanged || invalidate ? 1 : 0) }
  listeners.forEach((listener) => listener())
}

export function getSessionSnapshot() { return snapshot }
export function getServerSessionSnapshot() { return initialSnapshot }
export function subscribeSession(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function readLoginPreference(): LoginPreference | null {
  try {
    const value = JSON.parse(readBrowserStorage(LOGIN_PREFERENCE_KEY) ?? "null") as LoginPreference | null
    if (!value || !["basic", "oidc"].includes(value.method) || !value.user || typeof value.user.sub !== "string") return null
    return { method: value.method, provider: value.provider === "google" ? "google" : "oidc", user: profile(value.user as unknown as Record<string, unknown>) }
  } catch { return null }
}
export function forgetLoginPreference() {
  writeBrowserStorage(LOGIN_PREFERENCE_KEY, null)
  publish({})
}

function adoptToken(token: string, status: SessionSnapshot["status"] = "authenticated") {
  const payload = parseToken(token)
  if (!payload) return false
  publish({ idToken: token, user: profile(payload), identityKey: identity(payload), status, error: null })
  return true
}
function anonymous(invalidate = false) {
  writeBrowserStorage(AUTH_TOKEN_KEY, null)
  writeBrowserStorage(AUTH_USER_KEY, null)
  publish({ idToken: null, user: null, identityKey: null, status: "anonymous", error: null }, invalidate)
}

export function completeSession(idToken: string, options?: TokenOptions): boolean {
  const payload = parseToken(idToken)
  if (!payload || expiresAt(idToken) <= Date.now()) return false
  hydrated = true
  listenForStorage()
  retryAfter = 0
  writeBrowserStorage(AUTH_TOKEN_KEY, idToken)
  writeBrowserStorage(AUTH_USER_KEY, JSON.stringify(profile(payload)))
  writeState({ loggedOut: false, refreshAvailable: options?.sessionRefreshAvailable ?? readState().refreshAvailable })
  if (options) writeBrowserStorage(LOGIN_PREFERENCE_KEY, JSON.stringify({ method: options.method, provider: options.provider, user: profile(payload) }))
  adoptToken(idToken)
  return true
}

function hydrate() {
  listenForStorage()
  if (hydrated || typeof window === "undefined") return
  hydrated = true
  const token = readBrowserStorage(AUTH_TOKEN_KEY)
  if (!readState().loggedOut && token) adoptToken(token, expiresAt(token) > Date.now() ? "authenticated" : "loading")
}
function listenForStorage() {
  if (typeof window !== "undefined" && !listening) {
    listening = true
    window.addEventListener("storage", syncSessionFromStorage)
  }
}
export function syncSessionFromStorage(event?: StorageEvent) {
  if (event?.key && ![AUTH_TOKEN_KEY, SESSION_STATE_KEY, LOGIN_PREFERENCE_KEY].includes(event.key)) return
  if (event?.key) failedWrites.delete(event.key)
  const state = readState()
  const token = readBrowserStorage(AUTH_TOKEN_KEY)
  if (state.loggedOut || !token) {
    if (snapshot.idToken || snapshot.status !== "anonymous") anonymous()
    else publish({})
  } else if (token !== snapshot.idToken) {
    adoptToken(token, expiresAt(token) > Date.now() ? "authenticated" : "loading")
  } else if (event?.key === LOGIN_PREFERENCE_KEY) publish({})
}

export async function getAuthConfiguration(): Promise<AuthConfiguration> {
  if (configuration) return configuration
  configurationFlight ??= fetch("/auth/config", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(12_000) }).then(async (response) => {
    if (!response.ok) throw new Error("Sign-in options are temporarily unavailable. Please try again.")
    const value = await response.json() as AuthConfiguration
    if (typeof value.oidc?.enabled !== "boolean" || typeof value.basic?.enabled !== "boolean" || typeof value.session?.refreshEnabled !== "boolean") throw new Error("Sign-in options are temporarily unavailable. Please try again.")
    configuration = value
    return value
  }).finally(() => { configurationFlight = undefined })
  return configurationFlight
}

export class SessionUnavailableError extends Error {
  constructor() { super("We couldn’t reconnect to Paprika. Check your connection and retry."); this.name = "SessionUnavailableError" }
}

async function withSessionLock<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) return navigator.locks.request("paprika-browser-session", work)
  // Best-effort lease for older browsers. Web Locks provide atomic coordination
  // where supported; this lease also expires if another tab crashes.
  const owner = crypto.randomUUID()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    let lease: { owner?: string; until?: number } = {}
    try { lease = JSON.parse(readBrowserStorage(LOCK_KEY) ?? "{}") } catch { /* Replace corrupt leases. */ }
    if (!lease.until || lease.until < Date.now()) {
      writeBrowserStorage(LOCK_KEY, JSON.stringify({ owner, until: Date.now() + 15_000 }))
      await new Promise((resolve) => setTimeout(resolve, 30))
      try {
        if (JSON.parse(readBrowserStorage(LOCK_KEY) ?? "{}").owner === owner) {
          try { return await work() } finally {
            if (JSON.parse(readBrowserStorage(LOCK_KEY) ?? "{}").owner === owner) writeBrowserStorage(LOCK_KEY, null)
          }
        }
      } catch (error) { if (error instanceof SessionUnavailableError) throw error; throw error }
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new SessionUnavailableError()
}

async function refreshSession(rejectedBearer?: string | null): Promise<string | null> {
  if (refreshFlight) return refreshFlight
  const beforeToken = snapshot.idToken
  const beforeEpoch = snapshot.identityEpoch
  refreshFlight = withSessionLock(async () => {
    const state = readState()
    if (state.loggedOut || snapshot.identityEpoch !== beforeEpoch) return null
    const shared = readBrowserStorage(AUTH_TOKEN_KEY)
    if (shared && shared !== beforeToken && shared !== rejectedBearer && expiresAt(shared) > Date.now()) {
      adoptToken(shared)
      return shared
    }
    const fence = state.revision
    const response = await fetch("/auth/refresh", { method: "POST", credentials: "same-origin", headers: { "X-Paprika-Session": "1" }, signal: AbortSignal.timeout(12_000) })
    // Logout/account switching may occur while the network request is in flight.
    if (snapshot.identityEpoch !== beforeEpoch || readState().revision !== fence || readState().loggedOut) return null
    if (response.status === 401) {
      writeState({ refreshAvailable: false, loggedOut: true })
      anonymous()
      return null
    }
    if (!response.ok) throw new SessionUnavailableError()
    const data = await response.json() as { idToken: string; sessionRefreshAvailable?: boolean }
    if (snapshot.identityEpoch !== beforeEpoch || readState().revision !== fence || readState().loggedOut) return null
    const preference = readLoginPreference()
    if (!completeSession(data.idToken, preference ? { method: preference.method, provider: preference.provider, sessionRefreshAvailable: data.sessionRefreshAvailable } : undefined)) throw new SessionUnavailableError()
    if (!preference) writeState({ loggedOut: false, refreshAvailable: data.sessionRefreshAvailable })
    return data.idToken
  }).catch((error: unknown) => {
    if (snapshot.identityEpoch !== beforeEpoch || readState().loggedOut) return null
    retryAfter = Date.now() + 15_000
    const unavailable = error instanceof SessionUnavailableError ? error : new SessionUnavailableError()
    publish({ status: "unavailable", error: unavailable.message })
    throw unavailable
  }).finally(() => { refreshFlight = undefined })
  return refreshFlight
}

export async function ensureValidSession(options: { forceRefresh?: boolean } = {}): Promise<string | null> {
  hydrate()
  const state = readState()
  if (state.loggedOut) { if (snapshot.status !== "anonymous") anonymous(); return null }
  const remaining = expiresAt(snapshot.idToken) - Date.now()
  if (!options.forceRefresh && remaining > refreshWindow(snapshot.idToken)) return snapshot.idToken
  if (!options.forceRefresh && retryAfter > Date.now()) {
    if (remaining > 0) return snapshot.idToken
    throw new SessionUnavailableError()
  }
  try {
    const config = await getAuthConfiguration()
    if (!config.session.refreshEnabled || state.refreshAvailable === false) {
      if (remaining > 0) return snapshot.idToken
      anonymous()
      return null
    }
    return await refreshSession()
  } catch (error) {
    if (remaining > 0 && !options.forceRefresh) return snapshot.idToken
    retryAfter = Date.now() + 15_000
    if (snapshot.status !== "unavailable") publish({ status: "unavailable", error: new SessionUnavailableError().message })
    throw error
  }
}

export function bootstrapSession() { return ensureValidSession() }

export async function recoverUnauthorized(rejectedBearer: string | null): Promise<string | null> {
  hydrate()
  if (rejectedBearer !== snapshot.idToken) return ensureValidSession()
  if (readState().loggedOut) return null
  if (retryAfter > Date.now()) throw new SessionUnavailableError()
  const epoch = snapshot.identityEpoch
  try {
    const config = await getAuthConfiguration()
    if (!config.session.refreshEnabled || readState().refreshAvailable === false) { clearRejectedSession(rejectedBearer); return null }
    return await refreshSession(rejectedBearer)
  } catch {
    if (snapshot.identityEpoch !== epoch || readState().loggedOut) return null
    retryAfter = Date.now() + 15_000
    const unavailable = new SessionUnavailableError()
    if (snapshot.status !== "unavailable") publish({ status: "unavailable", error: unavailable.message })
    throw unavailable
  }
}

export function clearRejectedSession(rejectedBearer: string | null) {
  if (snapshot.idToken !== rejectedBearer || readBrowserStorage(AUTH_TOKEN_KEY) !== rejectedBearer) return
  writeState({ refreshAvailable: false, loggedOut: true })
  anonymous()
}

export async function logoutSession() {
  hydrate()
  publish({ logoutPending: true })
  // Write the tombstone before waiting for a refreshing tab's lock.
  writeState({ loggedOut: true, refreshAvailable: false })
  anonymous(true)
  writeBrowserStorage("paprika_return_to", null)
  try {
    const config = await getAuthConfiguration().catch(() => null)
    if (config && !config.session.refreshEnabled) return
    await withSessionLock(async () => {
      const response = await fetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-Paprika-Session": "1" }, signal: AbortSignal.timeout(12_000) })
      if (!response.ok) throw new SessionUnavailableError()
    })
  } finally { publish({ logoutPending: false }) }
}

export async function exchangeAuthorizationCode(body: { code: string; codeVerifier: string; redirectUri: string }, provider: "google" | "oidc") {
  listenForStorage()
  const epoch = snapshot.identityEpoch
  const fence = readState().revision
  await withSessionLock(async () => {
    if (snapshot.identityEpoch !== epoch || readState().revision !== fence) throw new Error("Sign-in was cancelled because the session changed. Please sign in again.")
    const response = await fetch("/auth/token", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Paprika-Session": "1" }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) })
    if (!response.ok) throw new Error("Token exchange failed. Please sign in again.")
    const data = await response.json() as { idToken: string; sessionRefreshAvailable?: boolean }
    if (snapshot.identityEpoch !== epoch || readState().revision !== fence) throw new Error("Sign-in was cancelled because the session changed. Please sign in again.")
    if (!completeSession(data.idToken, { method: "oidc", provider, sessionRefreshAvailable: data.sessionRefreshAvailable })) throw new Error("Invalid session response. Please sign in again.")
  })
}

export async function exchangePasswordForSession(credentials: { username: string; password: string }) {
  listenForStorage()
  const epoch = snapshot.identityEpoch
  const fence = readState().revision
  const unchanged = () => snapshot.identityEpoch === epoch && readState().revision === fence
  const cancelled = () => new Error("Sign-in was cancelled because the session changed. Please sign in again.")
  const config = await getAuthConfiguration()
  if (!config.basic.enabled) throw new Error("Password sign-in is not enabled for this console.")
  await withSessionLock(async () => {
    if (!unchanged()) throw cancelled()
    const response = await fetch("/auth/basic-login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Paprika-Session": "1" }, body: JSON.stringify(credentials), signal: AbortSignal.timeout(12_000) })
    if (!response.ok) throw new Error((await response.text()).slice(0, 300) || "Sign-in failed. Please try again.")
    const data = await response.json() as { idToken: string }
    if (!unchanged()) throw cancelled()
    if (!parseToken(data.idToken) || expiresAt(data.idToken) <= Date.now()) throw new Error("Invalid session response. Please sign in again.")
    if (config.session.refreshEnabled) {
      // Basic auth must not leave another account's OIDC refresh grant behind.
      const logout = await fetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-Paprika-Session": "1" }, signal: AbortSignal.timeout(12_000) })
      if (!logout.ok) throw new Error("Couldn’t finish switching accounts. Please try again.")
      if (!unchanged()) throw cancelled()
    }
    completeSession(data.idToken, { method: "basic", sessionRefreshAvailable: false })
  })
}

/** Test isolation: production callers must use logoutSession instead. */
export function resetBrowserSessionForTests() {
  if (listening) window.removeEventListener("storage", syncSessionFromStorage)
  snapshot = initialSnapshot; hydrated = false; refreshFlight = undefined; configuration = undefined; configurationFlight = undefined; retryAfter = 0; listening = false; memory.clear(); failedWrites.clear(); listeners.clear()
}
