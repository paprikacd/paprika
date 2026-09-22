import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  DataState,
  ListRolloutHistoryResponse,
  Rollout,
  RolloutOutcome,
} from "@/gen/paprika/v1/api_pb"

import {
  InFlightRollouts,
  MAX_IN_FLIGHT_ROWS,
  RecentRollouts,
  isInFlight,
} from "./rollouts-board"

function rollout(name: string, overrides: Partial<Rollout> = {}) {
  return new Rollout({
    name,
    namespace: "payments",
    strategyType: "canary",
    phase: "Progressing",
    currentStep: 2,
    currentWeight: 25,
    replicas: 4,
    canaryReadyReplicas: 1,
    canarySteps: [
      { setWeight: 5 },
      { setWeight: 10 },
      { setWeight: 25 },
      { setWeight: 50 },
    ],
    ...overrides,
  })
}

describe("isInFlight", () => {
  it("counts only rollouts the controller is still acting on", () => {
    expect(isInFlight(rollout("a"))).toBe(true)
    expect(isInFlight(rollout("b", { phase: "Paused" }))).toBe(true)
    expect(isInFlight(rollout("c", { phase: "Healthy" }))).toBe(false)
  })
})

describe("InFlightRollouts", () => {
  it("reads the ladder, the step and the weight off the rollout itself", () => {
    render(<InFlightRollouts rollouts={[rollout("checkout-api")]} />)

    expect(screen.getByText("STEP 3 / 4 · PROGRESSING")).toBeDefined()
    expect(screen.getByText("25%")).toBeDefined()
    expect(screen.getByText("1 of 4 canary pods ready")).toBeDefined()
  })

  it("stays bounded when a fleet-wide promotion is under way", () => {
    const many = Array.from({ length: 40 }, (_value, index) =>
      rollout(`app-${index}`)
    )
    render(<InFlightRollouts rollouts={many} />)

    expect(screen.getAllByText(/^STEP 3 \/ 4/)).toHaveLength(MAX_IN_FLIGHT_ROWS)
    expect(screen.getByText("Showing 6 of 40 in flight.")).toBeDefined()
    expect(
      screen.getByRole("link", { name: "Open all rollouts →" })
    ).toBeDefined()
  })

  it("says the fleet is quiet rather than drawing an empty ladder", () => {
    render(<InFlightRollouts rollouts={[]} />)
    expect(screen.getByText("No rollouts in flight.")).toBeDefined()
  })
})

describe("RecentRollouts", () => {
  const history = new ListRolloutHistoryResponse({
    state: DataState.OK,
    entries: [
      {
        identity: { namespace: "payments", name: "h-1" },
        application: { namespace: "payments", name: "notifications" },
        release: { namespace: "payments", name: "r142" },
        outcome: RolloutOutcome.ABORTED,
        stepsCompleted: 2,
        stepsTotal: 6,
        durationMs: BigInt(7 * 60_000),
        finishedAtUnixMs: BigInt(Date.UTC(2026, 0, 2, 7, 0, 0)),
        message: "error rate above threshold at 10%",
      },
    ],
    stats: {
      state: DataState.OK,
      total: BigInt(11),
      succeeded: BigInt(9),
      aborted: BigInt(2),
      medianDurationMs: BigInt(22 * 60_000),
      sampleSize: BigInt(11),
    },
  })

  it("shows the recorded outcome, duration and age", () => {
    render(
      <RecentRollouts history={history} now={Date.UTC(2026, 0, 2, 12, 0, 0)} />
    )

    const row = screen.getByRole("row", { name: /notifications/ })
    expect(within(row).getByText("Aborted")).toBeDefined()
    expect(within(row).getByText("7m")).toBeDefined()
    expect(within(row).getByText("5h")).toBeDefined()
    expect(
      within(row).getByText("2 of 6 steps completed")
    ).toBeDefined()
  })

  it("reports the aggregate with its sample size, never as a lifetime figure", () => {
    render(
      <RecentRollouts history={history} now={Date.UTC(2026, 0, 2, 12, 0, 0)} />
    )
    expect(screen.getByText(/11 sampled/)).toBeDefined()
  })

  it("withholds the aggregate when the recorder cannot compute one", () => {
    const withoutStats = new ListRolloutHistoryResponse({
      ...history,
      stats: { state: DataState.NOT_AVAILABLE },
    })
    render(
      <RecentRollouts
        history={withoutStats}
        now={Date.UTC(2026, 0, 2, 12, 0, 0)}
      />
    )
    expect(screen.queryByText(/median/)).toBeNull()
    expect(
      screen.getByText("Rollout statistics are not available from this server.")
    ).toBeDefined()
  })
})
