import type { Page, Request, Response } from "@playwright/test"
import { describe, expect, it, vi } from "vitest"

// Importing Playwright's runtime from Vitest starts its runner-side lifecycle,
// which is unrelated to this pure response-capture regression. Keep the type
// contracts while replacing the only runtime export used by the helper.
vi.mock("@playwright/test", () => ({ expect: vi.fn() }))

import { FleetMapOracle, QUERY_FLEET_MAP_PATH } from "../../e2e/helpers/fleet-map-oracle"

class FakePage {
  private listener: ((response: Response) => void) | undefined

  on(_event: "response", listener: (response: Response) => void) {
    this.listener = listener
  }

  off(_event: "response", listener: (response: Response) => void) {
    if (this.listener === listener) this.listener = undefined
  }

  emit(response: Response) {
    this.listener?.(response)
  }
}

function response(body: Promise<unknown>): Response {
  return {
    url: () => `http://127.0.0.1:3100${QUERY_FLEET_MAP_PATH}`,
    ok: () => true,
    json: () => body,
    request: () => ({ postDataJSON: () => ({ group: "namespace" }) }) as Request,
  } as Response
}

describe("FleetMapOracle", () => {
  it("drains a delayed malformed successful response before stop resolves", async () => {
    const page = new FakePage()
    const oracle = new FleetMapOracle(page as unknown as Page)
    let releaseMalformed: ((value: unknown) => void) | undefined

    page.emit(response(Promise.resolve({
      total: "1",
      roots: [{
        kind: "FLEET_MAP_NODE_KIND_APPLICATION",
        stableId: "application:team-00/checkout-service",
      }],
    })))
    page.emit(response(new Promise((resolve) => {
      releaseMalformed = resolve
    })))

    const stopped = oracle.stop()
    let resolved = false
    void Promise.resolve(stopped).then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    releaseMalformed!({
      total: "1",
      roots: [{ kind: "FLEET_MAP_NODE_KIND_APPLICATION" }],
    })
    await stopped

    expect(oracle.captures).toHaveLength(1)
    expect(oracle.captureErrors).toEqual(["Application leaf 0 omitted stableId"])
  })
})
