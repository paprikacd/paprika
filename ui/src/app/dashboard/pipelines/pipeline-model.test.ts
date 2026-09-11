import { describe, expect, it } from "vitest"

import {
  ComputeBasis,
  DataClass,
  DataSourceStatus,
  DataState,
  Pipeline,
  PipelineCacheSummary,
  PipelineRunStep,
  PipelineRunSummary,
  PipelineTestSummary,
  Step,
  StepResources,
  StepStatus,
  CommitInfo,
} from "@/gen/paprika/v1/api_pb"

import {
  availabilityOf,
  classAvailability,
  defaultSelectedStep,
  formatDuration,
  hasNumerics,
  indexDataSources,
  indexLatestRuns,
  isRenderable,
  lastRunLabel,
  narrowAvailability,
  phaseLabel,
  phaseTone,
  pipelineElapsedMs,
  pipelineStatCells,
  runProvenance,
  stepProgress,
  stepResourceLabel,
} from "./pipeline-model"

const NOW = 1_700_000_000_000

function pipeline(overrides: {
  steps?: string[]
  statuses?: { name: string; phase: string; startedAt?: number; completedAt?: number }[]
  phase?: string
} = {}): Pipeline {
  const names = overrides.steps ?? ["checkout", "build", "unit-test"]
  return new Pipeline({
    name: "checkout-api-build",
    namespace: "payments",
    phase: overrides.phase ?? "Running",
    steps: names.map(
      (name, index) =>
        new Step({
          name,
          image: `ghcr.io/acme/${name}:1`,
          depends: index === 0 ? [] : [names[index - 1]],
        })
    ),
    stepStatuses: (overrides.statuses ?? []).map(
      (status) =>
        new StepStatus({
          name: status.name,
          phase: status.phase,
          startedAt: status.startedAt ? BigInt(status.startedAt) : undefined,
          completedAt: status.completedAt ? BigInt(status.completedAt) : undefined,
        })
    ),
  })
}

function runSummary(overrides: Partial<{
  cacheState: DataState
  testState: DataState
  computeState: DataState
  commitState: DataState
}> = {}): PipelineRunSummary {
  return new PipelineRunSummary({
    runNumber: BigInt(418),
    triggeredBy: "@rmoreau",
    cache: new PipelineCacheSummary({
      state: overrides.cacheState ?? DataState.OK,
      hitRatio: 0.74,
      scope: "manifest-render",
    }),
    tests: new PipelineTestSummary({
      state: overrides.testState ?? DataState.OK,
      total: 214,
      passed: 214,
      flaked: 1,
    }),
    computeState: overrides.computeState ?? DataState.OK,
    cpuMinutes: 9.4,
    cpuMinutesBasis: ComputeBasis.REQUESTED,
    commit: new CommitInfo({
      state: overrides.commitState ?? DataState.OK,
      shortRevision: "9f3a1c2",
      message: "fix idempotent capture",
      authorName: "rmoreau",
    }),
  })
}

describe("availabilityOf", () => {
  it("treats NOT_CONFIGURED as absent so the surface cannot be drawn", () => {
    const availability = availabilityOf(DataState.NOT_CONFIGURED)
    expect(availability.kind).toBe("absent")
    expect(isRenderable(availability)).toBe(false)
    expect(hasNumerics(availability)).toBe(false)
  })

  it("treats an unspecified state as absent rather than as data", () => {
    expect(availabilityOf(DataState.UNSPECIFIED).kind).toBe("absent")
    expect(availabilityOf(undefined).kind).toBe("absent")
  })

  it.each([DataState.NOT_AVAILABLE, DataState.ERROR, DataState.FORBIDDEN])(
    "renders %s greyed with a reason and no numbers",
    (state) => {
      const availability = availabilityOf(state, { reason: "metrics-server absent" })
      expect(availability).toEqual({
        kind: "unavailable",
        reason: "metrics-server absent",
      })
      expect(isRenderable(availability)).toBe(true)
      expect(hasNumerics(availability)).toBe(false)
    }
  )

  it("supplies a generic reason when the server sends none", () => {
    const availability = availabilityOf(DataState.NOT_AVAILABLE, { reason: "  " })
    expect(availability).toMatchObject({ kind: "unavailable" })
    if (availability.kind === "unavailable") {
      expect(availability.reason.length).toBeGreaterThan(0)
    }
  })

  it("is the only non-OK state carrying numbers when STALE", () => {
    expect(hasNumerics(availabilityOf(DataState.STALE, { observedAtMs: NOW }))).toBe(true)
    expect(hasNumerics(availabilityOf(DataState.OK))).toBe(true)
  })
})

describe("classAvailability", () => {
  it("reports every class as absent when the probe never resolved", () => {
    expect(classAvailability(null, DataClass.PIPELINE_RUNS).kind).toBe("absent")
  })

  it("reports a class the probe omitted as absent", () => {
    const index = indexDataSources([
      new DataSourceStatus({ dataClass: DataClass.COST, state: DataState.OK }),
    ])
    expect(classAvailability(index, DataClass.PIPELINE_RUNS).kind).toBe("absent")
  })

  it("carries the server's sanitised reason through", () => {
    const index = indexDataSources([
      new DataSourceStatus({
        dataClass: DataClass.PIPELINE_RUNS,
        state: DataState.FORBIDDEN,
        unavailableReason: "not permitted",
      }),
    ])
    expect(classAvailability(index, DataClass.PIPELINE_RUNS)).toEqual({
      kind: "unavailable",
      reason: "not permitted",
    })
  })
})

describe("narrowAvailability", () => {
  it("lets either side hide the surface", () => {
    expect(
      narrowAvailability({ kind: "ok" }, { kind: "absent" }).kind
    ).toBe("absent")
    expect(
      narrowAvailability({ kind: "absent" }, { kind: "ok" }).kind
    ).toBe("absent")
  })

  it("prefers the outer reason when both are degraded", () => {
    expect(
      narrowAvailability(
        { kind: "unavailable", reason: "class" },
        { kind: "unavailable", reason: "field" }
      )
    ).toEqual({ kind: "unavailable", reason: "class" })
  })
})

describe("formatDuration", () => {
  it.each([
    [4_000, "4s"],
    [48_000, "48s"],
    [66_000, "1m 06s"],
    [134_000, "2m 14s"],
    [3_900_000, "1h 05m"],
    [-1, "0s"],
  ])("formats %i as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })
})

describe("phase resolution", () => {
  it("maps every phase onto a tone without inventing a colour", () => {
    expect(phaseTone("Succeeded")).toBe("healthy")
    expect(phaseTone("Running")).toBe("progressing")
    expect(phaseTone("Failed")).toBe("failed")
    expect(phaseTone("Skipped")).toBe("missing")
    expect(phaseTone("")).toBe("pending")
    expect(phaseTone("SomethingNew")).toBe("unknown")
  })

  it("keeps the control plane's own word as the label", () => {
    expect(phaseLabel("Skipped")).toBe("Skipped")
    expect(phaseLabel("")).toBe("Pending")
  })
})

describe("elapsed and progress", () => {
  it("measures a running pipeline against now", () => {
    const p = pipeline({
      statuses: [{ name: "checkout", phase: "Succeeded", startedAt: NOW / 1000 - 134 }],
    })
    expect(pipelineElapsedMs(p, NOW)).toBe(134_000)
  })

  it("freezes a finished pipeline at its last completion", () => {
    const p = pipeline({
      phase: "Succeeded",
      statuses: [
        { name: "checkout", phase: "Succeeded", startedAt: 1_000, completedAt: 1_004 },
        { name: "build", phase: "Succeeded", startedAt: 1_004, completedAt: 1_052 },
      ],
    })
    expect(pipelineElapsedMs(p, NOW)).toBe(52_000)
  })

  it("returns null rather than zero when no timestamps exist", () => {
    expect(pipelineElapsedMs(pipeline(), NOW)).toBeNull()
  })

  it("counts terminal steps as done", () => {
    const p = pipeline({
      statuses: [
        { name: "checkout", phase: "Succeeded" },
        { name: "build", phase: "Succeeded" },
        { name: "unit-test", phase: "Running" },
      ],
    })
    expect(stepProgress(p)).toEqual({ done: 2, total: 3 })
  })
})

describe("pipelineStatCells", () => {
  const running = pipeline({
    statuses: [
      { name: "checkout", phase: "Succeeded", startedAt: NOW / 1000 - 134 },
      { name: "build", phase: "Succeeded" },
      { name: "unit-test", phase: "Running" },
    ],
  })

  it("always renders the two cells GetPipeline can substantiate", () => {
    const cells = pipelineStatCells({
      pipeline: running,
      nowMs: NOW,
      runs: { availability: { kind: "absent" }, run: null },
    })
    expect(cells.map((cell) => cell.label)).toEqual(["Elapsed", "Steps"])
    expect(cells[0].value).toBe("2m 14s")
    expect(cells[1].value).toBe("2/3")
  })

  it("omits cache hit, tests and CPU-minutes entirely when PIPELINE_RUNS is not configured", () => {
    const cells = pipelineStatCells({
      pipeline: running,
      nowMs: NOW,
      runs: { availability: { kind: "absent" }, run: runSummary() },
    })
    const labels = cells.map((cell) => cell.label)
    expect(labels).not.toContain("Cache hit")
    expect(labels).not.toContain("CPU-min")
    expect(labels).not.toContain("Tests")
    expect(cells.every((cell) => cell.value !== "0%")).toBe(true)
  })

  it("greys one cell with the reason when the class is unavailable", () => {
    const cells = pipelineStatCells({
      pipeline: running,
      nowMs: NOW,
      runs: {
        availability: { kind: "unavailable", reason: "history store unreachable" },
        run: runSummary(),
      },
    })
    const runCell = cells.find((cell) => cell.key === "runs")
    expect(runCell?.unavailableReason).toBe("history store unreachable")
    expect(runCell?.value).toBeUndefined()
  })

  it("renders the run-derived cells when the class and each field are OK", () => {
    const cells = pipelineStatCells({
      pipeline: running,
      nowMs: NOW,
      runs: { availability: { kind: "ok" }, run: runSummary() },
    })
    expect(cells.find((cell) => cell.label === "Cache hit")?.value).toBe("74%")
    expect(cells.find((cell) => cell.label === "Tests")?.value).toBe("214/214")
    expect(cells.find((cell) => cell.label === "CPU-min")?.value).toBe("9.4")
  })

  it("never lets an estimate read as a measurement", () => {
    const cells = pipelineStatCells({
      pipeline: running,
      nowMs: NOW,
      runs: { availability: { kind: "ok" }, run: runSummary() },
    })
    expect(cells.find((cell) => cell.label === "CPU-min")?.note).toMatch(/estimate/)
  })

  it("drops only the field whose own state is not configured", () => {
    const cells = pipelineStatCells({
      pipeline: running,
      nowMs: NOW,
      runs: {
        availability: { kind: "ok" },
        run: runSummary({ cacheState: DataState.NOT_CONFIGURED }),
      },
    })
    const labels = cells.map((cell) => cell.label)
    expect(labels).not.toContain("Cache hit")
    expect(labels).toContain("CPU-min")
  })

  it("greys a field the server reports as unavailable", () => {
    const cells = pipelineStatCells({
      pipeline: running,
      nowMs: NOW,
      runs: {
        availability: { kind: "ok" },
        run: runSummary({ cacheState: DataState.NOT_AVAILABLE }),
      },
    })
    const cache = cells.find((cell) => cell.label === "Cache hit")
    expect(cache?.value).toBeUndefined()
    expect(cache?.unavailableReason).toBeTruthy()
  })

  it("marks stale numbers with the observation time", () => {
    const cells = pipelineStatCells({
      pipeline: running,
      nowMs: NOW,
      runs: {
        availability: { kind: "stale", observedAtMs: NOW - 60_000 },
        run: runSummary(),
      },
    })
    expect(cells.find((cell) => cell.label === "CPU-min")?.staleObservedAtMs).toBe(
      NOW - 60_000
    )
  })
})

describe("runProvenance", () => {
  const running = pipeline({
    statuses: [{ name: "checkout", phase: "Succeeded", startedAt: NOW / 1000 - 134 }],
  })

  it("still says when the run started with no run history at all", () => {
    const provenance = runProvenance({
      pipeline: running,
      nowMs: NOW,
      runs: { availability: { kind: "absent" }, run: null },
      commit: { kind: "absent" },
    })
    expect(provenance.startedAgo).toBe("2m 14s ago")
    expect(provenance.runNumber).toBeUndefined()
    expect(provenance.commitShort).toBeUndefined()
  })

  it("omits the commit when COMMIT_METADATA is not configured but keeps the run number", () => {
    const provenance = runProvenance({
      pipeline: running,
      nowMs: NOW,
      runs: { availability: { kind: "ok" }, run: runSummary() },
      commit: { kind: "absent" },
    })
    expect(provenance.runNumber).toBe("run #418")
    expect(provenance.commitShort).toBeUndefined()
    expect(provenance.commitMessage).toBeUndefined()
  })

  it("renders the commit when both the class and the field are OK", () => {
    const provenance = runProvenance({
      pipeline: running,
      nowMs: NOW,
      runs: { availability: { kind: "ok" }, run: runSummary() },
      commit: { kind: "ok" },
    })
    expect(provenance.commitShort).toBe("9f3a1c2")
    expect(provenance.commitMessage).toBe("fix idempotent capture")
    expect(provenance.triggeredBy).toBe("@rmoreau")
  })
})

describe("stepResourceLabel", () => {
  const step = new PipelineRunStep({
    name: "unit-test",
    resources: new StepResources({
      cpuLimitMillicores: 4000,
      memoryLimitBytes: 8 * 1024 ** 3,
    }),
  })

  it("formats limits when the run record is real", () => {
    expect(stepResourceLabel(step, { kind: "ok" })).toBe("4 CPU / 8 GiB")
  })

  it("returns null rather than 0 CPU when the class cannot supply it", () => {
    expect(stepResourceLabel(step, { kind: "absent" })).toBeNull()
    expect(
      stepResourceLabel(step, { kind: "unavailable", reason: "x" })
    ).toBeNull()
    expect(stepResourceLabel(undefined, { kind: "ok" })).toBeNull()
  })
})

describe("run history indexing", () => {
  it("keeps the highest run number per pipeline", () => {
    const runs = [
      new PipelineRunSummary({
        runNumber: BigInt(1),
        pipeline: { namespace: "payments", name: "build" },
      }),
      new PipelineRunSummary({
        runNumber: BigInt(9),
        pipeline: { namespace: "payments", name: "build" },
      }),
    ]
    expect(indexLatestRuns(runs).get("payments/build")?.runNumber).toBe(BigInt(9))
  })

  it("returns null for a pipeline with no recorded run", () => {
    expect(lastRunLabel(undefined)).toBeNull()
  })
})

describe("defaultSelectedStep", () => {
  it("prefers the running step, then a failure, then the first step", () => {
    expect(
      defaultSelectedStep(
        pipeline({
          statuses: [
            { name: "checkout", phase: "Succeeded" },
            { name: "unit-test", phase: "Running" },
          ],
        })
      )
    ).toBe("unit-test")

    expect(
      defaultSelectedStep(
        pipeline({
          statuses: [
            { name: "checkout", phase: "Succeeded" },
            { name: "build", phase: "Failed" },
          ],
        })
      )
    ).toBe("build")

    expect(defaultSelectedStep(pipeline())).toBe("checkout")
  })
})
