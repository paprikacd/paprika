"use client"

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react"
import { safeAuthReturnTo } from "@/lib/auth-return-to"
import {
  bootstrapSession, completeSession, ensureValidSession, getAuthConfiguration,
  getServerSessionSnapshot, getSessionSnapshot, logoutSession, readBrowserStorage,
  readLoginPreference, sessionRefreshDelay, subscribeSession, writeBrowserStorage,
  type AuthUser, type SessionSnapshot,
} from "@/lib/browser-session"

export { AUTH_TOKEN_KEY, AUTH_USER_KEY, type AuthUser } from "@/lib/browser-session"

interface LoginOptions { switchAccount?: boolean; loginHint?: string }
interface AuthContextValue {
  user: AuthUser | null
  idToken: string | null
  isLoading: boolean
  status: SessionSnapshot["status"]
  error: string | null
  login: (options?: LoginOptions) => Promise<void>
  logout: () => Promise<void>
  retry: () => Promise<void>
}
const AuthContext = createContext<AuthContextValue>({
  user: null, idToken: null, isLoading: true, status: "loading", error: null,
  login: async () => {}, logout: async () => {}, retry: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const session = useSyncExternalStore(subscribeSession, getSessionSnapshot, getServerSessionSnapshot)
  useEffect(() => {
    // The callback owns its one-time exchange; do not race it with refresh.
    if (!window.location.pathname.startsWith("/auth/callback")) void bootstrapSession().catch(() => {})
    const reconnect = () => {
      if (document.visibilityState !== "hidden" && !window.location.pathname.startsWith("/auth/callback")) void ensureValidSession({ forceRefresh: getSessionSnapshot().status === "unavailable" }).catch(() => {})
    }
    window.addEventListener("online", reconnect)
    window.addEventListener("focus", reconnect)
    document.addEventListener("visibilitychange", reconnect)
    return () => {
      window.removeEventListener("online", reconnect)
      window.removeEventListener("focus", reconnect)
      document.removeEventListener("visibilitychange", reconnect)
    }
  }, [])

  useEffect(() => {
    if (session.status !== "authenticated" || window.location.pathname.startsWith("/auth/callback")) return
    const timer = setTimeout(() => { void ensureValidSession().catch(() => {}) }, sessionRefreshDelay())
    return () => clearTimeout(timer)
  }, [session.status, session.revision])

  const login = useCallback(async (options?: LoginOptions) => {
    const config = await getAuthConfiguration()
    if (!config.oidc.enabled) throw new Error("Single sign-on is not available on this console.")
    if (options?.switchAccount) {
      const destination = safeAuthReturnTo(readBrowserStorage("paprika_return_to"))
      try { await logoutSession() } finally { writeBrowserStorage("paprika_return_to", destination) }
    }
    const redirectURI = `${window.location.origin}/auth/callback`
    const query = new URLSearchParams({ redirect_uri: redirectURI })
    const hint = options?.loginHint ?? readLoginPreference()?.user.email
    if (hint && !options?.switchAccount) query.set("login_hint", hint)
    if (options?.switchAccount) query.set("switchAccount", "true")
    const res = await fetch(`/auth/login?${query}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(12_000) })
    if (!res.ok) throw new Error("Couldn’t start sign-in. Please try again.")
    const body = await res.json() as { url: string; codeVerifier: string; state: string }
    try {
      sessionStorage.setItem("paprika_code_verifier", body.codeVerifier)
      sessionStorage.setItem("paprika_expected_state", body.state)
      sessionStorage.setItem("paprika_redirect_uri", redirectURI)
      sessionStorage.setItem("paprika_login_provider", config.oidc.provider)
    } catch { throw new Error("Your browser is blocking the temporary storage needed for sign-in. Allow site storage and try again.") }
    const current = window.location.pathname + window.location.search + (window.location.hash ?? "")
    if (!["/login", "/"].includes(window.location.pathname.replace(/\/+$/, "") || "/")) {
      writeBrowserStorage("paprika_return_to", safeAuthReturnTo(current))
    } else if (!safeAuthReturnTo(readBrowserStorage("paprika_return_to"))) {
      writeBrowserStorage("paprika_return_to", null)
    }
    window.location.href = body.url
  }, [])

  const logout = useCallback(async () => {
    try { await logoutSession() } catch { /* The local logout tombstone prevents cookie reuse if offline. */ }
    window.location.href = "/login/"
  }, [])
  const retry = useCallback(async () => { await ensureValidSession({ forceRefresh: true }) }, [])

  return <AuthContext.Provider value={{ user: session.user, idToken: session.idToken, isLoading: session.status === "loading", status: session.status, error: session.error, login, logout, retry }}>{children}</AuthContext.Provider>
}

export function useAuth() { return useContext(AuthContext) }

/** Compatibility entry point for the console's existing token consumers. */
export function persistAuth(idToken: string, options?: Parameters<typeof completeSession>[1]) {
  return completeSession(idToken, options)
}

export function consumeReturnTo(): string | null {
  const path = readBrowserStorage("paprika_return_to")
  writeBrowserStorage("paprika_return_to", null)
  return path
}
