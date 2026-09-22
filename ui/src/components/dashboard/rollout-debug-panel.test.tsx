import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { RolloutDebugPanel } from "@/components/dashboard/rollout-debug-panel"
import {
  GatewayAPIRouterConfig,
  Rollout,
  RolloutABRoute,
  TrafficRouter,
} from "@/gen/paprika/v1/api_pb"

function makeRollout(patch: Partial<Rollout> = {}): Rollout {
  return new Rollout({
    name: "checkout",
    namespace: "apps",
    strategyType: "Canary",
    phase: "Paused",
    paused: true,
    replicas: 4,
    stableReadyReplicas: 4,
    canaryReadyReplicas: 2,
    stableRs: "checkout-66c",
    canaryRs: "checkout-95f",
    currentPodHash: "95f",
    autoPromotionSeconds: 120,
    trafficRouter: new TrafficRouter({
      provider: "gateway-api",
      gatewayApi: new GatewayAPIRouterConfig({
        httpRoute: "checkout-route",
        stableService: "checkout-stable",
        canaryService: "checkout-canary",
      }),
    }),
    abRoutes: [
      new RolloutABRoute({
        type: "Header",
        name: "x-user-ring",
        value: "beta",
        service: "canary",
      }),
    ],
    ...patch,
  })
}

describe("RolloutDebugPanel", () => {
  it("reports replica readiness as one phrase rather than two loose numbers", () => {
    render(<RolloutDebugPanel rollout={makeRollout()} />)

    expect(
      screen.getByText("4 of 4 stable replicas ready"),
    ).toBeInTheDocument()
    expect(
      screen.getByText("2 of 4 canary replicas ready"),
    ).toBeInTheDocument()
  })

  it("names the objects the controller is steering", () => {
    render(<RolloutDebugPanel rollout={makeRollout()} />)

    expect(screen.getByText("checkout-route")).toBeInTheDocument()
    expect(screen.getByText("checkout-stable")).toBeInTheDocument()
    expect(screen.getByText(/x-user-ring/)).toBeInTheDocument()
    expect(screen.getByText("Paused")).toBeInTheDocument()
  })

  it("omits a field the object did not carry instead of showing a zero", () => {
    render(
      <RolloutDebugPanel
        rollout={makeRollout({ autoPromotionSeconds: 0, currentPodHash: "" })}
      />,
    )

    expect(screen.queryByText("Auto promote after")).not.toBeInTheDocument()
    expect(screen.queryByText("0s")).not.toBeInTheDocument()
    expect(screen.queryByText("Scale-down delay")).not.toBeInTheDocument()
  })

  it("says a rollout has no router rather than drawing empty routing rows", () => {
    render(
      <RolloutDebugPanel
        rollout={makeRollout({ trafficRouter: undefined, abRoutes: [] })}
      />,
    )

    expect(
      screen.getByText(/declares no traffic router/i),
    ).toBeInTheDocument()
    expect(screen.queryByText("HTTPRoute")).not.toBeInTheDocument()
  })
})
