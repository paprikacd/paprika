"use client"

import { useSearchParams } from "next/navigation"
import { Suspense, useEffect, useRef, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { useAuth } from "@/lib/auth-context"

import { parseConsentRequest, SCOPE_WRITE } from "./consent-request"

// A quiet mark, not a mascot — sized to sit above the fold text, not below a
// hero. The stem is the point; keep it even if the body gets simplified.
const CAPSICUM_ART = String.raw`      \|/
   .-"""""-.
  /  _____  \
 |  /     \  |
 |  \     /  |
  \  '. .'  /
   '.  '  .'
     '---'`

function CapsicumMark() {
  return (
    <pre
      aria-hidden="true"
      className="mx-auto w-fit font-mono text-[8px] leading-[1.15] text-primary/40 select-none"
    >
      {CAPSICUM_ART}
    </pre>
  )
}

function ConsentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center p-4">
      {children}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs break-all text-foreground sm:text-right">
        {value}
      </span>
    </div>
  )
}

function ConsentHandler() {
  const searchParams = useSearchParams()
  const { user, idToken, isLoading, login } = useAuth()

  const loginTriggered = useRef(false)
  const submittingRef = useRef(false)

  const [redirecting, setRedirecting] = useState(false)
  const [grantWrite, setGrantWrite] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const request = parseConsentRequest(searchParams)

  // Not signed in: kick off the existing login flow and come straight back
  // here — the query string (client_id, redirect_uri, ...) rides along via
  // the normal return-to mechanism, so we never invent a second auth path.
  useEffect(() => {
    if (isLoading || !request.ok || user) return
    if (loginTriggered.current) return
    loginTriggered.current = true
    setRedirecting(true)
    void login()
  }, [isLoading, user, request.ok, login])

  if (!request.ok) {
    return (
      <ConsentShell>
        <div className="w-full max-w-sm space-y-4 rounded-2xl bg-card p-8 text-center ring-1 ring-foreground/10">
          <CapsicumMark />
          <h1 className="text-lg font-semibold text-destructive text-balance">
            Can&apos;t show this request
          </h1>
          <p className="text-sm text-pretty text-muted-foreground">
            The link is missing required information (
            {request.missing.join(", ")}). Ask the application to restart the
            authorisation request.
          </p>
        </div>
      </ConsentShell>
    )
  }

  const {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    state,
    requestedScopes,
  } = request.value
  const writeRequested = requestedScopes.includes(SCOPE_WRITE)

  // submitConsent is shared by Allow and Deny: both are server round trips
  // that end with the browser navigating to whatever `redirectTo` the
  // server returns. This is deliberate (Fix round 1, Finding 1a) — the UI
  // must never build a navigation target itself from the raw, unvalidated
  // redirect_uri a client supplied. The server re-validates client_id and
  // redirect_uri for a deny exactly as it does for an approve (see
  // handleAuthorizeConsent) before it ever constructs redirectTo, so the
  // only thing this page ever assigns to location.href is a URL the server
  // itself vouched for.
  async function submitConsent(decision: "approve" | "deny", scopes: string[]) {
    if (submittingRef.current) return
    submittingRef.current = true
    setIsSubmitting(true)
    setSubmitError(null)

    try {
      const res = await fetch("/mcp/authorize/consent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken ?? ""}`,
        },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          state,
          scopes,
          decision,
        }),
      })

      const data = await res.json().catch(() => ({}) as Record<string, unknown>)

      if (!res.ok) {
        const message =
          (data as { error_description?: string; error?: string })
            .error_description ??
          (data as { error?: string }).error ??
          "Authorisation failed"
        throw new Error(message)
      }

      const redirectTo = (data as { redirectTo?: string }).redirectTo
      if (!redirectTo) {
        throw new Error("The server did not return a redirect target")
      }

      window.location.href = redirectTo
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Authorisation failed")
      submittingRef.current = false
      setIsSubmitting(false)
    }
  }

  function handleDeny() {
    void submitConsent("deny", [])
  }

  async function handleApprove() {
    await submitConsent(
      "approve",
      grantWrite ? ["paprika:read", SCOPE_WRITE] : ["paprika:read"]
    )
  }

  if (isLoading) {
    return (
      <ConsentShell>
        <p className="text-sm text-muted-foreground">Checking your session…</p>
      </ConsentShell>
    )
  }

  if (!user) {
    return (
      <ConsentShell>
        <p className="text-sm text-muted-foreground">
          {redirecting
            ? "Redirecting you to sign in…"
            : "Checking your session…"}
        </p>
      </ConsentShell>
    )
  }

  return (
    <ConsentShell>
      <div className="w-full max-w-md space-y-5 rounded-2xl border border-border/50 bg-card p-8 shadow-lg">
        <div className="space-y-3 text-center">
          <CapsicumMark />
          <h1 className="text-lg font-semibold tracking-tight text-balance">
            Authorise access to your fleet
          </h1>
          <p className="text-sm text-pretty text-muted-foreground">
            <span className="font-medium text-foreground">{clientId}</span> is
            asking to connect to Paprika as{" "}
            <span className="font-medium text-foreground">
              {user.email || user.name}
            </span>
            .
          </p>
        </div>

        <div className="space-y-2 rounded-lg bg-muted/50 p-3">
          <InfoRow label="Application" value={clientId} />
          <InfoRow label="Will redirect to" value={redirectUri} />
        </div>

        <Separator />

        <div className="space-y-3">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Permissions
          </p>

          <div className="flex items-start gap-2.5 rounded-lg border border-border/60 p-3">
            <Checkbox
              checked
              disabled
              aria-label="Read fleet data — always granted"
              className="mt-0.5"
            />
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">Read fleet data</p>
                <Badge variant="outline">paprika:read</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                View applications, clusters, pipelines, rollouts and
                releases.
              </p>
            </div>
          </div>

          {writeRequested && (
            <div className="space-y-2 rounded-lg border border-border/60 p-3">
              <label className="flex items-start gap-2.5">
                <Checkbox
                  checked={grantWrite}
                  onCheckedChange={(checked) => setGrantWrite(checked === true)}
                  className="mt-0.5"
                />
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">
                      Make changes to the fleet
                    </p>
                    <Badge variant="outline">paprika:write</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Requested by {clientId}. Off by default — you decide.
                  </p>
                </div>
              </label>

              {grantWrite && (
                <p className="rounded-md bg-warning/10 px-2.5 py-2 text-xs text-warning">
                  This lets {clientId} sync applications, approve or reject
                  deployment gates, promote and deploy releases, and control
                  pipelines and rollouts — rolling back, aborting,
                  cancelling, holding, resuming, retrying or skipping steps
                  — on your behalf.
                </p>
              )}
            </div>
          )}
        </div>

        {submitError && (
          <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
            {submitError}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={handleDeny}>
            Deny
          </Button>
          <Button type="button" onClick={handleApprove} disabled={isSubmitting}>
            {isSubmitting ? "Authorising…" : "Allow access"}
          </Button>
        </div>
      </div>
    </ConsentShell>
  )
}

export default function MCPConsentPage() {
  return (
    <Suspense
      fallback={
        <ConsentShell>
          <p className="text-muted-foreground">Loading…</p>
        </ConsentShell>
      }
    >
      <ConsentHandler />
    </Suspense>
  )
}
