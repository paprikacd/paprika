/**
 * Parsing and redirect helpers for the MCP consent page.
 *
 * Kept free of React so the query-string contract — what the server sends,
 * what we send back — can be unit tested without rendering anything.
 */

export interface ConsentRequest {
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  state: string
  /**
   * Scopes the client asked for, from the `scope` query param. Never used to
   * pre-select anything write-capable — it only drives what we *show* the
   * human was asked for. Defaults to read-only when the param is absent.
   */
  requestedScopes: string[]
}

export type ConsentRequestResult =
  | { ok: true; value: ConsentRequest }
  | { ok: false; missing: string[] }

export const SCOPE_READ = "paprika:read"
export const SCOPE_WRITE = "paprika:write"

function scopesFromParam(scopeParam: string): string[] {
  const requested = scopeParam
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return requested.length > 0 ? requested : [SCOPE_READ]
}

/**
 * Shape of a successful GET /mcp/authorize/pending?rid=... response — see
 * pendingAuthzResponse in internal/api/mcp/oauth.go, which this must match
 * field for field.
 *
 * Fix round 2, Finding 1: /mcp/authorize's redirect to the consent page now
 * only ever carries an opaque `rid`, identical in shape whether the
 * original request was valid, had an unregistered client_id, or an
 * unregistered redirect_uri — collapsing what used to be a distinguishable
 * 302 shape (an enumeration oracle any unauthenticated caller could probe
 * directly with curl) into one. This endpoint — gated by the same
 * authenticator as the rest of the authenticated MCP surface, checked
 * before the rid is ever looked up — is now the only way to learn what a
 * given rid actually refers to.
 */
export interface PendingAuthzResponse {
  client_id: string
  redirect_uri: string
  code_challenge: string
  code_challenge_method: string
  state: string
  scope?: string
}

function toConsentRequest(body: PendingAuthzResponse): ConsentRequest {
  return {
    clientId: body.client_id,
    redirectUri: body.redirect_uri,
    codeChallenge: body.code_challenge,
    codeChallengeMethod: body.code_challenge_method,
    state: body.state,
    requestedScopes: scopesFromParam(body.scope ?? ""),
  }
}

/**
 * Resolves `rid` (the only thing the consent page's URL carries now) to the
 * actual authorization request via the authenticated GET
 * /mcp/authorize/pending endpoint.
 *
 * Every failure mode — no rid, a network error, a non-2xx response (unknown,
 * expired, or genuinely invalid rid; or the caller isn't authenticated), or
 * a malformed/incomplete body — collapses to the same `{ ok: false }` shape
 * the page already knows how to render as "Can't show this request". None of
 * these are actionable any differently by the human at the keyboard, and
 * the security property here lives entirely server-side (see oauth.go's
 * redirectToConsent / handleAuthorizePending) — this function's job is only
 * to turn "resolved" into the shape the rest of the page already expects,
 * not to make any security decision of its own.
 */
export async function fetchPendingAuthz(
  rid: string,
  idToken: string
): Promise<ConsentRequestResult> {
  if (!rid) return { ok: false, missing: ["rid"] }

  let res: Response
  try {
    res = await fetch(`/mcp/authorize/pending?rid=${encodeURIComponent(rid)}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    })
  } catch {
    return { ok: false, missing: ["rid"] }
  }
  if (!res.ok) return { ok: false, missing: ["rid"] }

  let body: PendingAuthzResponse
  try {
    body = (await res.json()) as PendingAuthzResponse
  } catch {
    return { ok: false, missing: ["rid"] }
  }
  if (
    !body ||
    !body.client_id ||
    !body.redirect_uri ||
    !body.code_challenge ||
    !body.code_challenge_method
  ) {
    return { ok: false, missing: ["rid"] }
  }

  return { ok: true, value: toConsentRequest(body) }
}

/**
 * Schemes buildDenyRedirect will ever navigate to. `https:` always; `http:`
 * only for loopback, matching how a local dev OAuth client is registered.
 * Deliberately excludes `javascript:`, `data:`, and everything else a
 * malicious `redirect_uri` could carry.
 */
const ALLOWED_DENY_SCHEMES = new Set(["https:"])
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function isAllowedDenyTarget(url: URL): boolean {
  if (ALLOWED_DENY_SCHEMES.has(url.protocol)) return true
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
}

/**
 * Builds the deny redirect: the original `redirect_uri`, used verbatim (past
 * an allowlist check), with `error=access_denied` and the original `state`
 * appended.
 *
 * DEFENCE IN DEPTH ONLY — as of Fix round 1, Finding 1a, the consent page
 * no longer calls this to build a navigation target itself; Deny is routed
 * through POST /mcp/authorize/consent with decision="deny", and the browser
 * navigates only to the server-validated `redirectTo` that endpoint
 * returns. This function is kept (and tested) purely as a second layer: it
 * must never be able to produce a `javascript:`, `data:`, or other
 * non-allowlisted navigable string, even if some future caller passes it
 * unvalidated input directly.
 *
 * Unlike the pre-fix version, there is NO fallback branch that raw-
 * concatenates onto a string that failed to parse as a URL — that branch
 * was the sink a crafted `redirect_uri` (e.g. a `javascript:` URI, whose
 * trailing `//` comments out the appended query) exploited to execute
 * script on this origin when assigned to `location.href`. A `redirect_uri`
 * that fails to parse, or whose scheme is not allowlisted, is rejected
 * outright: null is returned instead of any string derived from it.
 */
export function buildDenyRedirect(
  redirectUri: string,
  state: string
): string | null {
  let url: URL
  try {
    url = new URL(redirectUri)
  } catch {
    return null
  }
  if (!isAllowedDenyTarget(url)) return null
  url.searchParams.set("error", "access_denied")
  if (state) url.searchParams.set("state", state)
  return url.toString()
}
