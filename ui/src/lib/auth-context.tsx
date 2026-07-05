"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

const AUTH_TOKEN_KEY = "paprika_id_token"
const AUTH_USER_KEY = "paprika_auth_user"
const AUTH_RETURN_TO_KEY = "paprika_return_to"

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [idToken, setIdToken] = useState<string | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const restored = useRef(false)

  useEffect(() => {
    if (restored.current) return
    restored.current = true

    const stored = localStorage.getItem(AUTH_TOKEN_KEY)
    const storedUser = localStorage.getItem(AUTH_USER_KEY)
    if (stored && storedUser) {
      const payload = parseJWT(stored)
      if (payload && payload.exp) {
        const expMs = (payload.exp as number) * 1000
        if (Date.now() >= expMs) {
          localStorage.removeItem(AUTH_TOKEN_KEY)
          localStorage.removeItem(AUTH_USER_KEY)
          setIsLoading(false)
          return
        }
      }
      setIdToken(stored)
      setUser(JSON.parse(storedUser))
    }
    setIsLoading(false)
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
      // Save where to return after login
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
    window.location.href = "/login/"
  }, [])

  const value = useMemo(
    () => ({ user, idToken, isLoading, login, logout }),
    [user, idToken, isLoading, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
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
