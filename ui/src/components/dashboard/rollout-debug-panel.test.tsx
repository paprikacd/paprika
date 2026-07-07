import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import {
  GatewayAPIRouterConfig,
  Rollout,
  RolloutABRoute,
  RolloutAnalysisCheck,
  RolloutStep,
  TrafficRouter,
} from "@/gen/paprika/v1/api_pb"
import { RolloutDebugPanel } from "@/components/dashboard/rollout-debug-panel"

function makeRollout(): Rollout {
  return new Rollout({
    name: "checkout",
    namespace: "apps",
    strategyType: "Canary",
    currentStep: 1,
    currentWeight: 50,
    replicas: 4,
    stableReadyReplicas: 4,
    canaryReadyReplicas: 2,
    paused: true,
    abort: true,
    currentPodHash: "95f",
    previousActiveRs: "checkout-66c",
    trafficRouter: new TrafficRouter({
      provider: "gateway-api",
      gatewayApi: new GatewayAPIRouterConfig({
        httpRoute: "checkout-route",
        stableService: "checkout-stable",
        canaryService: "checkout-canary",
      }),
    }),
    canarySteps: [
      new RolloutStep({ setWeight: 10, duration: "2m0s" }),
      new RolloutStep({ setWeight: 50 }),
    ],
    analysisChecks: [
      new RolloutAnalysisCheck({
        type: "http",
        url: "https://checkout.example.com/health",
        successThreshold: "99%",
      }),
    ],
    abRoutes: [
      new RolloutABRoute({
        type: "Header",
        name: "x-user-ring",
        value: "beta",
        service: "canary",
      }),
    ],
    mirrorPercent: 15,
    autoPromotionSeconds: 120,
    scaleDownDelaySeconds: 60,
  })
}

describe("RolloutDebugPanel", () => {
  it("renders strategy, traffic, analysis, and replica debugging state", () => {
    render(<RolloutDebugPanel rollout={makeRollout()} />)

    expect(screen.getByText("Strategy Plan")).toBeInTheDocument()
    expect(screen.getByText("10%")).toBeInTheDocument()
    expect(screen.getByText("50%")).toBeInTheDocument()
    expect(screen.getByText("2m0s")).toBeInTheDocument()
    expect(screen.getByText("gateway-api")).toBeInTheDocument()
    expect(screen.getByText("checkout-route")).toBeInTheDocument()
    expect(screen.getByText("http")).toBeInTheDocument()
    expect(screen.getByText("99%")).toBeInTheDocument()
    expect(screen.getByText("x-user-ring")).toBeInTheDocument()
    expect(screen.getByText("15%")).toBeInTheDocument()
    expect(screen.getByText("4 / 4")).toBeInTheDocument()
    expect(screen.getByText("2 / 4")).toBeInTheDocument()
    expect(screen.getByText("Paused")).toBeInTheDocument()
    expect(screen.getByText("Aborted")).toBeInTheDocument()
    expect(screen.getByText("checkout-66c")).toBeInTheDocument()
  })
})
