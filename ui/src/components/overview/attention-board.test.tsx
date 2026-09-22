import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  ApplicationSummary,
  FleetCapability,
  FleetConnectionState,
  FleetHealth,
  FleetRolloutState,
  FleetSyncState,
} from "@/gen/paprika/v1/api_pb"
import { DEFAULT_FLEET_QUERY } from "@/lib/fleet-query"

import {
  AttentionBoard,
  attentionAction,
  attentionReason,
} from "./attention-board"

function application(
  overrides: Partial<ConstructorParameters<typeof ApplicationSummary>[0]> = {}
) {
  return new ApplicationSummary({
    identity: { namespace: "payments", name: "checkout-api" },
    project: { namespace: "payments", name: "core" },
    health: FleetHealth.HEALTHY,
    sync: FleetSyncState.SYNCED,
    repositoryConnection: FleetConnectionState.HEALTHY,
    rolloutState: FleetRolloutState.HEALTHY,
    resourceCount: 12,
    lastTransitionUnixMs: BigInt(0),
    ...overrides,
  })
}

describe("attentionReason", () => {
  it("names a failing workload", () => {
    expect(attentionReason(application({ health: FleetHealth.FAILED }))).toBe(
      "Workload failing"
    )
  })

  it("counts the resources a missing application has lost", () => {
    expect(
      attentionReason(
        application({ health: FleetHealth.MISSING, missingResourceCount: 3 })
      )
    ).toBe("3 resources missing from the cluster")
  })

  it("leads with an unreachable source, because nothing downstream is trustworthy", () => {
    expect(
      attentionReason(
        application({
          repositoryConnection: FleetConnectionState.UNHEALTHY,
          health: FleetHealth.DEGRADED,
        })
      )
    ).toBe("Source unreachable — last good sync retained · Health checks failing")
  })

  it("counts drifted fields rather than describing them", () => {
    expect(
      attentionReason(
        application({ sync: FleetSyncState.OUT_OF_SYNC, driftCount: 3 })
      )
    ).toBe("3 fields drifted from the rendered manifest")
  })

  it("says why a healthy application is ranked instead of inventing a fault", () => {
    expect(attentionReason(application())).toBe(
      "Ranked by blast radius · 12 resources managed"
    )
  })
})

describe("attentionAction", () => {
  it("offers Approve only when the caller actually holds the capability", () => {
    const blocked = application({ blockedGateCount: 1 })
    expect(attentionAction(blocked, DEFAULT_FLEET_QUERY).label).toBe("View")

    const permitted = application({
      blockedGateCount: 1,
      capabilities: [FleetCapability.GATE_APPROVE],
    })
    expect(attentionAction(permitted, DEFAULT_FLEET_QUERY).label).toBe("Approve")
  })

  it("sends an unreachable source to its repository", () => {
    const action = attentionAction(
      application({
        repositoryConnection: FleetConnectionState.UNHEALTHY,
        repository: { namespace: "payments", name: "checkout" },
      }),
      DEFAULT_FLEET_QUERY
    )
    expect(action.label).toBe("Fix source")
    expect(action.href).toContain("/dashboard/repositories/")
  })
})

describe("AttentionBoard", () => {
  it("shows the server's ranking and how much of it is behind the board", () => {
    render(
      <AttentionBoard
        applications={[
          application({ health: FleetHealth.FAILED }),
          application({
            identity: { namespace: "platform", name: "notifications" },
            health: FleetHealth.DEGRADED,
          }),
        ]}
        attentionTotal={BigInt(17)}
        hasMore
        now={Date.now()}
        state={DEFAULT_FLEET_QUERY}
      />
    )

    expect(
      screen.getByText("Showing 2 of 17 ranked by blast radius.")
    ).toBeDefined()
    expect(
      screen.getByRole("link", { name: "Open the full queue →" })
    ).toBeDefined()
    expect(
      screen.getByRole("link", { name: "View — checkout-api" })
    ).toBeDefined()
  })

  it("says the queue is empty rather than drawing an empty table", () => {
    render(
      <AttentionBoard
        applications={[]}
        attentionTotal={BigInt(0)}
        hasMore={false}
        now={Date.now()}
        state={DEFAULT_FLEET_QUERY}
      />
    )
    expect(screen.getByText("Nothing in scope needs attention.")).toBeDefined()
  })
})
