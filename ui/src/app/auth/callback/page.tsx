"use client"

import { useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"
import { persistAuth, consumeReturnTo } from "@/lib/auth-context"

function CallbackHandler() {
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const code = searchParams.get("code")
    const returnedState = searchParams.get("state")

    if (!code || !returnedState) {
      setError("Missing authorization code or state")
      return
    }

    const expectedState = sessionStorage.getItem("paprika_expected_state")
    const codeVerifier = sessionStorage.getItem("paprika_code_verifier")
    const redirectURI = sessionStorage.getItem("paprika_redirect_uri")

    if (!expectedState || !codeVerifier || !redirectURI) {
      setError("Login session not found. Please try signing in again.")
      return
    }

    if (returnedState !== expectedState) {
      setError("State mismatch. This may be a CSRF attack.")
      return
    }

    sessionStorage.removeItem("paprika_expected_state")
    sessionStorage.removeItem("paprika_code_verifier")
    sessionStorage.removeItem("paprika_redirect_uri")

    fetch("/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier, redirectUri: redirectURI }),
    })
      .then((res) => {
        if (!res.ok) throw new Error("token exchange failed")
        return res.json()
      })
      .then((data: { idToken: string }) => {
        persistAuth(data.idToken)
        const returnTo = consumeReturnTo()
        const dest = returnTo && returnTo !== "/login" ? returnTo : "/dashboard"
        window.location.href = dest
      })
      .catch((err: Error) => {
        setError(err.message || "Token exchange failed")
      })
  }, [searchParams])

  if (error) {
    return (
      <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-4 rounded-2xl bg-card p-8 text-center ring-1 ring-foreground/10">
          <h1 className="text-xl font-bold text-destructive text-balance">Authentication failed</h1>
          <p className="text-sm text-muted-foreground text-pretty">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center p-4">
      <p className="text-muted-foreground">Signing you in...</p>
    </div>
  )
}

export default function CallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center">
          <p className="text-muted-foreground">Signing you in...</p>
        </div>
      }
    >
      <CallbackHandler />
    </Suspense>
  )
}
