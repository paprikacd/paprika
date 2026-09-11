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
 * Builds the deny redirect: the original `redirect_uri`, used verbatim, with
 * `error=access_denied` and the original `state` appended. This is the ONLY
 * place a denial is allowed to send the browser — never anything derived or
 * reconstructed from user input.
 */
export function buildDenyRedirect(redirectUri: string, state: string): string {
  try {
    const url = new URL(redirectUri)
    url.searchParams.set("error", "access_denied")
    if (state) url.searchParams.set("state", state)
    return url.toString()
  } catch {
    // redirect_uri didn't parse as an absolute URL — still append verbatim
    // rather than refusing to deny.
    const params = new URLSearchParams({ error: "access_denied" })
    if (state) params.set("state", state)
    const separator = redirectUri.includes("?") ? "&" : "?"
    return `${redirectUri}${separator}${params.toString()}`
  }
}
