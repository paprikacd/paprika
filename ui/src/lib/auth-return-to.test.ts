import { describe, expect, it } from "vitest"
import { authReturnDestination, safeAuthReturnTo } from "./auth-return-to"

describe("safe login destinations", () => {
  it.each([
    ["/observe/consent?rid=opaque%2Bvalue", "/observe/consent?rid=opaque%2Bvalue"],
    ["/mcp/consent?rid=fleet", "/mcp/consent/?rid=fleet"],
    ["/dashboard/search?q=a?b=c", "/dashboard/search/?q=a?b=c"],
    ["/dashboard/", "/dashboard/"],
  ])("preserves the appropriate route semantics for %s", (input, expected) => {
    expect(authReturnDestination(input)).toBe(expected)
  })

  it.each([null, "", "https://evil.example", "//evil.example", "/\\evil.example", "/%5cevil.example",
    "/%2fevil.example", "/a/..//evil.example", "/\tevil.example", "/login", "/login/?next=x",
    "/x/../login", "/%6cogin", "/auth/callback?code=x", "/auth/login", "/%ZZ"]) (
    "rejects unsafe or recursive destination %s", (input) => {
      expect(safeAuthReturnTo(input)).toBeNull()
      expect(authReturnDestination(input)).toBe("/dashboard/")
    }
  )
})
