import { describe, expect, it } from "vitest"

import {
  buildDenyRedirect,
  parseConsentRequest,
} from "../consent-request"

function params(entries: Record<string, string>) {
  return new URLSearchParams(entries)
}

describe("parseConsentRequest", () => {
  it("parses a well-formed request and defaults to read-only when scope is absent", () => {
    const result = parseConsentRequest(
      params({
        client_id: "claude-desktop",
        redirect_uri: "https://claude.ai/callback",
        code_challenge: "abc123",
        code_challenge_method: "S256",
        state: "xyz",
      })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok result")
    expect(result.value).toEqual({
      clientId: "claude-desktop",
      redirectUri: "https://claude.ai/callback",
      codeChallenge: "abc123",
      codeChallengeMethod: "S256",
      state: "xyz",
      requestedScopes: ["paprika:read"],
    })
  })

  it("splits a space-delimited scope param", () => {
    const result = parseConsentRequest(
      params({
        client_id: "claude-desktop",
        redirect_uri: "https://claude.ai/callback",
        code_challenge: "abc123",
        code_challenge_method: "S256",
        state: "xyz",
        scope: "paprika:read paprika:write",
      })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok result")
    expect(result.value.requestedScopes).toEqual([
      "paprika:read",
      "paprika:write",
    ])
  })

  it("reports every missing required param", () => {
    const result = parseConsentRequest(params({ client_id: "claude-desktop" }))

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure result")
    expect(result.missing).toEqual([
      "redirect_uri",
      "code_challenge",
      "code_challenge_method",
      "state",
    ])
  })

  it("treats an empty-string param as missing", () => {
    const result = parseConsentRequest(
      params({
        client_id: "",
        redirect_uri: "https://claude.ai/callback",
        code_challenge: "abc123",
        code_challenge_method: "S256",
        state: "xyz",
      })
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure result")
    expect(result.missing).toEqual(["client_id"])
  })
})

describe("buildDenyRedirect", () => {
  it("appends error=access_denied and the original state to the redirect_uri verbatim", () => {
    const url = buildDenyRedirect("https://claude.ai/callback?foo=bar", "xyz")
    const parsed = new URL(url)

    expect(parsed.origin + parsed.pathname).toBe("https://claude.ai/callback")
    expect(parsed.searchParams.get("foo")).toBe("bar")
    expect(parsed.searchParams.get("error")).toBe("access_denied")
    expect(parsed.searchParams.get("state")).toBe("xyz")
  })

  it("falls back to string concatenation for a redirect_uri that isn't a valid absolute URL", () => {
    const url = buildDenyRedirect("not-a-url", "xyz")
    expect(url).toBe("not-a-url?error=access_denied&state=xyz")
  })

  it("omits state when it is empty", () => {
    const url = buildDenyRedirect("https://claude.ai/callback", "")
    const parsed = new URL(url)
    expect(parsed.searchParams.has("state")).toBe(false)
  })
})
