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

/** The five params the server always attaches; `scope` is optional. */
const REQUIRED_PARAMS = [
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
] as const

export const SCOPE_READ = "paprika:read"
export const SCOPE_WRITE = "paprika:write"

export function parseConsentRequest(
  searchParams: URLSearchParams
): ConsentRequestResult {
  const missing = REQUIRED_PARAMS.filter((key) => !searchParams.get(key))
  if (missing.length > 0) {
    return { ok: false, missing }
  }

  const scopeParam = searchParams.get("scope") ?? ""
  const requested = scopeParam
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    ok: true,
    value: {
      clientId: searchParams.get("client_id")!,
      redirectUri: searchParams.get("redirect_uri")!,
      codeChallenge: searchParams.get("code_challenge")!,
      codeChallengeMethod: searchParams.get("code_challenge_method")!,
      state: searchParams.get("state")!,
      requestedScopes: requested.length > 0 ? requested : [SCOPE_READ],
    },
  }
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
