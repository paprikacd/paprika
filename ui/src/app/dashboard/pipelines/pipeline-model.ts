import {
  ComputeBasis,
  DataClass,
  DataState,
  type DataSourceStatus,
  type Pipeline,
  type PipelineRunSummary,
  type PipelineRunStep,
  PipelineRunOutcome,
  type StepStatus,
} from "@/gen/paprika/v1/api_pb"
import { indexDataSources, type DataSourceIndex } from "@/lib/data-state"
import type { StatusTone } from "@/lib/status-tone"

/**
 * §4 of the backend design is normative: every derived number travels with a
 * `DataState`, and a state that is not `OK` or `STALE` means the console has
 * no number to draw. This module turns those enums into the three things a
 * surface can actually do — render, grey out with a reason, or not exist —
 * so no view has to re-derive the rule and get it subtly wrong.
 */
export type Availability =
  | { readonly kind: "ok" }
  | { readonly kind: "stale"; readonly observedAtMs: number }
  /** NOT_CONFIGURED. The surface must not appear at all. */
  | { readonly kind: "absent" }
  /** NOT_AVAILABLE / ERROR / FORBIDDEN. Greyed, with the server's reason. */
  | { readonly kind: "unavailable"; readonly reason: string }

/**
 * The server sanitises `unavailable_reason`, but it is allowed to be empty.
 * A surface still has to say something, and "0" is not an option.
 */
export const GENERIC_UNAVAILABLE_REASON = "Not reported by the control plane"

export function availabilityOf(
  state: DataState | undefined,
  options: { reason?: string; observedAtMs?: number } = {},
): Availability {
  switch (state) {
    case DataState.OK:
      return { kind: "ok" }
    case DataState.STALE:
      return { kind: "stale", observedAtMs: options.observedAtMs ?? 0 }
    case DataState.NOT_AVAILABLE:
    case DataState.ERROR:
    case DataState.FORBIDDEN:
      return {
        kind: "unavailable",
        reason: options.reason?.trim() || GENERIC_UNAVAILABLE_REASON,
      }
    default:
      // NOT_CONFIGURED, UNSPECIFIED, and anything a newer server invents.
      // Hiding is the only safe default: an unknown state is not a number.
      return { kind: "absent" }
  }
}

/** True when the surface should be drawn at all (greyed counts as drawn). */
export function isRenderable(availability: Availability): boolean {
  return availability.kind !== "absent"
}

/** True when numerics are populated. Only OK and STALE qualify. */
export function hasNumerics(availability: Availability): boolean {
  return availability.kind === "ok" || availability.kind === "stale"
}

/** The narrower of a data class and one field's own state. */
export function narrowAvailability(
  outer: Availability,
  inner: Availability,
): Availability {
  if (outer.kind === "absent" || inner.kind === "absent") return { kind: "absent" }
  if (outer.kind === "unavailable") return outer
  if (inner.kind === "unavailable") return inner
  if (outer.kind === "stale") return outer
  return inner
}

// The index shape and the probe are console-wide; this route only projects
// them onto its own `Availability` vocabulary.
export { indexDataSources, type DataSourceIndex }

/**
 * Resolves one data class. An index the console never managed to fetch means
 * every class is absent — failing closed, so a broken probe hides boards
 * rather than inventing them.
 */
export function classAvailability(
  index: DataSourceIndex | null,
  dataClass: DataClass,
): Availability {
  const source = index?.get(dataClass)
  if (!source) return { kind: "absent" }
  return availabilityOf(source.state, {
    reason: source.unavailableReason,
    observedAtMs: Number(source.observedAtUnixMs),
  })
}

/* ── Phases ─────────────────────────────────────────────────────────── */

const STEP_TONES: Readonly<Record<string, StatusTone>> = {
  Succeeded: "healthy",
  Running: "progressing",
  Failed: "failed",
  Skipped: "missing",
  Cancelled: "unknown",
  Pending: "pending",
}

const TERMINAL_PHASES: ReadonlySet<string> = new Set([
  "Succeeded",
  "Failed",
  "Skipped",
  "Cancelled",
])

export function phaseTone(phase: string | undefined): StatusTone {
  if (!phase) return "pending"
  return STEP_TONES[phase] ?? "unknown"
}

/** The control plane's own word for the phase, never a tone name. */
export function phaseLabel(phase: string | undefined): string {
  return phase && phase.length > 0 ? phase : "Pending"
}

export function isTerminalPhase(phase: string | undefined): boolean {
  return Boolean(phase && TERMINAL_PHASES.has(phase))
}

/* ── Time ───────────────────────────────────────────────────────────── */

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** `4s`, `1m 06s`, `2h 04m`. Never negative, never scientific. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s"
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m ${pad2(totalSeconds % 60)}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${pad2(minutes % 60)}m`
}

/** Seconds-since-epoch, as the pipeline messages carry them. */
function secondsToMs(value: bigint | undefined): number | null {
  if (value === undefined) return null
  const ms = Number(value) * 1000
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

export function stepElapsedMs(
  status: StepStatus | null | undefined,
  nowMs: number,
): number | null {
  const started = secondsToMs(status?.startedAt)
  if (started === null) return null
  const completed = secondsToMs(status?.completedAt)
  return Math.max(0, (completed ?? nowMs) - started)
}

export function pipelineStartedAtMs(pipeline: Pipeline): number | null {
  const starts = pipeline.stepStatuses
    .map((status) => secondsToMs(status.startedAt))
    .filter((value): value is number => value !== null)
  if (starts.length > 0) return Math.min(...starts)
  return secondsToMs(pipeline.createdAt)
}

export function pipelineElapsedMs(
  pipeline: Pipeline,
  nowMs: number,
): number | null {
  const started = pipelineStartedAtMs(pipeline)
  if (started === null) return null
  if (isTerminalPhase(pipeline.phase)) {
    const ends = pipeline.stepStatuses
      .map((status) => secondsToMs(status.completedAt))
      .filter((value): value is number => value !== null)
    if (ends.length > 0) return Math.max(0, Math.max(...ends) - started)
  }
  return Math.max(0, nowMs - started)
}

export interface StepProgress {
  done: number
  total: number
}

export function stepProgress(pipeline: Pipeline): StepProgress {
  const total = pipeline.steps.length
  const done = pipeline.stepStatuses.filter((status) =>
    isTerminalPhase(status.phase),
  ).length
  return { done: Math.min(done, total), total }
}

/* ── The stats strip ────────────────────────────────────────────────── */

export interface StatCell {
  key: string
  /** Rendered as the cell's kicker, uppercase. */
  label: string
  /** Absent when the cell is greyed: an unavailable class has no number. */
  value?: string
  /** Qualifies the number — the basis of an estimate, the cache scope. */
  note?: string
  tone?: StatusTone
  unavailableReason?: string
  /** Present when the number is stale; the cell wears an age badge. */
  staleObservedAtMs?: number
}

export interface RunContext {
  /** Availability of the PIPELINE_RUNS data class itself. */
  availability: Availability
  run: PipelineRunSummary | null
}

function staleMarker(availability: Availability): number | undefined {
  return availability.kind === "stale" ? availability.observedAtMs : undefined
}

function computeBasisNote(basis: ComputeBasis): string | undefined {
  switch (basis) {
    case ComputeBasis.MEASURED:
      return "measured"
    case ComputeBasis.REQUESTED:
      return "estimate from requests"
    default:
      return undefined
  }
}

/**
 * ELAPSED and STEPS come from `GetPipeline` and are always real. Everything
 * else is a `PIPELINE_RUNS` derivative and only exists when that class says
 * so — a cache-hit rate nothing measures is not rendered as `0%`.
 */
export function pipelineStatCells(input: {
  pipeline: Pipeline
  nowMs: number
  runs: RunContext
}): StatCell[] {
  const { pipeline, nowMs, runs } = input
  const cells: StatCell[] = []

  const elapsed = pipelineElapsedMs(pipeline, nowMs)
  if (elapsed !== null) {
    cells.push({ key: "elapsed", label: "Elapsed", value: formatDuration(elapsed) })
  }

  const progress = stepProgress(pipeline)
  if (progress.total > 0) {
    cells.push({
      key: "steps",
      label: "Steps",
      value: `${progress.done}/${progress.total}`,
    })
  }

  if (runs.availability.kind === "absent") return cells

  if (runs.availability.kind === "unavailable") {
    cells.push({
      key: "runs",
      label: "Run metrics",
      unavailableReason: runs.availability.reason,
    })
    return cells
  }

  const run = runs.run
  if (!run) return cells

  const cache = run.cache
  if (cache) {
    const cacheAvailability = narrowAvailability(
      runs.availability,
      availabilityOf(cache.state, { observedAtMs: staleMarker(runs.availability) }),
    )
    if (cacheAvailability.kind === "unavailable") {
      cells.push({
        key: "cache",
        label: "Cache hit",
        unavailableReason: cacheAvailability.reason,
      })
    } else if (hasNumerics(cacheAvailability)) {
      cells.push({
        key: "cache",
        label: "Cache hit",
        value: `${Math.round(cache.hitRatio * 100)}%`,
        note: cache.scope || undefined,
        staleObservedAtMs: staleMarker(cacheAvailability),
      })
    }
  }

  const tests = run.tests
  if (tests) {
    const testAvailability = narrowAvailability(
      runs.availability,
      availabilityOf(tests.state, { observedAtMs: staleMarker(runs.availability) }),
    )
    if (testAvailability.kind === "unavailable") {
      cells.push({
        key: "tests",
        label: "Tests",
        unavailableReason: testAvailability.reason,
      })
    } else if (hasNumerics(testAvailability)) {
      const notes: string[] = []
      if (tests.failed > 0) notes.push(`${tests.failed} failed`)
      if (tests.flaked > 0) notes.push(`${tests.flaked} flaked`)
      if (tests.skipped > 0) notes.push(`${tests.skipped} skipped`)
      cells.push({
        key: "tests",
        label: "Tests",
        value: `${tests.passed}/${tests.total}`,
        note: notes.join(" · ") || undefined,
        tone:
          tests.failed > 0 ? "failed" : tests.flaked > 0 ? "degraded" : undefined,
        staleObservedAtMs: staleMarker(testAvailability),
      })
    }
  }

  const computeAvailability = narrowAvailability(
    runs.availability,
    availabilityOf(run.computeState, {
      observedAtMs: staleMarker(runs.availability),
    }),
  )
  if (computeAvailability.kind === "unavailable") {
    cells.push({
      key: "cpu",
      label: "CPU-min",
      unavailableReason: computeAvailability.reason,
    })
  } else if (hasNumerics(computeAvailability)) {
    cells.push({
      key: "cpu",
      label: "CPU-min",
      value: run.cpuMinutes.toFixed(1),
      note: computeBasisNote(run.cpuMinutesBasis),
      staleObservedAtMs: staleMarker(computeAvailability),
    })
  }

  return cells
}

/* ── The run sub-line ───────────────────────────────────────────────── */

export interface RunProvenance {
  runNumber?: string
  triggeredBy?: string
  commitShort?: string
  commitMessage?: string
  commitUrl?: string
  startedAgo?: string
}

/**
 * The header sub-line. `started … ago` is real; the run number needs
 * PIPELINE_RUNS and the commit needs COMMIT_METADATA, so each is dropped
 * independently rather than filled with a placeholder.
 */
export function runProvenance(input: {
  pipeline: Pipeline
  nowMs: number
  runs: RunContext
  commit: Availability
}): RunProvenance {
  const provenance: RunProvenance = {}

  const started = pipelineStartedAtMs(input.pipeline)
  if (started !== null) {
    provenance.startedAgo = `${formatDuration(Math.max(0, input.nowMs - started))} ago`
  }

  const run = input.runs.run
  if (!run || !hasNumerics(input.runs.availability)) return provenance

  if (run.runNumber > BigInt(0)) provenance.runNumber = `run #${run.runNumber}`
  if (run.triggeredBy) provenance.triggeredBy = run.triggeredBy

  const commit = run.commit
  if (!commit) return provenance
  const commitAvailability = narrowAvailability(
    input.commit,
    availabilityOf(commit.state),
  )
  if (!hasNumerics(commitAvailability)) return provenance

  const short = commit.shortRevision || commit.revision.slice(0, 7)
  if (short) provenance.commitShort = short
  if (commit.message) provenance.commitMessage = commit.message.split("\n")[0]
  if (commit.url) provenance.commitUrl = commit.url
  if (!provenance.triggeredBy && commit.authorName) {
    provenance.triggeredBy = commit.authorName
  }
  return provenance
}

/* ── Step resources ─────────────────────────────────────────────────── */

function formatMillicores(millicores: number): string | null {
  if (!Number.isFinite(millicores) || millicores <= 0) return null
  return millicores >= 1000
    ? `${(millicores / 1000).toFixed(millicores % 1000 === 0 ? 0 : 1)} CPU`
    : `${Math.round(millicores)}m CPU`
}

function formatBytes(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  const gib = bytes / 1024 ** 3
  if (gib >= 1) return `${gib.toFixed(gib % 1 === 0 ? 0 : 1)} GiB`
  return `${Math.round(bytes / 1024 ** 2)} MiB`
}

/**
 * `4 CPU / 8 GiB`, from the run record. Returns null when PIPELINE_RUNS
 * cannot supply it, so the caller omits the segment instead of writing
 * `0 CPU`.
 */
export function stepResourceLabel(
  step: PipelineRunStep | undefined,
  availability: Availability,
): string | null {
  if (!hasNumerics(availability)) return null
  const resources = step?.resources
  if (!resources) return null
  const cpu =
    formatMillicores(resources.cpuLimitMillicores) ??
    formatMillicores(resources.cpuRequestMillicores)
  const memory =
    formatBytes(resources.memoryLimitBytes) ??
    formatBytes(resources.memoryRequestBytes)
  const parts = [cpu, memory].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(" / ") : null
}

export function runStepByName(
  run: PipelineRunSummary | null,
  name: string,
): PipelineRunStep | undefined {
  return run?.steps.find((step) => step.name === name)
}

/**
 * The step a reader most likely came to look at: whatever is running, else
 * the first failure, else the first step.
 */
export function defaultSelectedStep(pipeline: Pipeline): string | null {
  const phaseOf = (name: string) =>
    pipeline.stepStatuses.find((status) => status.name === name)?.phase ?? ""
  const running = pipeline.steps.find((step) => phaseOf(step.name) === "Running")
  if (running) return running.name
  const failed = pipeline.steps.find((step) => phaseOf(step.name) === "Failed")
  if (failed) return failed.name
  return pipeline.steps[0]?.name ?? null
}

/* ── Run outcomes ───────────────────────────────────────────────────── */

export function runOutcomeTone(outcome: PipelineRunOutcome): StatusTone {
  switch (outcome) {
    case PipelineRunOutcome.SUCCEEDED:
      return "healthy"
    case PipelineRunOutcome.FAILED:
      return "failed"
    case PipelineRunOutcome.CANCELLED:
      return "unknown"
    default:
      return "unknown"
  }
}

export function runOutcomeLabel(outcome: PipelineRunOutcome): string {
  switch (outcome) {
    case PipelineRunOutcome.SUCCEEDED:
      return "Succeeded"
    case PipelineRunOutcome.FAILED:
      return "Failed"
    case PipelineRunOutcome.CANCELLED:
      return "Cancelled"
    default:
      return "Unknown"
  }
}

export function pipelineKey(namespace: string, name: string): string {
  return `${namespace}/${name}`
}

/** The most recent run per pipeline, from one unfiltered history page. */
export function indexLatestRuns(
  runs: readonly PipelineRunSummary[],
): ReadonlyMap<string, PipelineRunSummary> {
  const latest = new Map<string, PipelineRunSummary>()
  for (const run of runs) {
    const pipeline = run.pipeline
    if (!pipeline) continue
    const key = pipelineKey(pipeline.namespace, pipeline.name)
    const current = latest.get(key)
    if (!current || run.runNumber > current.runNumber) latest.set(key, run)
  }
  return latest
}

/** `#418 · Succeeded · 2m 14s`, or null when there is nothing real to say. */
export function lastRunLabel(run: PipelineRunSummary | undefined): string | null {
  if (!run) return null
  const parts: string[] = []
  if (run.runNumber > BigInt(0)) parts.push(`#${run.runNumber}`)
  parts.push(runOutcomeLabel(run.outcome))
  if (run.durationMs > BigInt(0)) parts.push(formatDuration(Number(run.durationMs)))
  return parts.join(" · ")
}
