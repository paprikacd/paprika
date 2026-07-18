import { describe, expect, it } from "vitest"

import {
  expectedLiveFilterStableIds,
  fixtureModeFromEnvironment,
} from "../../e2e/helpers/fleet-admin-config"

describe("fleet admin E2E fixture mode", () => {
  it("rejects a local admin-session stub in live mode before the suite can navigate", () => {
    expect(() =>
      fixtureModeFromEnvironment({
        PAPRIKA_E2E_FIXTURE_MODE: "live",
        PAPRIKA_E2E_ADMIN_SESSION_STUB: "1",
      }),
    ).toThrowError(
      "PAPRIKA_E2E_ADMIN_SESSION_STUB=1 is forbidden when PAPRIKA_E2E_FIXTURE_MODE=live",
    )
  })

  it("declares the exact three-application live subset for every selected dimension", () => {
    const namespace = "paprika-fleet-e2e-review123"

    expect(expectedLiveFilterStableIds(namespace, "project")).toEqual([
      `a:${namespace}/billing`,
      `a:${namespace}/ledger`,
      `a:${namespace}/notifications`,
    ])
    expect(expectedLiveFilterStableIds(namespace, "cluster")).toEqual([
      `a:${namespace}/billing`,
      `a:${namespace}/ledger`,
      `a:${namespace}/notifications`,
    ])
    expect(expectedLiveFilterStableIds(namespace, "stage")).toEqual([
      `a:${namespace}/billing`,
      `a:${namespace}/checkout`,
      `a:${namespace}/ledger`,
    ])
  })
})
