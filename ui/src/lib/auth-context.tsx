"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"

export interface AuthUser {
  sub: string
  email: string
  name: string
  picture?: string
}

interface AuthContextValue {
  user: AuthUser | null
  idToken: string | null
  isLoading: boolean
  login: () => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  idToken: null,
  isLoading: true,
  login: async () => {},
  logout: () => {},
})

export const AUTH_TOKEN_KEY = "paprika_id_token"
export const AUTH_USER_KEY = "paprika_auth_user"
const AUTH_RETURN_TO_KEY = "paprika_return_to"

function parseJWT(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const payload = parts[1]
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
    return JSON.parse(json)
  } catch {
    return null
  }
}

function isTokenExpired(token: string): boolean {
  const payload = parseJWT(token)
  if (!payload || !payload.exp) return true
  return Date.now() >= (payload.exp as number) * 1000
}

function safeRedirect(target: string) {
  const current = window.location.pathname.replace(/\/+$/, "")
  const dest = target.replace(/\/+$/, "")
  if (current === dest) return
  window.location.href = target
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [idToken, setIdToken] = useState<string | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const restored = useRef(false)

  useEffect(() => {
    if (restored.current) return
    restored.current = true

    queueMicrotask(() => {
      const stored = localStorage.getItem(AUTH_TOKEN_KEY)
      const storedUser = localStorage.getItem(AUTH_USER_KEY)

      if (stored && storedUser) {
        if (isTokenExpired(stored)) {
          localStorage.removeItem(AUTH_TOKEN_KEY)
          localStorage.removeItem(AUTH_USER_KEY)
        } else {
          setIdToken(stored)
          try {
            setUser(JSON.parse(storedUser))
          } catch {
            localStorage.removeItem(AUTH_TOKEN_KEY)
            localStorage.removeItem(AUTH_USER_KEY)
          }
        }
      }
      setIsLoading(false)
    })
  }, [])

  const login = useCallback(async () => {
    const redirectURI = `${window.location.origin}/auth/callback`
    try {
      const res = await fetch(`/auth/login?redirect_uri=${encodeURIComponent(redirectURI)}`)
      if (!res.ok) throw new Error("login init failed")
      const body = await res.json()
      const { url, codeVerifier, state } = body as {
        url: string
        codeVerifier: string
        state: string
      }
      sessionStorage.setItem("paprika_code_verifier", codeVerifier)
      sessionStorage.setItem("paprika_expected_state", state)
      sessionStorage.setItem("paprika_redirect_uri", redirectURI)
      localStorage.setItem(AUTH_RETURN_TO_KEY, window.location.pathname)
      window.location.href = url
    } catch (err) {
      console.error("Login failed:", err)
    }
  }, [])

  const logout = useCallback(() => {
    setIdToken(null)
    setUser(null)
    localStorage.removeItem(AUTH_TOKEN_KEY)
    localStorage.removeItem(AUTH_USER_KEY)
    localStorage.removeItem(AUTH_RETURN_TO_KEY)
    safeRedirect("/login/")
  }, [])

  return (
    <AuthContext.Provider value={{ user, idToken, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

export function persistAuth(idToken: string) {
  const payload = parseJWT(idToken)
  if (!payload) return
  const user: AuthUser = {
    sub: (payload.sub as string) || "",
    email: (payload.email as string) || "",
    name: (payload.name as string) || "",
    picture: payload.picture as string | undefined,
  }
  localStorage.setItem(AUTH_TOKEN_KEY, idToken)
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user))
}

export function consumeReturnTo(): string | null {
  const path = localStorage.getItem(AUTH_RETURN_TO_KEY)
  localStorage.removeItem(AUTH_RETURN_TO_KEY)
  return path
}
