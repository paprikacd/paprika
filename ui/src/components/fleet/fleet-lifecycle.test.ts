import { describe, expect, it } from "vitest"

import {
  applicationLifecycle,
  lifecycleCellLabel,
  lifecyclePhaseTone,
} from "@/components/fleet/fleet-lifecycle"
import type { FleetApplicationSummary } from "@/lib/fleet-client"

function summary(lifecycle?: unknown): FleetApplicationSummary {
  return {
    targets: [],
    ...(lifecycle === undefined ? {} : { lifecycle }),
  } as unknown as FleetApplicationSummary
}

describe("applicationLifecycle", () => {
  it("reads a complete six-phase vector", () => {
    const vector = applicationLifecycle(
      summary({
        states: ["succeeded", "succeeded", "failed", "pending", "pending", "pending"],
        observedAtUnixMs: BigInt(1_725_000_000_000),
      }),
    )

    expect(vector?.states).toHaveLength(6)
    expect(vector?.states[2]).toBe("failed")
    expect(vector?.observedAtUnixMs).toBe(BigInt(1_725_000_000_000))
  })

  it("refuses a short vector rather than padding it out", () => {
    expect(applicationLifecycle(summary({ states: ["succeeded"] }))).toBeUndefined()
  })

  it("refuses a vector carrying a state it does not recognise", () => {
    expect(
      applicationLifecycle(
        summary({
          states: ["succeeded", "succeeded", "sideways", "pending", "pending", "pending"],
        }),
      ),
    ).toBeUndefined()
  })

  it("returns nothing for a row the wire never carried a vector for", () => {
    expect(applicationLifecycle(summary())).toBeUndefined()
    expect(applicationLifecycle(summary(null))).toBeUndefined()
  })
})

describe("lifecyclePhaseTone", () => {
  it("keeps an inapplicable phase inert rather than failed", () => {
    expect(lifecyclePhaseTone("not_applicable")).toBe("pending")
    expect(lifecyclePhaseTone("unknown")).toBe("unknown")
    expect(lifecyclePhaseTone("blocked")).toBe("degraded")
    expect(lifecyclePhaseTone("failed")).toBe("failed")
  })

  it("names the phase and its state together", () => {
    expect(lifecycleCellLabel("test", "failed")).toBe("test · Failed")
    expect(lifecycleCellLabel("build", "not_applicable")).toBe("build · Not applicable")
  })
})
