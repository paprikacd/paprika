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
  it("appends error=access_denied and the original state to an https redirect_uri verbatim", () => {
    const url = buildDenyRedirect("https://claude.ai/callback?foo=bar", "xyz")
    expect(url).not.toBeNull()
    const parsed = new URL(url as string)

    expect(parsed.origin + parsed.pathname).toBe("https://claude.ai/callback")
    expect(parsed.searchParams.get("foo")).toBe("bar")
    expect(parsed.searchParams.get("error")).toBe("access_denied")
    expect(parsed.searchParams.get("state")).toBe("xyz")
  })

  it("omits state when it is empty", () => {
    const url = buildDenyRedirect("https://claude.ai/callback", "")
    expect(url).not.toBeNull()
    const parsed = new URL(url as string)
    expect(parsed.searchParams.has("state")).toBe(false)
  })

  it("allows http on loopback for local dev", () => {
    expect(buildDenyRedirect("http://localhost:3000/callback", "s")).not.toBeNull()
    expect(buildDenyRedirect("http://127.0.0.1:3000/callback", "s")).not.toBeNull()
  })

  // Fix round 1, Finding 1(c) / CRITICAL: a crafted redirect_uri using a
  // dangerous scheme must never produce a navigable string. Before this
  // fix, buildDenyRedirect("javascript:fetch(1)//", "s") returned
  // "javascript:fetch(1)//?error=access_denied&state=s" — the trailing "//"
  // comments out the appended query, and assigning that to location.href
  // from same-origin script executes it, stealing whatever the console
  // origin holds in localStorage. Each case here must return null: no
  // string derived from the dangerous input is ever produced.
  it("never produces a navigable string for a javascript: scheme", () => {
    const url = buildDenyRedirect("javascript:fetch(1)//", "s")
    expect(url).toBeNull()
  })

  it("never produces a navigable string for a data: scheme", () => {
    const url = buildDenyRedirect("data:text/html,<script>alert(1)</script>", "s")
    expect(url).toBeNull()
  })

  it("never produces a navigable string for a protocol-relative URL", () => {
    // new URL("//evil.example", undefined) throws in a module with no
    // document base URI, so this exercises the "didn't parse" branch too —
    // either way, no fallback may raw-concatenate onto it.
    const url = buildDenyRedirect("//evil.example", "s")
    expect(url).toBeNull()
  })

  it("never produces a navigable string for an http scheme on a non-loopback host", () => {
    const url = buildDenyRedirect("http://evil.example/callback", "s")
    expect(url).toBeNull()
  })

  it("rejects a redirect_uri that isn't a valid absolute URL, rather than raw-concatenating", () => {
    const url = buildDenyRedirect("not-a-url", "xyz")
    expect(url).toBeNull()
  })
})
