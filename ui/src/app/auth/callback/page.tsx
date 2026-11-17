"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useRef, useState } from "react"
import { EntryFrame, EntryProgress } from "@/components/auth/entry-frame"
import { authReturnDestination } from "@/lib/auth-return-to"
import { consumeReturnTo } from "@/lib/auth-context"
import { exchangeAuthorizationCode } from "@/lib/browser-session"

function CallbackHandler() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const processed = useRef(false)
  useEffect(() => {
    if (processed.current) return
    processed.current = true
    const fail = (message: string) => queueMicrotask(() => setError(message))
    const code = searchParams.get("code")
    const state = searchParams.get("state")
    if (!code || !state) { fail(searchParams.get("error") ? "Sign-in was cancelled. You can try again when you’re ready." : "Missing authorization code or state"); return }
    let expectedState, codeVerifier, redirectUri, provider: "google" | "oidc"
    try {
      expectedState = sessionStorage.getItem("paprika_expected_state")
      codeVerifier = sessionStorage.getItem("paprika_code_verifier")
      redirectUri = sessionStorage.getItem("paprika_redirect_uri")
      provider = sessionStorage.getItem("paprika_login_provider") === "google" ? "google" : "oidc"
      if (!expectedState || !codeVerifier || !redirectUri) { fail("Login session not found. Please try signing in again."); return }
      if (state !== expectedState) { fail("State mismatch. Please start a new sign-in from this browser."); return }
      for (const key of ["paprika_expected_state", "paprika_code_verifier", "paprika_redirect_uri", "paprika_login_provider"]) sessionStorage.removeItem(key)
    } catch { fail("Your browser is blocking sign-in storage. Allow site storage and try again."); return }
    void exchangeAuthorizationCode({ code, codeVerifier, redirectUri }, provider).then(() => {
      const destination = authReturnDestination(consumeReturnTo())
      if (destination.startsWith("/dashboard/")) router.replace(destination)
      else window.location.href = destination
    }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Couldn’t complete sign-in. Please try again."))
  }, [searchParams, router])
  return <EntryFrame title={error ? "Couldn’t sign you in" : "Welcome to Paprika"}>
    {error ? <div className="space-y-4"><p role="alert" className="text-note leading-relaxed text-status-failed-text">{error}</p><Link href="/login/" className="inline-flex min-h-10 items-center border border-rule px-3 text-console hover:bg-inset focus-visible:outline-2 focus-visible:outline-ring">Back to sign in</Link></div> : <EntryProgress message="Signing you in…" />}
  </EntryFrame>
}

export default function CallbackPage() {
  return <Suspense fallback={<EntryFrame><EntryProgress message="Signing you in…" /></EntryFrame>}><CallbackHandler /></Suspense>
}
