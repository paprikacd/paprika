"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useRef, useState } from "react"
import { EntryFrame, EntryProgress, type EntryStep } from "@/components/auth/entry-frame"
import { authReturnDestination, isConnectionReturn, readAuthReturnTo } from "@/lib/auth-return-to"
import { consumeReturnTo } from "@/lib/auth-context"
import { exchangeAuthorizationCode, getSessionSnapshot, type AuthUser } from "@/lib/browser-session"

type Phase = "securing" | "opening"

function providerName(provider: string | null) {
  return provider === "google" ? "Google" : "single sign-on"
}

function CallbackHandler() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>("securing")
  const [signedIn, setSignedIn] = useState<AuthUser | null>(null)
  // Read once, in the effect, before the one-time keys are cleared: the first
  // render must match the static frame, which knows neither.
  const [context, setContext] = useState<{ provider: string | null; connecting: boolean }>({ provider: null, connecting: false })
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
      const connecting = isConnectionReturn(readAuthReturnTo())
      queueMicrotask(() => setContext({ provider, connecting }))
      if (!expectedState || !codeVerifier || !redirectUri) { fail("Login session not found. Please try signing in again."); return }
      if (state !== expectedState) { fail("State mismatch. Please start a new sign-in from this browser."); return }
      for (const key of ["paprika_expected_state", "paprika_code_verifier", "paprika_redirect_uri", "paprika_login_provider"]) sessionStorage.removeItem(key)
    } catch { fail("Your browser is blocking sign-in storage. Allow site storage and try again."); return }
    void exchangeAuthorizationCode({ code, codeVerifier, redirectUri }, provider).then(() => {
      setSignedIn(getSessionSnapshot().user)
      setPhase("opening")
      const destination = authReturnDestination(consumeReturnTo())
      if (destination.startsWith("/dashboard/")) router.replace(destination)
      else window.location.href = destination
    }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Couldn’t complete sign-in. Please try again."))
  }, [searchParams, router])

  if (error) {
    return <EntryFrame title="Couldn’t sign you in" phase="error">
      <div className="space-y-4"><p role="alert" className="text-note leading-relaxed text-status-failed-text">{error}</p><Link href="/login/" className="inline-flex min-h-10 items-center border border-rule px-3 text-console hover:bg-inset focus-visible:outline-2 focus-visible:outline-ring">Back to sign in</Link></div>
    </EntryFrame>
  }
  // Each step is real work: the provider has already answered, the session
  // exchange is in flight, then the destination loads.
  const destination = context.connecting ? "Returning to your connection request" : "Opening your workspace"
  const steps: EntryStep[] = [
    { label: `Verified with ${providerName(context.provider)}`, state: "done" },
    { label: "Securing your session", state: phase === "securing" ? "active" : "done" },
    { label: destination, state: phase === "opening" ? "active" : "pending" },
  ]
  const name = signedIn?.name?.split(/\s+/)[0] || signedIn?.email
  return <EntryFrame title={name ? `Welcome, ${name}` : "Signing you in"}>
    <EntryProgress message={phase === "securing" ? "Securing your session…" : `${destination}…`} identity={signedIn} steps={steps} />
  </EntryFrame>
}

export default function CallbackPage() {
  return <Suspense fallback={<EntryFrame title="Signing you in"><EntryProgress message="Securing your session…" /></EntryFrame>}><CallbackHandler /></Suspense>
}
