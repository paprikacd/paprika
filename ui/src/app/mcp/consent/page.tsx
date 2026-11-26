"use client"

import { Check } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { Suspense, useEffect, useRef, useState } from "react"

import { EntryFrame, EntryIdentity, EntryProgress } from "@/components/auth/entry-frame"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useAuth } from "@/lib/auth-context"
import { getAuthConfiguration, readLoginPreference } from "@/lib/browser-session"
import { redirectToLogin, sessionFetch } from "@/lib/session-request"
import { useHydrated } from "@/lib/use-hydrated"

import { AuthorizationApproved } from "./authorization-approved"
import {
  fetchPendingAuthz,
  SCOPE_WRITE,
  type ConsentRequestResult,
} from "./consent-request"

const CONNECT_DESCRIPTION = "An application is asking to connect to Paprika."

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

function CantShowRequest({ detail }: { detail: string }) {
  return (
    <EntryFrame title="Can't show this request" description={CONNECT_DESCRIPTION} phase="invalid">
      <div className="space-y-3">
        <p role="alert" className="border border-status-failed-line bg-status-failed-fill px-3 py-3 text-note leading-relaxed text-status-failed-text">
          {detail}
        </p>
        <p className="text-note text-muted-foreground">
          Start the connection again from your application. It will open a fresh request here.
        </p>
      </div>
    </EntryFrame>
  )
}

/**
 * Sign-in for a connection goes straight to the identity provider when that
 * is how this browser last signed in, so approving a client costs one trip.
 * Anything else (password accounts, a console without single sign-on, or a
 * failure to start) hands over to the login page, which explains and retries
 * and then returns here through the same return-to mechanism.
 */
async function startSignIn(login: () => Promise<void>) {
  try {
    const preference = readLoginPreference()
    const config = await getAuthConfiguration()
    if (config.oidc.enabled && (!preference || preference.method === "oidc")) {
      await login()
      return
    }
  } catch { /* The login page owns explaining and retrying a failed start. */ }
  redirectToLogin()
}

function ConsentHandler() {
  const searchParams = useSearchParams()
  const { user, status, login, retry } = useAuth()
  const hydrated = useHydrated()

  const loginTriggered = useRef(false)
  const submittingRef = useRef(false)

  const [grantWrite, setGrantWrite] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [pending, setPending] = useState<ConsentRequestResult | null>(null)
  const [attempt, setAttempt] = useState(0)
  const fetchedAttempt = useRef(-1)
  const [retrying, setRetrying] = useState(false)
  const [approved, setApproved] = useState<{
    redirectTo: string
    writeGranted: boolean
  } | null>(null)

  // /mcp/authorize redirects here with only an opaque `rid` — never the
  // client_id/redirect_uri/etc themselves — so this is the only thing read
  // from the URL directly.
  const rid = searchParams.get("rid") ?? ""
  const ridMissing = rid === ""

  // Not signed in: sign in and come straight back. The query string (just
  // `?rid=...`) rides along via the normal return-to mechanism. A request
  // with no rid can never succeed, so nobody is bounced through login for it.
  useEffect(() => {
    if (ridMissing || status !== "anonymous" || loginTriggered.current) return
    loginTriggered.current = true
    void startSignIn(login)
  }, [status, ridMissing, login])

  // Resolve the rid only once the session is confirmed. A cached profile can
  // be on screen before its ID token is renewed; asking with that stale token
  // would turn a routine renewal into "can't show this request".
  useEffect(() => {
    if (ridMissing || status !== "authenticated" || fetchedAttempt.current === attempt) return
    fetchedAttempt.current = attempt
    void fetchPendingAuthz(rid, sessionFetch).then(setPending)
  }, [ridMissing, status, rid, attempt])

  async function retryRequest() {
    setRetrying(true)
    try {
      if (status === "unavailable") await retry()
      setPending(null)
      setAttempt((value) => value + 1)
    } catch { /* The connection message stays up with its retry. */ } finally { setRetrying(false) }
  }

  if (ridMissing) {
    return <CantShowRequest detail="The link is missing its request reference (rid)." />
  }

  const preference = hydrated ? readLoginPreference() : null
  const cachedIdentity = user ?? preference?.user ?? null

  if (status === "unavailable" || (pending && !pending.ok && pending.reason === "unavailable")) {
    return (
      <EntryFrame title="Connection interrupted" description={CONNECT_DESCRIPTION} phase="unavailable">
        <div className="space-y-4">
          <p role="alert" className="border border-status-failed-line bg-status-failed-fill px-3 py-3 text-note text-status-failed-text">
            We couldn’t reach Paprika to load this request. Your application is still waiting, so you can retry now.
          </p>
          <Button type="button" className="w-full" onClick={() => void retryRequest()} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        </div>
      </EntryFrame>
    )
  }

  if (status === "anonymous" || (pending && !pending.ok && pending.reason === "signin")) {
    const name = preference?.user.name || preference?.user.email
    return (
      <EntryFrame title="Sign in to connect" description={CONNECT_DESCRIPTION} phase="signin">
        <EntryProgress
          message={name ? `Signing in as ${name}…` : "Taking you to sign in…"}
          detail="You’ll come straight back here to review the request."
          identity={preference?.user}
        />
      </EntryFrame>
    )
  }

  if (status === "loading" || pending === null) {
    const confirmed = status === "authenticated"
    return (
      <EntryFrame title="Authorise access to your fleet" description={CONNECT_DESCRIPTION} phase="loading">
        <EntryProgress
          message={confirmed ? "Loading the request…" : "Confirming your session…"}
          identity={cachedIdentity}
          steps={[
            { label: confirmed ? "Session confirmed" : "Confirming your session", state: confirmed ? "done" : "active" },
            { label: "Loading the request", state: confirmed ? "active" : "pending" },
            { label: "Review and approve", state: "pending" },
          ]}
        />
      </EntryFrame>
    )
  }

  if (!pending.ok || !user) {
    return <CantShowRequest detail="This request has expired or was already used." />
  }

  const {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    state,
    requestedScopes,
  } = pending.value
  // requestedScopes is a ceiling, never a floor. `null` means the client
  // sent no `scope` param at all — real clients have been observed doing
  // this — so there is no ceiling to respect and we offer the server's full
  // supported set, write included as an opt-in default-off tick. When a
  // scope WAS requested, we never offer more than it named: e.g.
  // `scope=paprika:read` must suppress the write control entirely, even
  // though the client could ask for write next time.
  const writeOffered =
    requestedScopes === null || requestedScopes.includes(SCOPE_WRITE)

  // Allow and Deny both round-trip to the server. Approval presents a
  // handoff screen; Deny returns directly. Both navigate only to the exact
  // `redirectTo` the server returns. This is deliberate — the UI
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
      const res = await sessionFetch("/mcp/authorize/consent", {
        method: "POST",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
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

      const redirectTo = (data as { redirectTo?: unknown }).redirectTo
      if (typeof redirectTo !== "string" || !redirectTo) {
        throw new Error("The server did not return a redirect target")
      }

      if (decision === "approve") {
        setApproved({ redirectTo, writeGranted: scopes.includes(SCOPE_WRITE) })
      } else {
        window.location.href = redirectTo
      }
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

  const account = user.email || user.name

  if (approved) {
    return (
      <EntryFrame title="You’re connected" description={`${clientId} can now reach Paprika as ${account}.`} phase="approved">
        <AuthorizationApproved
          account={account}
          instance={window.location.host ?? ""}
          writeGranted={approved.writeGranted}
          onContinue={() => {
            // Preserve the exact validated callback, including the OAuth
            // state and PKCE-bound code. Never put it in storage or markup.
            window.location.href = approved.redirectTo
          }}
        />
      </EntryFrame>
    )
  }

  return (
    <EntryFrame
      title="Authorise access to your fleet"
      description={<><span className="font-medium text-foreground">{clientId}</span> is asking to connect to Paprika as <span className="font-medium text-foreground">{account}</span>.</>}
      phase="review"
    >
      <div className="space-y-5">
        <EntryIdentity user={user} meta="Signed in" />

        <div className="space-y-2 border border-rule-soft p-3">
          <InfoRow label="Application" value={clientId} />
          <InfoRow label="Will redirect to" value={redirectUri} />
        </div>

        <div className="space-y-3">
          <p className="font-mono text-kicker text-muted-foreground">Permissions</p>

          {/*
            Granted outright, not a choice, so it is rendered as a plain grant
            — a check glyph plus a "Granted" label — with nothing that looks
            clickable. A disabled checkbox here read as inert chrome, and a
            real user reported the page as offering no scope choices at all.
          */}
          <div className="flex items-start gap-2.5 border border-rule-soft bg-inset p-3">
            <Check
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-entry-accent"
            />
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">Read fleet data</p>
                <Badge variant="outline">paprika:read</Badge>
                <span className="text-xs font-medium text-entry-accent">
                  Granted
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                View applications, clusters, pipelines, rollouts and
                releases.
              </p>
            </div>
          </div>

          {writeOffered && (
            <div className="space-y-2 border border-rule-soft p-3">
              <label className="flex cursor-pointer items-start gap-2.5">
                <Checkbox
                  checked={grantWrite}
                  onCheckedChange={(checked) => setGrantWrite(checked === true)}
                  className="mt-0.5"
                />
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
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
                <p className="bg-warning/10 px-2.5 py-2 text-xs text-warning animate-in fade-in duration-200">
                  This lets {clientId} sync applications, approve or reject
                  deployment gates, roll back releases, and control
                  pipelines and rollouts — promoting, aborting, cancelling,
                  holding, resuming, retrying or skipping steps — on your
                  behalf.
                </p>
              )}
            </div>
          )}
        </div>

        {submitError && (
          <p role="alert" className="border border-status-failed-line bg-status-failed-fill px-2.5 py-2 text-xs text-status-failed-text">
            {submitError}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={handleDeny} disabled={isSubmitting}>
            Deny
          </Button>
          <Button type="button" onClick={handleApprove} disabled={isSubmitting}>
            {isSubmitting ? "Authorising…" : "Allow access"}
          </Button>
        </div>
      </div>
    </EntryFrame>
  )
}

export default function MCPConsentPage() {
  return (
    <Suspense
      fallback={
        <EntryFrame title="Authorise access to your fleet" description={CONNECT_DESCRIPTION}>
          <EntryProgress message="Confirming your session…" />
        </EntryFrame>
      }
    >
      <ConsentHandler />
    </Suspense>
  )
}
