import {
  AnalysisRunResult,
  DataState,
  FleetRolloutState,
  RolloutOutcome,
  type AnalysisRun,
  type Condition,
  type DataClass,
  type DataSourceStatus,
  type Rollout,
  type RolloutAnalysisCheck,
} from "@/gen/paprika/v1/api_pb"
import { rolloutTone, type StatusTone } from "@/lib/status-tone"

/**
 * Everything the rollout views derive from the wire lives here, as plain
 * functions over generated messages. The rule the whole file exists to keep is
 * that a number reaches the screen only when the API actually supplied it —
 * `undefined` means "the API did not say", and the view omits the cell rather
 * than drawing a zero, a dash or a guess.
 */

/* ── Degraded-mode gating ─────────────────────────────────────────────── */

/**
 * The §4 contract is console-wide and lives in `@/lib/data-state`. These
 * re-exports keep the rollout call sites reading locally while there is only
 * ever one implementation of the gate.
 */
export {
  dispositionFor,
  findDataSource,
  gateFor,
  type SurfaceDisposition,
  type SurfaceGate,
} from "@/lib/data-state"

/* ── Phase ────────────────────────────────────────────────────────────── */

/**
 * `Rollout.phase` is the free-form CRD phase string. Mapping it onto
 * `FleetRolloutState` means the detail view resolves its tone through the same
 * `rolloutTone` the fleet list uses, so one rollout cannot read as two states
 * in two places.
 */
export function rolloutPhaseState(rollout: Rollout): FleetRolloutState {
  if (rollout.abort) return FleetRolloutState.ABORTED
  switch (rollout.phase) {
    case "Healthy":
      return FleetRolloutState.HEALTHY
    case "Progressing":
      return FleetRolloutState.PROGRESSING
    case "Paused":
      return FleetRolloutState.PAUSED
    case "Degraded":
      return FleetRolloutState.DEGRADED
    case "Failed":
      return FleetRolloutState.FAILED
    case "Aborted":
      return FleetRolloutState.ABORTED
    case "RolledBack":
      return FleetRolloutState.ROLLED_BACK
    case "Pending":
      return FleetRolloutState.PENDING
    default:
      return rollout.paused
        ? FleetRolloutState.PAUSED
        : FleetRolloutState.UNSPECIFIED
  }
}

export function rolloutPhaseTone(rollout: Rollout): StatusTone {
  return rolloutTone(rolloutPhaseState(rollout))
}

/* ── Traffic ladder ───────────────────────────────────────────────────── */

export type LadderStepState = "done" | "active" | "queued"

export interface LadderStep {
  /** 1-based position, as the design labels it. */
  n: number
  weight: number
  duration: string
  state: LadderStepState
  tone: StatusTone
  note: string
  /** Bar height as a percentage of the rail. Encodes `weight`, nothing else. */
  barPercent: number
}

/**
 * The shortest bar still has to be a bar. A 5% step drawn at 5% of the rail is
 * a line, so the ramp starts at a floor and spends the remaining travel on the
 * weight. The number itself is printed beside every bar, so the floor
 * exaggerates nothing a reader cannot check.
 */
const BAR_FLOOR_PERCENT = 22

/**
 * `Rollout.currentStep` is the controller's `CurrentStepIndex`: the 0-based
 * index of the step being executed, equal to `canarySteps.length` once every
 * step has run.
 */
export function buildTrafficLadder(rollout: Rollout): LadderStep[] {
  return rollout.canarySteps.map((step, index) => {
    const state: LadderStepState =
      index < rollout.currentStep
        ? "done"
        : index === rollout.currentStep
          ? "active"
          : "queued"
    return {
      n: index + 1,
      weight: step.setWeight,
      duration: step.duration,
      state,
      tone: ladderStepTone(rollout, state),
      note: ladderStepNote(rollout, step.duration, state),
      barPercent: Math.round(
        BAR_FLOOR_PERCENT +
          (Math.min(Math.max(step.setWeight, 0), 100) / 100) *
            (100 - BAR_FLOOR_PERCENT),
      ),
    }
  })
}

/**
 * The tone of the step in flight, which is not the same subject as the tone of
 * the rollout. A rollout that is Paused resolves to `pending` — that is a
 * legitimate resting state for the object. The *step* it is stuck on is not
 * resting: it is blocked, and needs someone. So a held step reads degraded
 * while the header pill still reads Paused, and the note under the bar says
 * "held" in words either way.
 */
function ladderStepTone(rollout: Rollout, state: LadderStepState): StatusTone {
  if (state === "done") return "healthy"
  if (state === "queued") return "pending"
  if (rollout.abort || rollout.phase === "Failed") return "failed"
  if (
    rollout.paused ||
    rollout.phase === "Paused" ||
    rollout.phase === "Degraded"
  ) {
    return "degraded"
  }
  if (rollout.phase === "Pending" || rollout.phase === "") return "pending"
  return "progressing"
}

function ladderStepNote(
  rollout: Rollout,
  duration: string,
  state: LadderStepState,
): string {
  if (state === "done") return "completed"
  if (state === "queued") return "queued"
  if (rollout.abort) return "rolling back"
  if (rollout.paused || rollout.phase === "Paused") return "held"
  if (duration) return `waiting ${duration}`
  return "manual gate"
}

/** 1-based number of the step in flight, or 0 when none is. */
export function activeStepNumber(rollout: Rollout): number {
  if (rollout.canarySteps.length === 0) return 0
  if (rollout.currentStep >= rollout.canarySteps.length) return 0
  return rollout.currentStep + 1
}

/** Weight of the step after the one in flight, or undefined when there is none. */
export function nextStepWeight(rollout: Rollout): number | undefined {
  const next = rollout.canarySteps[rollout.currentStep + 1]
  return next?.setWeight
}

/* ── Traffic split ────────────────────────────────────────────────────── */

export interface TrafficSplit {
  canaryPercent: number
  stablePercent: number
  stableRs: string
  canaryRs: string
  stableReadyReplicas: number
  canaryReadyReplicas: number
}

/**
 * Only a weighted rollout has a split to draw. Without canary steps there is
 * no second version taking traffic, and a bar reading "STABLE 100%" would be
 * decoration rather than information.
 */
export function buildTrafficSplit(rollout: Rollout): TrafficSplit | null {
  if (rollout.canarySteps.length === 0) return null
  const canaryPercent = Math.min(Math.max(rollout.currentWeight, 0), 100)
  return {
    canaryPercent,
    stablePercent: 100 - canaryPercent,
    stableRs: rollout.stableRs,
    canaryRs: rollout.canaryRs,
    stableReadyReplicas: rollout.stableReadyReplicas,
    canaryReadyReplicas: rollout.canaryReadyReplicas,
  }
}

/** `istio VirtualService · checkout-api` — whatever the router actually says. */
export function trafficRouterLabel(rollout: Rollout): string {
  const router = rollout.trafficRouter
  if (!router) return ""
  const object =
    router.istio?.virtualService ||
    router.gatewayApi?.httpRoute ||
    router.istio?.stableService ||
    router.gatewayApi?.stableService ||
    ""
  const kind = router.istio?.virtualService
    ? "VirtualService"
    : router.gatewayApi?.httpRoute
      ? "HTTPRoute"
      : "Service"
  if (!router.provider && !object) return ""
  if (!object) return router.provider
  return `${router.provider || kind} · ${object}`
}

/* ── Rollout log ──────────────────────────────────────────────────────── */

export interface RolloutLogEntry {
  key: string
  /** RFC3339, exactly as the condition reported it. Empty when unset. */
  iso: string
  tone: StatusTone
  type: string
  text: string
}

/**
 * `Rollout.conditions[]` is already a timestamped event list; the log is that
 * list, newest first. Conditions with no transition time keep their original
 * order behind the timestamped ones rather than being dated by the client.
 */
export function buildRolloutLog(
  conditions: readonly Condition[],
): RolloutLogEntry[] {
  return conditions
    .map((condition, index) => ({
      key: `${condition.type}-${condition.lastTransitionTime}-${index}`,
      iso: condition.lastTransitionTime,
      tone: conditionTone(condition),
      type: condition.type,
      text:
        condition.message ||
        condition.reason ||
        `${condition.type} is ${condition.status || "Unknown"}`,
      order: index,
      at: Date.parse(condition.lastTransitionTime),
    }))
    .sort((a, b) => {
      const aTime = Number.isNaN(a.at) ? -Infinity : a.at
      const bTime = Number.isNaN(b.at) ? -Infinity : b.at
      if (aTime === bTime) return a.order - b.order
      return bTime - aTime
    })
    .map(({ key, iso, tone, type, text }) => ({ key, iso, tone, type, text }))
}

const FAILED_REASON = /fail|error|abort|denied|crashloop|timeout|exceeded/i
const BLOCKED_REASON = /pause|paus|held|hold|block|await|wait|degrad/i

export function conditionTone(condition: Condition): StatusTone {
  if (FAILED_REASON.test(condition.reason)) return "failed"
  if (BLOCKED_REASON.test(condition.reason)) return "degraded"
  switch (condition.status) {
    case "True":
      return /progress/i.test(condition.type) ? "progressing" : "healthy"
    case "False":
      return "degraded"
    default:
      return "unknown"
  }
}

/* ── Analysis ─────────────────────────────────────────────────────────── */

export interface AnalysisObservation {
  baseline?: string
  canary?: string
}

/** A number with an optional unit, as analysis messages actually write them. */
const VALUE = String.raw`-?\d+(?:\.\d+)?\s*(?:%|ms|s|m|µs|×|x|/s|req/s|restarts\/pod)?`
const BASELINE_KEY = /^(?:baseline|before|control|stable)$/i
const IGNORED_KEY = /^(?:threshold|target|budget|limit|max|min)$/i
/** `48/50 succeeded (96%, threshold 99%)` — the value just before the threshold. */
const BESIDE_THRESHOLD = new RegExp(String.raw`(${VALUE})\s*[,;]\s*threshold`, "i")
/** `error rate: 0.04 (threshold 0.02)` — the value straight after the label. */
const AFTER_LABEL = new RegExp(String.raw`^([^:=]{1,48})[:=]\s*(${VALUE})`, "i")
/** `p99=1200ms`, `baseline: 412 ms` — every labelled pair in the string. */
const LABELLED_PAIR = new RegExp(
  String.raw`([A-Za-z][\w .-]{0,31}?)\s*[:=]\s*(${VALUE})`,
  "gi",
)

/** Pathological inputs are not worth scanning; real messages are one line. */
const MAX_PARSE_LENGTH = 400

/**
 * `AnalysisRunResult` carries no typed observed value — the number exists only
 * inside the free-form `message`/`detail` the check author wrote. This reads
 * what it can recognise and returns nothing for what it cannot, because an
 * empty cell is honest and a guessed one is not.
 *
 * A value labelled as a threshold is never reported as an observation, so the
 * two can never be swapped.
 */
export function parseAnalysisObservation(
  message: string,
  detail = "",
): AnalysisObservation {
  const observation: AnalysisObservation = {}
  for (const text of [message, detail]) {
    if (!text) continue
    absorb(observation, text.slice(0, MAX_PARSE_LENGTH))
    if (observation.baseline && observation.canary) break
  }
  return observation
}

function absorb(into: AnalysisObservation, text: string): void {
  // A value sitting immediately before the word "threshold" is the observation
  // by construction, so it is read before any label is trusted. Without this,
  // "48/50 succeeded (96%, threshold 99%)" reports 48.
  if (!into.canary) {
    const beside = BESIDE_THRESHOLD.exec(text)
    if (beside) into.canary = normalizeValue(beside[1])
  }
  for (const match of text.matchAll(LABELLED_PAIR)) {
    const key = match[1].trim()
    const value = normalizeValue(match[2])
    if (isIgnoredLabel(key)) continue
    if (BASELINE_KEY.test(key) || /\bbaseline\b/i.test(key)) {
      into.baseline ??= value
      continue
    }
    into.canary ??= value
  }
  if (!into.canary) {
    const after = AFTER_LABEL.exec(text)
    if (after && !isIgnoredLabel(after[1].trim())) {
      into.canary = normalizeValue(after[2])
    }
  }
}

function isIgnoredLabel(label: string): boolean {
  return IGNORED_KEY.test(label) || /\b(?:threshold|target|budget|limit)\b/i.test(label)
}

function normalizeValue(raw: string): string {
  return raw.trim().replace(/\s+/g, " ")
}

export interface AnalysisRow {
  key: string
  name: string
  /** The PromQL, URL or pod metric the check names. Empty when it names none. */
  query: string
  threshold?: string
  baseline?: string
  canary?: string
  tone: StatusTone
  result: string
  /** Free-form text the check reported; shown as the row's explanation. */
  message: string
  checkedAt: string
}

export interface AnalysisColumns {
  baseline: boolean
  canary: boolean
  threshold: boolean
}

/**
 * A column with nothing in it is removed rather than filled: four blank
 * BASELINE cells read as "baseline is zero" to anyone skimming.
 */
export function analysisColumns(
  rows: readonly AnalysisRow[],
): AnalysisColumns {
  return {
    baseline: rows.some((row) => row.baseline !== undefined),
    canary: rows.some((row) => row.canary !== undefined),
    threshold: rows.some((row) => Boolean(row.threshold)),
  }
}

function checkName(check: RolloutAnalysisCheck): string {
  return check.metric || check.type || "check"
}

/**
 * Joins declared checks to observed results by name. `AnalysisRunResult.name`
 * is the check author's own label, so the match is deliberately loose — but it
 * is a match on real strings, never on position.
 */
export function buildAnalysisRows(
  checks: readonly RolloutAnalysisCheck[],
  results: readonly AnalysisRunResult[],
): AnalysisRow[] {
  const claimed = new Set<number>()
  const rows: AnalysisRow[] = checks.map((check, index) => {
    const name = checkName(check)
    const at = results.findIndex(
      (result, resultIndex) =>
        !claimed.has(resultIndex) && resultMatchesCheck(result, check),
    )
    if (at !== -1) claimed.add(at)
    const result = at === -1 ? undefined : results[at]
    const observation = result
      ? parseAnalysisObservation(result.message, result.detail)
      : {}
    return {
      key: `check-${index}-${name}`,
      name: result?.name || name,
      query: check.metric || check.url || "",
      threshold: check.successThreshold || check.threshold || undefined,
      baseline: observation.baseline,
      canary: observation.canary,
      tone: resultTone(result),
      result: resultLabel(result),
      message: result?.message ?? "",
      checkedAt: result?.checkedAt ?? "",
    }
  })

  results.forEach((result, index) => {
    if (claimed.has(index)) return
    const observation = parseAnalysisObservation(result.message, result.detail)
    rows.push({
      key: `result-${index}-${result.name}`,
      name: result.name || "check",
      query: "",
      threshold: undefined,
      baseline: observation.baseline,
      canary: observation.canary,
      tone: resultTone(result),
      result: resultLabel(result),
      message: result.message,
      checkedAt: result.checkedAt,
    })
  })

  return rows
}

function resultMatchesCheck(
  result: AnalysisRunResult,
  check: RolloutAnalysisCheck,
): boolean {
  const name = result.name.trim().toLowerCase()
  if (!name) return false
  const candidates = [check.metric, check.type, check.url]
    .filter(Boolean)
    .map((value) => value.toLowerCase())
  return candidates.some(
    (candidate) => candidate === name || candidate.includes(name),
  )
}

function resultTone(result: AnalysisRunResult | undefined): StatusTone {
  if (!result) return "pending"
  return result.passed ? "healthy" : "failed"
}

function resultLabel(result: AnalysisRunResult | undefined): string {
  if (!result) return "Pending"
  return result.passed ? "Pass" : "Fail"
}

export function failingRowCount(rows: readonly AnalysisRow[]): number {
  return rows.filter((row) => row.tone === "failed").length
}

/**
 * The rollout controller evaluates its checks inline and records the outcome on
 * `Rollout.conditions[]`, so a rollout may have a failing analysis with no
 * `AnalysisRun` record at all. This lifts those messages back out so the
 * analysis board can explain a pause it would otherwise have no evidence for.
 */
export function analysisResultsFromConditions(
  conditions: readonly Condition[],
): AnalysisRunResult[] {
  return conditions
    .filter((condition) => /analysis/i.test(condition.reason))
    .map(
      (condition) =>
        new AnalysisRunResult({
          name: "",
          passed: condition.status === "True",
          message: condition.message,
          detail: "",
          checkedAt: condition.lastTransitionTime,
        }),
    )
}

/**
 * Picks the analysis run that belongs to this rollout. The link is by name:
 * `AnalysisRun.applicationRef` names an application, and a rollout is named for
 * the application or for the workload it targets. No match means no run, which
 * the board says rather than papers over.
 */
export function selectAnalysisRun(
  runs: readonly AnalysisRun[],
  rollout: Rollout,
): AnalysisRun | undefined {
  const names = new Set(
    [rollout.name, rollout.targetName].filter(Boolean).map((n) => n.toLowerCase()),
  )
  const candidates = runs.filter((run) =>
    names.has(run.applicationRef.trim().toLowerCase()),
  )
  if (candidates.length === 0) return undefined
  return candidates.reduce((newest, run) =>
    run.startedAt > newest.startedAt ? run : newest,
  )
}

/* ── History ──────────────────────────────────────────────────────────── */

export function rolloutOutcomeTone(outcome: RolloutOutcome): StatusTone {
  switch (outcome) {
    case RolloutOutcome.SUCCEEDED:
      return "healthy"
    case RolloutOutcome.ABORTED:
    case RolloutOutcome.ROLLED_BACK:
      return "degraded"
    case RolloutOutcome.FAILED:
      return "failed"
    case RolloutOutcome.SUPERSEDED:
      return "unknown"
    default:
      return "pending"
  }
}

export function rolloutOutcomeLabel(outcome: RolloutOutcome): string {
  switch (outcome) {
    case RolloutOutcome.SUCCEEDED:
      return "Succeeded"
    case RolloutOutcome.ABORTED:
      return "Aborted"
    case RolloutOutcome.FAILED:
      return "Failed"
    case RolloutOutcome.ROLLED_BACK:
      return "Rolled back"
    case RolloutOutcome.SUPERSEDED:
      return "Superseded"
    default:
      return "Unknown"
  }
}

/* ── Formatting ───────────────────────────────────────────────────────── */

/** `09:41` in the reader's locale, or "" when the timestamp is unusable. */
export function formatClock(iso: string): string {
  if (!iso) return ""
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ""
  return at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

export function formatDurationMs(ms: bigint | number): string {
  const total = Math.round(Number(ms) / 1000)
  if (!Number.isFinite(total) || total <= 0) return ""
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** Age of an observation, for the STALE badge. */
export function formatAge(observedAtUnixMs: bigint, now: number): string {
  const observed = Number(observedAtUnixMs)
  if (!observed) return ""
  const age = now - observed
  if (age <= 0) return ""
  return formatDurationMs(age) || "0s"
}
