import { describe, expect, it } from "vitest"

import {
  AnalysisRun,
  AnalysisRunResult,
  Condition,
  DataClass,
  DataSourceStatus,
  DataState,
  Rollout,
  RolloutAnalysisCheck,
  RolloutStep,
} from "@/gen/paprika/v1/api_pb"

import {
  activeStepNumber,
  analysisColumns,
  analysisResultsFromConditions,
  buildAnalysisRows,
  buildRolloutLog,
  buildTrafficLadder,
  buildTrafficSplit,
  conditionTone,
  dispositionFor,
  findDataSource,
  gateFor,
  nextStepWeight,
  parseAnalysisObservation,
  selectAnalysisRun,
} from "./rollout-model"

function canaryRollout(patch: Partial<Rollout> = {}): Rollout {
  return new Rollout({
    name: "checkout-api",
    namespace: "payments",
    strategyType: "Canary",
    phase: "Paused",
    currentStep: 2,
    currentWeight: 25,
    stableRs: "checkout-api-6b9c",
    canaryRs: "checkout-api-7d4f",
    stableReadyReplicas: 6,
    canaryReadyReplicas: 2,
    canarySteps: [
      new RolloutStep({ setWeight: 5, duration: "2m0s" }),
      new RolloutStep({ setWeight: 10, duration: "2m0s" }),
      new RolloutStep({ setWeight: 25 }),
      new RolloutStep({ setWeight: 50 }),
    ],
    ...patch,
  })
}

describe("dispositionFor", () => {
  it("hides an unconfigured or forbidden class and greys an unavailable one", () => {
    expect(dispositionFor(DataState.NOT_CONFIGURED)).toBe("absent")
    expect(dispositionFor(DataState.FORBIDDEN)).toBe("absent")
    expect(dispositionFor(DataState.UNSPECIFIED)).toBe("absent")
    expect(dispositionFor(DataState.NOT_AVAILABLE)).toBe("unavailable")
    expect(dispositionFor(DataState.ERROR)).toBe("unavailable")
    expect(dispositionFor(DataState.STALE)).toBe("stale")
    expect(dispositionFor(DataState.OK)).toBe("render")
  })
})

describe("gateFor", () => {
  const probe = new DataSourceStatus({
    dataClass: DataClass.ROLLOUT_HISTORY,
    state: DataState.OK,
    unavailableReason: "",
    observedAtUnixMs: BigInt(1_000),
  })

  it("takes the more restrictive of the probe and the response", () => {
    expect(gateFor(probe, DataState.NOT_CONFIGURED).disposition).toBe("absent")
    expect(
      gateFor(
        new DataSourceStatus({ ...probe, state: DataState.NOT_CONFIGURED }),
        DataState.OK,
      ).disposition,
    ).toBe("absent")
    expect(gateFor(probe, DataState.STALE).disposition).toBe("stale")
  })

  it("refuses to render a class it was told nothing about", () => {
    expect(gateFor(undefined).disposition).toBe("absent")
  })

  it("carries the server's reason rather than inventing one", () => {
    const unavailable = new DataSourceStatus({
      dataClass: DataClass.ROLLOUT_HISTORY,
      state: DataState.NOT_AVAILABLE,
      unavailableReason: "rollout history recording is not configured",
    })
    expect(gateFor(unavailable).reason).toBe(
      "rollout history recording is not configured",
    )
  })

  it("finds a class by its enum value", () => {
    expect(
      findDataSource([probe], DataClass.ROLLOUT_HISTORY)?.state,
    ).toBe(DataState.OK)
    expect(findDataSource([probe], DataClass.COST)).toBeUndefined()
  })
})

describe("buildTrafficLadder", () => {
  it("draws one bar per declared step and nothing more", () => {
    const ladder = buildTrafficLadder(canaryRollout())
    expect(ladder.map((step) => step.weight)).toEqual([5, 10, 25, 50])
  })

  it("marks steps before the current index done and those after queued", () => {
    const ladder = buildTrafficLadder(canaryRollout())
    expect(ladder.map((step) => step.state)).toEqual([
      "done",
      "done",
      "active",
      "queued",
    ])
    expect(ladder[0].tone).toBe("healthy")
    expect(ladder[3].tone).toBe("pending")
  })

  it("marks the step in flight degraded when it is blocked, not merely resting", () => {
    expect(buildTrafficLadder(canaryRollout())[2].tone).toBe("degraded")
    expect(
      buildTrafficLadder(canaryRollout({ phase: "Progressing", paused: false }))[2]
        .tone,
    ).toBe("progressing")
    expect(
      buildTrafficLadder(canaryRollout({ abort: true }))[2].tone,
    ).toBe("failed")
  })

  it("says the active step is held when the rollout is paused", () => {
    expect(buildTrafficLadder(canaryRollout())[2].note).toBe("held")
    expect(
      buildTrafficLadder(
        canaryRollout({ phase: "Progressing", paused: false }),
      )[2].note,
    ).toBe("manual gate")
  })

  it("encodes weight in the bar height, monotonically", () => {
    const ladder = buildTrafficLadder(canaryRollout())
    const heights = ladder.map((step) => step.barPercent)
    expect(heights).toEqual([...heights].sort((a, b) => a - b))
    expect(heights[heights.length - 1]).toBeLessThanOrEqual(100)
  })

  it("has no ladder at all without declared steps", () => {
    expect(buildTrafficLadder(new Rollout({ name: "web" }))).toEqual([])
  })

  it("numbers the step in flight from one, and none once every step has run", () => {
    expect(activeStepNumber(canaryRollout())).toBe(3)
    expect(activeStepNumber(canaryRollout({ currentStep: 4 }))).toBe(0)
    expect(nextStepWeight(canaryRollout())).toBe(50)
    expect(nextStepWeight(canaryRollout({ currentStep: 3 }))).toBeUndefined()
  })
})

describe("buildTrafficSplit", () => {
  it("splits the declared weight between stable and canary", () => {
    const split = buildTrafficSplit(canaryRollout())
    expect(split).toMatchObject({
      canaryPercent: 25,
      stablePercent: 75,
      stableReadyReplicas: 6,
      canaryReadyReplicas: 2,
    })
  })

  it("returns nothing for a rollout with no weighted steps", () => {
    expect(buildTrafficSplit(new Rollout({ name: "web" }))).toBeNull()
  })
})

describe("buildRolloutLog", () => {
  it("orders newest first and keeps undated entries behind dated ones", () => {
    const log = buildRolloutLog([
      new Condition({
        type: "Progressing",
        status: "True",
        lastTransitionTime: "2026-09-10T09:30:00Z",
        message: "Weight advanced 5% to 10%",
      }),
      new Condition({
        type: "Available",
        status: "False",
        reason: "AnalysisFailed",
        lastTransitionTime: "2026-09-10T09:41:00Z",
        message: "p99 581 ms above 500 ms threshold",
      }),
      new Condition({ type: "Synced", status: "True" }),
    ])
    expect(log.map((entry) => entry.type)).toEqual([
      "Available",
      "Progressing",
      "Synced",
    ])
  })

  it("falls back to the reason, then to the type, when there is no message", () => {
    const log = buildRolloutLog([
      new Condition({ type: "Ready", status: "Unknown" }),
    ])
    expect(log[0].text).toBe("Ready is Unknown")
  })

  it("reads a failure out of the reason, not out of the status alone", () => {
    expect(
      conditionTone(
        new Condition({
          type: "Progressing",
          status: "False",
          reason: "AnalysisFailed",
        }),
      ),
    ).toBe("failed")
    expect(
      conditionTone(new Condition({ type: "Progressing", status: "True" })),
    ).toBe("progressing")
    expect(
      conditionTone(new Condition({ type: "Available", status: "True" })),
    ).toBe("healthy")
  })
})

describe("parseAnalysisObservation", () => {
  it("reads the observed value out of the http check sentence", () => {
    expect(
      parseAnalysisObservation(
        "HTTP check: 48/50 succeeded (96%, threshold 99%)",
      ),
    ).toEqual({ canary: "96%" })
  })

  it("reads the observed value out of a rate sentence", () => {
    expect(
      parseAnalysisObservation("error rate: 0.04 (threshold 0.02)"),
    ).toEqual({ canary: "0.04" })
  })

  it("never reports a threshold as an observation", () => {
    const observation = parseAnalysisObservation("threshold: 0.5")
    expect(observation.canary).toBeUndefined()
    expect(observation.baseline).toBeUndefined()
  })

  it("takes a baseline only when the text names one", () => {
    expect(
      parseAnalysisObservation("p99=581ms", "baseline=412ms"),
    ).toEqual({ canary: "581ms", baseline: "412ms" })
    expect(
      parseAnalysisObservation("p99 latency is high").baseline,
    ).toBeUndefined()
  })

  it("returns nothing at all for prose with no measurement in it", () => {
    expect(
      parseAnalysisObservation("no metrics server available, assuming pass"),
    ).toEqual({})
  })
})

describe("buildAnalysisRows", () => {
  const checks = [
    new RolloutAnalysisCheck({
      type: "pod-metric",
      metric: "error-rate",
      threshold: "0.02",
    }),
    new RolloutAnalysisCheck({
      type: "http",
      url: "https://checkout/health",
      successThreshold: "99%",
    }),
  ]

  it("keeps the declared threshold and the observed result on the same row", () => {
    const rows = buildAnalysisRows(checks, [
      new AnalysisRunResult({
        name: "error-rate",
        passed: false,
        message: "error rate: 0.04 (threshold 0.02)",
      }),
    ])
    expect(rows[0]).toMatchObject({
      name: "error-rate",
      threshold: "0.02",
      canary: "0.04",
      result: "Fail",
      tone: "failed",
    })
  })

  it("marks a check with no observation pending rather than passing", () => {
    const rows = buildAnalysisRows(checks, [])
    expect(rows.every((row) => row.result === "Pending")).toBe(true)
    expect(rows.every((row) => row.canary === undefined)).toBe(true)
  })

  it("keeps a reported result that matches no declared check", () => {
    const rows = buildAnalysisRows(checks, [
      new AnalysisRunResult({ name: "restart-rate", passed: true }),
    ])
    expect(rows.map((row) => row.name)).toContain("restart-rate")
  })

  it("drops a column no row could fill", () => {
    const rows = buildAnalysisRows(checks, [
      new AnalysisRunResult({
        name: "error-rate",
        passed: true,
        message: "error rate: 0.01 (threshold 0.02)",
      }),
    ])
    expect(analysisColumns(rows)).toEqual({
      baseline: false,
      canary: true,
      threshold: true,
    })
  })
})

describe("analysisResultsFromConditions", () => {
  it("lifts an analysis outcome the controller recorded on a condition", () => {
    const results = analysisResultsFromConditions([
      new Condition({
        type: "Progressing",
        status: "False",
        reason: "AnalysisFailed",
        message: "error rate: 0.04 (threshold 0.02)",
      }),
      new Condition({ type: "Ready", status: "True", reason: "PodsReady" }),
    ])
    expect(results).toHaveLength(1)
    expect(results[0].passed).toBe(false)
  })
})

describe("selectAnalysisRun", () => {
  it("matches a run by the rollout's own name or its target's", () => {
    const runs = [
      new AnalysisRun({ applicationRef: "unrelated", startedAt: BigInt(9) }),
      new AnalysisRun({ applicationRef: "checkout-api", startedAt: BigInt(1) }),
      new AnalysisRun({ applicationRef: "checkout-api", startedAt: BigInt(5) }),
    ]
    expect(selectAnalysisRun(runs, canaryRollout())?.startedAt).toBe(BigInt(5))
  })

  it("returns nothing rather than the nearest run when nothing matches", () => {
    expect(
      selectAnalysisRun(
        [new AnalysisRun({ applicationRef: "other" })],
        canaryRollout(),
      ),
    ).toBeUndefined()
  })
})
