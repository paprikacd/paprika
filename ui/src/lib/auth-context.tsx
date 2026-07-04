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
import { useRouter } from "next/navigation"

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [idToken, setIdToken] = useState<string | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const router = useRouter()
  const restored = useRef(false)

  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const stored = sessionStorage.getItem(AUTH_TOKEN_KEY)
    const storedUser = sessionStorage.getItem(AUTH_USER_KEY)
    if (stored && storedUser) {
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
      const { url, code_verifier, state } = body as {
        url: string
        code_verifier: string
        state: string
      }
      sessionStorage.setItem("paprika_code_verifier", code_verifier)
      sessionStorage.setItem("paprika_expected_state", state)
      sessionStorage.setItem("paprika_redirect_uri", redirectURI)
      window.location.href = url
    } catch (err) {
      console.error("Login failed:", err)
    }
  }, [])

  const logout = useCallback(() => {
    setIdToken(null)
    setUser(null)
    sessionStorage.removeItem(AUTH_TOKEN_KEY)
    sessionStorage.removeItem(AUTH_USER_KEY)
    router.push("/")
  }, [router])

  const value = useMemo(
    () => ({ user, idToken, isLoading, login, logout }),
    [user, idToken, isLoading, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}

// Call this from the callback page after a successful token exchange.
export function persistAuth(idToken: string) {
  const payload = parseJWT(idToken)
  if (!payload) return
  const user: AuthUser = {
    sub: (payload.sub as string) || "",
    email: (payload.email as string) || "",
    name: (payload.name as string) || "",
    picture: payload.picture as string | undefined,
  }
  sessionStorage.setItem(AUTH_TOKEN_KEY, idToken)
  sessionStorage.setItem(AUTH_USER_KEY, JSON.stringify(user))
}
