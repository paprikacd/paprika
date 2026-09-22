# Backend map: rollout / analysis / traffic / gates / engine

Scope: `internal/rollout`, `internal/analysis`, `internal/traffic`, `internal/gates`,
`internal/engine`, plus the controllers and CRDs that back them
(`api/rollouts/v1alpha1`, `api/pipelines/v1alpha1`,
`internal/controller/rollouts`, `internal/controller/pipelines`) and the ConnectRPC
surface in `internal/api`.

Headline: **there is no history persistence anywhere in this subsystem.** Every
"history"-shaped field in the design must be built from scratch. Details below.

---

## 1. The rollout state machine

### 1.1 Package layout

`/Users/benebsworth/projects/paprika/internal/rollout/` is a thin façade over five
strategy packages:

| File | What it is |
|---|---|
| `rollout.go:38` | `NewStrategy(spec *rolloutsv1alpha1.RolloutStrategy) (Strategy, error)` — switch on `spec.Type` ∈ `Rolling` / `Canary` / `BlueGreen` / `ABTest` / `Mirror` |
| `rollout.go:16-36` | type aliases + re-exported `Action*` constants for `core` |
| `hash.go` | re-export of `internal/rollout/hash.Template` |
| `core/core.go` | shared types (below) |
| `canary/canary.go`, `bluegreen/bluegreen.go`, `abtest/abtest.go`, `mirror/mirror.go`, `rolling/rolling.go` | the five strategies |

### 1.2 Core contract — `internal/rollout/core/core.go`

```go
// core.go:17-19
const (
    AbortAnnotation   = "paprika.io/abort"
    PromoteAnnotation = "paprika.io/promote"
)

// core.go:22-26
type Strategy interface {
    Type() string
    Sync(ctx, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus, in SyncInputs) (*SyncResult, error)
    Cleanup(ctx, ro *rolloutsv1alpha1.Rollout) error
}
```

- `SyncInputs` (`core.go:32-44`): `Clock clock.Clock`, `StableReadyReplicas int32`,
  `CanaryReadyReplicas int32`. Deliberately closed — **strategies cannot read the
  cluster**, so they cannot see metrics, latency, error rate, or cost. Any
  metric-driven gate has to be fed in through this struct or through an
  `AnalysisRun`.
- `SyncResult` (`core.go:72-77`): `Phase`, `Action`, `Message`, `ReplicaSets []ReplicaSetAction`.
  **No timestamps, no duration, no outcome record.** It is a pure "what to do
  next" value; nothing about it is retained.
- `Action` (`core.go:80-97`): `ActionNone`, `ActionCreateStable`, `ActionPromote`,
  `ActionStep`, `ActionPause`, `ActionRollback`, `ActionComplete`, `ActionAbort`.
  Note `ActionRollback` is declared but **no strategy ever returns it** (grep:
  only referenced in `rollout.go`'s re-export and tests).
- `IsAborted` (`core.go:107`) — true if `status.Abort` OR the `paprika.io/abort`
  annotation is present.
- `AbortResult` (`core.go:127`) — retains stable RS at desired replicas, scales
  canary RS to 0, `Template: nil` so the controller must not overwrite templates.

### 1.3 Steps and weights (Canary) — `internal/rollout/canary/canary.go`

`Sync` at `canary.go:38`:

1. `canary.go:49-58` — if `status.StableRS == ""` → `ActionCreateStable`.
2. `canary.go:60-62` — abort check.
3. `canary.go:65-75` — new template hash ≠ stable hash and no canary RS →
   `ActionStep` "Creating canary ReplicaSet".
4. `canary.go:82-97` — **step advance, at most one step per reconcile**:
   - `step.Duration == nil || <= 0` → `CurrentStepIndex++`, `CurrentStepStartedAt = nil`
   - `CurrentStepStartedAt == nil` → stamp `in.Now()`
   - elapsed ≥ `step.Duration` → `CurrentStepIndex++`, clear timestamp
5. `canary.go:102-121` — all steps exhausted → `ActionPromote`, then `ActionComplete`
   once `stableHash == hash`.
6. `canary.go:123-144` — otherwise `ActionStep`, message
   `"Canary step %d at weight %d"`. Replica math:
   `stableReplicas = desired*(100-setWeight)/100`, `canaryReplicas = desired - stableReplicas`
   (floored at 1).

RS naming is content-addressed: `makeStableRS`/`makeCanaryRS` (`canary.go:147,160`)
produce `<rollout>-stable-<hash>` / `<rollout>-canary-<hash>`; `hashFromRSName`
(`canary.go:173`) parses the hash back out. Labels applied:
`rollouts.paprika.io/{stable,canary,revision,rollout}`.

**Canary does NOT read `core.PromoteAnnotation`.** Only `bluegreen.go:116`,
`abtest.go:80`, and `mirror.go:91` do. So the existing `PromoteRollout` RPC is a
no-op for canary rollouts — worth flagging to the design.

### 1.4 Other strategies (brief)

- **BlueGreen** (`bluegreen/bluegreen.go`): `ActiveService` required; stamps
  `status.PreviewHealthyAt` when preview goes fully ready (`:91-96`), auto-promotes
  after `AutoPromotionSeconds` (`:107-115`), manual promote via annotation (`:116`),
  otherwise `ActionPause` (`:126`). Post-promotion drain uses
  `status.PromotedAt` + `status.PreviousActiveRS` + `ScaleDownDelaySeconds`
  (`:136-211`).
- **ABTest** (`abtest/abtest.go:52-93`): creates canary RS, then parks on
  `ActionPause` until the promote annotation lands. Routes come from
  `spec.strategy.abTest.routes` (header/cookie → service).
- **Mirror** (`mirror/mirror.go:55-104`): same shape; `mirrorPercent` is static.
- **Rolling** (`rolling/rolling.go:49-227`): surge/unavailable math over two RSes.

None of them writes a per-step record. `status.CurrentStepIndex` /
`CurrentStepWeight` / `CurrentStepStartedAt` are **overwritten in place**.

### 1.5 CRD fields that back it — `api/rollouts/v1alpha1/rollout_types.go`

`RolloutPhase` (`:26-45`): `Pending`, `Progressing`, `Paused`, `Healthy`,
`Degraded`, `Failed`, `RolledBack`, `Aborted`.

`RolloutSpec` (`:196-205`):
```
Target RolloutTarget; Strategy RolloutStrategy; Template corev1.PodTemplateSpec;
Replicas *int32; RevisionHistoryLimit *int32; Paused bool;
RollbackPolicy *RollbackPolicy; TrafficRouter *TrafficRouter
```

`RolloutStatus` (`:208-246`) — **the complete set**:
```
ObservedGeneration int64
Phase RolloutPhase
Conditions []metav1.Condition
CurrentStepIndex int32
CurrentStepWeight int32
CurrentStepStartedAt *metav1.Time
StableRS, CanaryRS, ActiveService, PreviewService string
PromotedAt *metav1.Time          // BlueGreen only
PreviewHealthyAt *metav1.Time    // BlueGreen only
Abort bool
CurrentPodHash string
StableReadyReplicas, CanaryReadyReplicas int32
PreviousActiveRS string
Message string
```

Notably **absent**: `startedAt`, `finishedAt`, `duration`, `history []`,
`revision`, `commit author/message`, `triggeredBy`, `analysisRunRefs`,
`stepHistory`, `previousRevision`. `RevisionHistoryLimit` in the *spec* only
controls how many scaled-to-zero **ReplicaSets** are kept
(`rollout_controller.go:537 pruneReplicaSets`); it does not create any history
record.

### 1.6 Controller — `internal/controller/rollouts/rollout_controller.go`

`RolloutReconciler` (`:88-99`): `Client`, `Scheme`, `DynamicClient`,
`Analyzer *analysis.CELAnalyzer`, `EventRecorder`, `EventBroker *events.Broker`,
`Clock`.

`Reconcile` (`:141`) order of operations:
1. finalizer (`:152-158`)
2. deletion (`:160-162`)
3. **`if ro.Spec.Paused` → set `Phase = Paused`, patch status, publish event, RETURN with no requeue** (`:164-171`). Nothing else runs: no RS actions, no traffic reconfiguration. This is the natural substrate for a `Hold` mutation (§4).
4. `latchAbort` (`:252`) — annotation → durable `status.Abort`; cleared only when the annotation is gone AND `CurrentPodHash` changed.
5. `applyDefaults` (`:293`), `resolveTarget` (`:377`)
6. `rollout.NewStrategy` → `observeReadyReplicas` (`:396`) → `strategy.Sync`
7. `executeReplicaSetActions` (`:457`), `pruneReplicaSets` (`:537`),
   `ensureServices` (`:593`), `configureTraffic` (`:706`)
8. `runAnalysis` (`:841`) — **error is logged only, never persisted**
9. `updateStatusFromResult` (`:888`) → `patchStatus` (`:929`, plain
   `Status().Update`) → `publishRolloutEvent` (`:120`)
10. requeue: `Pause` → 30s, `Step` → `stepRequeueInterval` (`:313`), else immediate.

`updateStatusFromResult` (`:888-927`) is where all status mutation happens. It
overwrites `Phase`, `Message`, `ObservedGeneration`, `CurrentPodHash`, derives
`StableRS`/`CanaryRS`/`PreviousActiveRS` from the returned RS labels, and sets
`CurrentStepWeight` from the spec step at `CurrentStepIndex`. It emits metrics
(`RolloutCanaryWeightGauge`, `RolloutCanaryStepTotal`, `RolloutPhaseTotal`) but
**appends nothing to any list**.

`publishRolloutEvent` (`:120-139`) publishes an `events.EventPayload` to
`events.TopicDashboard` with `{ResourceType, Name, Namespace, Phase, Message, Timestamp}`.
That is the only "stream of what happened" and it is **fire-and-forget pub/sub with
zero retention** (§5).

---

## 2. Is there ANY history for completed rollouts?

**No. Only current state.** Three separate confirmations:

1. `RolloutStatus` has no history list (§1.5). Every field is scalar and
   overwritten each reconcile.
2. When a rollout completes it just sits at `Phase = Healthy`. Nothing archives it.
   `Cleanup` is a no-op in every strategy (e.g. `canary.go:33`).
3. There is no Prometheus/OTel histogram for rollout duration. `internal/metrics/metrics.go`
   has `PipelineDuration` (`:17`) and `ReleaseDuration` (`:36`) histograms, but for
   rollouts only counters/gauges: `RolloutCanaryStepTotal` (`:82`),
   `RolloutCanaryWeightGauge` (`:91`), `RolloutPhaseTotal` (`:100`). So even
   "median rollout duration" cannot be derived from existing telemetry.

### 2.1 Where finished rollouts actually go — the nearest existing thing

Rollout objects are **not** long-lived per-deploy records in the general case, but
`Release` objects *are* — and that is the closest thing to a rollout history that
exists today.

- `internal/controller/pipelines/application_controller.go:1112 applicationReleaseName`
  builds a **content-addressed** Release name:
  `<app>-release-<sha256(sourceHash|sourceRevision|stage)[:10]>`
  (`releaseIdentity` at `:1123`). So each (revision, stage) pair gets its own
  `Release` CR.
- Old Releases are transitioned to `ReleaseSuperseded`
  (`application_controller.go:2069-2070`) and then deleted:
  - `pruneReleaseHistory` (`:1746`) — keeps at most `maxReleaseHistory = 10`
    (`application_controller.go:48`), deleting oldest `Superseded` releases.
  - `pruneOldReleases` / `selectReleasesToKeep` / `deleteReleases`
    (`:2099`, `:2143`, `:2183`) — the inline-source path, same limit of 10.
- `ReleaseStatus.PromotionHistory []PromotionEntry`
  (`api/pipelines/v1alpha1/release_types.go:105`, entry type at `:55`) is
  `{Stage, Result, ManifestSnapshot, Timestamp}`. Appended once per promotion in
  `release_controller.go:454`, and the **last** entry's `Result` is later stamped
  `"Passed"` (`:682`), `"Failed"` (`:706`), `"RolledBack"` (`:2217`), or
  `"CanaryFailed"` (`:2560`). It has a start timestamp but **no completion
  timestamp and no duration**.
- Advanced-strategy stages get a Rollout child:
  `reconcileRolloutManagedRelease` (`release_controller.go:560`) creates
  `<release>-rollout` via `buildRollout` (`:618`) with an **OwnerReference on the
  Release**. Therefore each Rollout dies with its Release — max ~10 retained, and
  only for stages that set `stage.spec.rolloutStrategy`.
- Destructive re-run: `requestReleaseResync` (`application_controller.go:1960`)
  annotates a *terminal* Release with `paprika.io/resync` so the release
  controller re-runs it **in place**. Redeploying the same revision therefore
  overwrites the previous run's outcome. This is the single biggest reason
  Releases cannot be treated as a reliable rollout log.

**Conclusion for implementers:** to serve "completed rollouts, durations,
outcomes, medians" you must add a durable record. Nothing existing can be
back-filled.

---

## 3. Pipelines

### 3.1 How a run is modelled — it isn't

There is **no `PipelineRun` CRD**. `api/pipelines/v1alpha1/pipeline_types.go`
defines exactly one object, `Pipeline` (`:136`), and its status holds only the
latest execution:

```go
// pipeline_types.go:118-130
type PipelineStatus struct {
    ObservedGeneration int64
    Phase             PipelinePhase   // Running|Succeeded|Failed|Cancelled  (:9-20)
    StepStatuses      []StepStatus
    LastExecutionTime *metav1.Time
    LastExecutionID   string
    ArtifactRefs      []PipelineArtifactRef
}

// pipeline_types.go:72-79
type StepStatus struct {
    Name        string
    Phase       StepPhase    // Pending|Running|Succeeded|Failed|Skipped|Cancelled (:23-38)
    LogRef      string
    StartedAt   *metav1.Time
    CompletedAt *metav1.Time
}
```

`PipelineSpec` (`:107-115`): `MaxParallel int`, `Sources []Source`,
`Steps []PipelineStep`, `Artifacts []PipelineOutput`.
`PipelineStep` (`:50-61`): `Name, Depends []string, Image, Script, Timeout, Retry, Outputs`.
There is **no `Resources`/`Requests`/`Limits` field on `PipelineStep`.**

### 3.2 Run history — absent, and `LastExecutionID` is not a run number

`internal/controller/pipelines/pipeline_controller.go:174 reconcilePipeline`:

- `:230 isTerminalPipelinePhase` — once `Succeeded|Failed|Cancelled`, the
  controller only re-reconciles artifacts. A Pipeline is effectively **one-shot**.
- `:191` on first reconcile: `pipeline.Status.LastExecutionID = "run-" + req.Name`.
  That is `"run-<pipeline-name>"` — a **constant string, not a counter**. There is
  no run number anywhere in the codebase.
- `:192-193` sets `LastExecutionTime = now`.
- `:212` / `:226` overwrite `StepStatuses` wholesale.
- `patchPipelineStatus` (`:101`) does a full `fresh.Status = *desiredStatus`
  replace under `RetryOnConflict`, so any list you add to status is clobbered
  unless the reconciler builds it.
- `handlePipelineResult` (`:120`) records `metrics.PipelineDuration.Observe(...)`
  (`metrics/metrics.go:17`, a Prometheus histogram) **only on success** — failures
  increment `PipelinePhaseTotal` but record no duration.

So: **no run history, no run number, no per-run durations retained on the object.**
The only durable per-run trace is:
- the Prometheus histogram (aggregate only, success-only), and
- `Artifact` CRs, whose `spec.provenance` carries `{Pipeline, Build, Step}` where
  `Build = LastExecutionID` (`pipeline_controller.go:336`) — i.e. the same
  constant string for every run.

### 3.3 Step timings and resource usage

- **Step timings exist per-step for the current run only**:
  `StepStatus.StartedAt` / `CompletedAt`, stamped in
  `internal/engine/workflow.go` (`runStepJob` at `:220`, i.e. sed-relative
  `:241,:243,:263`). Progress is streamed live via `StepProgressCallback`
  (`workflow.go:155`) → `PipelineReconciler.updateStepStatus`
  (`pipeline_controller.go:569`) → `patchPipelineStatus`. Overwritten next run.
- **Resource requests do not exist.** `WorkflowEngine.CreateStepJob`
  (`internal/engine/workflow.go:372`) builds the step Job with
  `BackoffLimit=0`, `ActiveDeadlineSeconds=step.Timeout||3600`, a security
  context, and a single container with `Image`, `Command: ["sh","-c"]`,
  `Args: [step.Script]`. **No `corev1.ResourceRequirements` is ever set**, and
  `PipelineStep` has no field to carry one. Per-step CPU/memory requests need a
  new CRD field *and* plumbing into `CreateStepJob`.
- **CPU-minutes**: not computed anywhere. Would need either the missing
  requests × step duration, or a metrics-server / Prometheus integration that
  does not exist (`internal/analysis/analysis.go:163-168` explicitly says
  "no metrics server available, assuming pass").
- **Test counts**: nothing parses step output. `GetStepLogs`
  (`workflow.go:433`) returns raw concatenated pod logs; nothing structured.
- **Cache-hit rate**: the only cache-hit concept is manifest rendering
  (`internal/engine/cached_renderer.go:44 Render`, TTL `DefaultManifestTTL = 5m`
  at `:14`), backed by `internal/cache` (`Getter`/`Setter` in
  `cache/interfaces.go`, redis or in-memory via `cache/factory.go`). It emits
  no hit/miss counter — grep for hit-rate metrics returns nothing. Pipeline steps
  have no cache concept at all.

### 3.4 DAG execution

`internal/engine/workflow.go`:
- `Graph`/`Node` (`:24,:31`), `NewGraph` (`:36`), `TopologicalSort` (`:49`),
  cycle detection (`:75,:85`), `buildBatches` (`:107`), `ResolveDAG` (`:135`).
- `RunPipeline` (`:166`) → `executeBatch` (`:189`, chunks by `MaxParallel`,
  default 10) → `executeSubBatch` (`:201`, `errgroup`) → `runStepJob` (`:220`).
- `watchJob` (`:321`) / `processJobEvent` (`:353`) watch the Job to completion.
- `retryStep` (`:296`) re-creates the Job up to `step.Retry` times, **reusing the
  original `StartedAt`** — so attempt-level timing is lost.
- Interfaces are declared consumer-side in
  `internal/controller/pipelines/workflow.go`: `PipelineRunner`,
  `StepJobCreator`, `StepLogGetter`, composed as `WorkflowEngine`.

### 3.5 Pipeline mutations that already exist

`internal/api/pipeline_handler.go`:
- `RetryStep` (`:64`) — flips a `Failed`/`Skipped` step back to `Pending` in
  `status.stepStatuses`, `Status().Update`, publishes an event.
- `SkipStep` (`:100`) — `Pending` → `Skipped` + `CompletedAt`.
- `CancelPipeline` (`:137`) + `cancelPipelineStatus` (`:164`) +
  `deletePipelineJobs` (`:175`).
- `GetStepLogs` (`:190`) — finds latest Job by label (`:221`), finds its pod
  (`:239`), tails logs (`:253`).

These are the template to copy for a `HoldRollout`-style mutation: get object →
authorize → mutate status/annotation → `Update` → publish event.

---

## 4. Gates, Approve/Reject, and what a `Hold` would need to touch

### 4.1 Two unrelated gate models

**(a) Verification gates** — `internal/gates/gates.go`
```go
type GateConfig struct { Type, Endpoint string; Timeout int }   // :22
type GateResult struct { Passed bool; Message string; Error error } // :15
```
`SmokeGate.Execute` (`:38`, HTTP GET, 2xx = pass, default 300s),
`DurationGate.Execute` (`:70`, just sleeps, default 60s),
`ExecuteGate` dispatcher (`:83`, `"smoke-test"` / `"duration"`).
Mirrored in the CRD as `pipelinesv1alpha1.GateConfig`
(`api/pipelines/v1alpha1/stage_types.go:31`), used by `ReleaseSpec.Verify`
(`release_types.go:67`) and `StageSpec.Gates` (`stage_types.go:142`).
**Results are not persisted** — `verify()` returns a bool
(`release_controller.go:677`).

**(b) Approval gates** — `internal/gates/approval.go`
```go
const ApprovalGateType{Manual,Webhook,Slack}   = "manual"|"webhook"|"slack"  // :12-16
const ApprovalGateStatus{Pending,Approved,Rejected}                          // :19-23
type ApprovalGate  struct { Name, Stage, Type string; Required bool; URL, Method string;
                            Headers map[string]string; Body string; SuccessStatus int;
                            SlackWebhookURL, SlackChannel string }           // :26-40
type ApprovalGatePayload struct { Application, Namespace, Release, Stage, Gate string } // :43
type ApprovalGateResult  struct { Status, ApprovedBy, Message string; Error error }     // :51
```
`ApprovalGateEvaluator.Evaluate` (`approval.go:66`):
- `currentStatus == Approved` → returns `Approved` (short-circuit, **this is what
  makes the ApproveGate RPC stick**)
- `currentStatus == Rejected` → returns `Rejected`
- `manual` → `Pending` "waiting for manual approval"
- `webhook` → `evaluateWebhook` (`:88`) — 30s timeout, `SuccessStatus` or any 2xx
  → `Approved` with `ApprovedBy: "webhook"`
- `slack` → hard-coded `Pending`, "Slack interaction is Phase 2"

CRD mirror: `pipelinesv1alpha1.ApprovalGate`
(`api/pipelines/v1alpha1/application_types.go:375`, constants at `:360-372`) and
`GateStatus` (`application_types.go:427`):
```go
type GateStatus struct { Name, Stage, Type, Status, ApprovedBy, Message string }
```
Stored on `ApplicationStatus.Gates []GateStatus`
(`application_types.go:626`). **This is the only place gate state lives.**

### 4.2 Evaluation path (release controller)

`internal/controller/pipelines/release_controller.go`:
- `effectiveApprovalGates(app, stage)` (`:2830`) — union of
  `app.Spec.ApprovalGates` (filtered by `Required` and `Stage` match) and
  `stage.Spec.ApprovalGates` (filtered by `Required`). `convertApprovalGate`
  (`:2854`) maps CRD → `gates.ApprovalGate`.
- `checkApprovalGates(release) (approved, rejected bool, err error)` (`:2899`):
  resolves owning Application + Stage, builds `ApprovalGatePayload`, evaluates
  every gate reading the current status via `findGateStatus` (`:2871`), then
  **`syncApplicationGateStatus` (`:2881`) REPLACES `app.Status.Gates` wholesale**
  (`fresh.Status.Gates = statuses` under `RetryOnConflict`). Returns
  `(false,true)` if any rejected, `(false,false)` if any pending, else `(true,false)`.
- Callers: `handlePromotingPhase` (`:485`) — not approved → `Phase = AwaitingApproval`,
  requeue 10s; `handleAwaitingApprovalPhase` (`:421`) — polls every 10s, on approve
  → `Promoting`, on reject → `failRelease`.

⚠️ **Critical for any new gate field**: because `syncApplicationGateStatus`
replaces the whole slice, any extra field you add to `GateStatus` (e.g. a hold
marker, hold expiry, holder identity) is wiped on the next reconcile unless
`checkApprovalGates` explicitly carries it forward from `findGateStatus(...)`.

### 4.3 Approve / Reject RPC path

`internal/api/server.go`:
- `ApproveGate` (`:693`): `Get` Application → `authorizeApplication(ActionWrite)`
  → find `app.Status.Gates[i].Name == req.Msg.Gate` → set
  `Status = GateStatusApproved`, `ApprovedBy = "api"` (**hard-coded string — the
  real principal is available in ctx via the auth interceptor but is not used**)
  → `Status().Update` → re-`Get` → return `convertApplication`.
- `ListGateStatus` (`:733`): read-only, `convertGateStatuses(app.Status.Gates)`.
- `RejectGate` (`:748`): same shape, sets `GateStatusRejected`, clears `ApprovedBy`.
- Proto RPCs at `proto/paprika/v1/api.proto:1156-1158`.
- Audit: `internal/api/audit_middleware.go` + `internal/audit` (`Event` at
  `audit.go:20`, `LogAuditor.Record` at `:62`) — writes JSON lines to a writer.
  **Not queryable; not a store.**

### 4.4 What a `Hold` mutation would need to touch

There is **no `Hold`, `Pause`, or `Resume` RPC today** — `proto/.../api.proto:1163-1166`
has only `ListRollouts`, `GetRollout`, `PromoteRollout`, `AbortRollout`.

Existing mutation templates:
- `PromoteRollout` (`server.go:884`) → sets annotation `paprika.io/promote` =
  unix-nanos, `client.Update`. (Ineffective for Canary — §1.3.)
- `AbortRollout` (`server.go:910`) → sets annotation `paprika.io/abort`,
  `client.Update`. Latched durably by `latchAbort` (`rollout_controller.go:252`).
- `authorizeRolloutWrite` (`server.go:936`) → resolves the owning Application via
  the `engine.ApplicationNameLabelKey` label
  (`internal/engine/scalable_diff.go:26 = "app.paprika.io/name"`), falls back to
  project-label authorization.

**Recommended shape for Hold — three viable substrates:**

1. **`spec.paused` (cleanest, already wired).** `rollout_controller.go:164`
   short-circuits the entire reconcile before `strategy.Sync`, sets
   `Phase = RolloutPhasePaused`, patches status, publishes an event, and returns
   with **no requeue**. Critically it does *not* call `configureTraffic`, so the
   current weight stays exactly where it is on the VirtualService/HTTPRoute.
   Resume = set `paused = false` (the Update event re-triggers reconcile).
   `spec.Paused` is already surfaced on the wire as `Rollout.paused` field 17
   (`api.proto`, `convertRollout` at `server.go:1016`).
   Gaps to fill: `RolloutStatus` has no `heldBy` / `heldAt` / `holdReason`, and
   there is no `HoldRollout`/`ResumeRollout` RPC.

2. **A new annotation** (`paprika.io/hold`) latched into a new
   `status.Hold`/`status.HoldReason` the way `latchAbort` does — keeps the
   mutation out of `spec` and survives spec updates from the release controller.
   ⚠️ Note `reconcileRolloutManagedRelease` (`release_controller.go:587-593`) does
   `ro.Spec = expected.Spec` on every reconcile of a rollout-managed release —
   **so anything written to `Rollout.spec` by the API is overwritten**, including
   `spec.paused`, for rollouts created by a Release. For those, Hold must live in
   an annotation or in status, or `buildRollout` (`:618`) must be taught to
   preserve it.

3. **Gate-level hold** (hold a *release* at a gate) — add a
   `GateStatusHeld` constant + carry-forward in `checkApprovalGates`
   (§4.2 warning), and a corresponding `ReleaseAwaitingApproval`-style phase.

Files a Hold implementation touches, minimum:
`proto/paprika/v1/api.proto` (RPC + request/response + `Rollout` fields),
`internal/api/server.go` (handler + `convertRollout`),
`api/rollouts/v1alpha1/rollout_types.go` (+ `zz_generated.deepcopy.go`, CRD yaml),
`internal/controller/rollouts/rollout_controller.go` (latch + short-circuit),
and `internal/controller/pipelines/release_controller.go:618 buildRollout`
if the rollout is release-managed.

---

## 5. Analysis (`internal/analysis`) — and why nothing survives

`internal/analysis/analysis.go`:
```go
type Result struct { Name, Message, Detail string; Passed bool }      // :22
type CELAnalyzer struct { K8sClient kubernetes.Interface; Namespace string;
                          RESTConfig *rest.Config; HTTPClient *http.Client } // :30
func (a *CELAnalyzer) RunChecks(ctx, checks []pipelinesv1alpha1.AnalysisCheck) []Result // :52
```
(Despite the name there is no CEL anywhere.) Concurrency limit 8 (`:56`).
Two check types:
- `runHTTPCheck` (`:83`) — N requests (default 5), success = 2xx/3xx, compares
  success-rate % against `SuccessThreshold`.
- `runPodMetricsCheck` (`:148`):
  - `restartRate` → `checkRestartRate` (`:177`) — lists pods with the
    **hard-coded label selector `app.kubernetes.io/name=demo-app`** (also in
    `checkPodStatusRate` at `:207`). This is a demo artifact and will not work
    for real applications.
  - `errorRate` → `checkPodStatusRate` (`:206`) — terminated-with-nonzero-exit
    ratio; **not an HTTP error rate**.
  - `latencyP99` → `:163-168` returns `Passed: true` with the message
    "no metrics server available, assuming pass". **P99 latency is fabricated.**
  - `WindowSeconds` is parsed and then ignored (`_ int` params at `:177`, `:206`).

`internal/analysis/substitute.go` — `SubstituteCheck(check, SubstituteContext{Args, Application, Namespace})`
templates `{{args.x}}` / application / namespace into check fields.

**Two consumers, two very different persistence stories:**

1. **Rollout controller** — `runAnalysis` (`rollout_controller.go:841`) picks the
   analysis block via `analysisForResult` (`:859`, per-step analysis for canary at
   the current index, else the strategy-level block), calls `RunChecks`, and on
   first failure sets a `RolloutProgressing=False` condition with reason
   `AnalysisFailed` and returns an error that `Reconcile:227` merely **logs**.
   **No AnalysisRun object is created; no result is stored.** The only trace is a
   transient condition message that the next successful reconcile removes
   (`removeCondition`, `:956`).

2. **AnalysisRun CRD** — `api/pipelines/v1alpha1/analysis_run_types.go`:
   ```go
   AnalysisRunSpec   { TemplateRef, ApplicationRef string; Args map[string]string;
                       IntervalSeconds, Count int; TerminateOnFailure bool }   // :35
   AnalysisRunStatus { ObservedGeneration int64; Phase AnalysisRunPhase;
                       CyclesExecuted int; Results []AnalysisRunResult;
                       StartedAt, CompletedAt *metav1.Time;
                       Conditions []metav1.Condition }                          // :56
   AnalysisRunResult { Name string; Passed bool; Message, Detail string;
                       CheckedAt *metav1.Time }                                 // :26
   ```
   `AnalysisRunReconciler` (`internal/controller/pipelines/analysisrun_controller.go:25`):
   `reconcileRun` (`:70`) resolves the `AnalysisTemplate`
   (`api/pipelines/v1alpha1/analysis_template_types.go:37`), merges args (`:140`),
   substitutes, runs checks, and **overwrites `status.Results` with the latest
   cycle only** (`:102` — the doc comment on the CRD field at
   `analysis_run_types.go:65` says so explicitly: "Results are the latest check
   results from the most recent cycle"). `CyclesExecuted` increments; per-cycle
   history is discarded. Requeue = `IntervalSeconds` (default 60).
   AnalysisRuns are created per Application by
   `internal/controller/pipelines/analysis_manager.go`:
   `reconcileAnalysisRuns` (`:25`), `ensureAnalysisRun` (`:68`), name
   `"%s-%s-analysis"` (`:19`) — i.e. **one long-lived singleton per
   (app, template)**, deleted when stale (`deleteStaleAnalysisRuns`, `:110`).
   Aggregated back onto `ApplicationStatus.AnalysisResults` by
   `aggregateAnalysisResults` (`:130`).
   Exposed as `ListAnalysisRuns`/`GetAnalysisRun` (`api.proto:1167-1168`, messages
   `AnalysisRun`/`AnalysisRunResult` at `api.proto:148-169`).

So the design's "per-app request rate / latency / error rate" has **no real source**:
latency is stubbed, error-rate is a pod-exit ratio, and neither is time-series.

---

## 6. Traffic (`internal/traffic`)

```go
// traffic.go:25-45 — consumer-side role interfaces
WeightRouter { SetWeight(ctx, weight int32) error; RemoveCanary(ctx) error }
HeaderRouter { SetHeaderRoute(ctx, header, value, service string) error; RemoveHeaderRoute(ctx, header string) error }
MirrorRouter { SetMirror(ctx, percent int32) error; RemoveMirror(ctx) error }
Provider     { Type() string }
```
`Router` (`:61`) wraps an unexported `routerImpl`. `NewRouter(cfg *paprikav1.TrafficRouter, dyn, stableSvc, canarySvc, ns)` (`:68`)
dispatches to `internal/traffic/istio` (VirtualService) or
`internal/traffic/gatewayapi` (HTTPRoute). Providers: `ProviderIstio = "istio"`,
`ProviderGatewayAPI = "gateway-api"` (`:16-19`). `ErrNotSupported` at `:22`.
Mocks generated into `internal/traffic/mocks`.

Controller wiring: `TrafficRouter`/`abTestRouter`/`mirrorRouter` composed
interfaces at `rollout_controller.go:66,75,82`; `configureTraffic` (`:706`)
dispatches to `configureCanaryTraffic` (`:731`), `configureBlueGreenTraffic`
(`:741`), `configureABTestTraffic` (`:748`), `configureMirrorTraffic` (`:773`);
`buildRouter` (`:784`), `routerServiceNames` (`:793`).

**Write-only.** No router reads back the live weight, and no observed weight is
stored — `status.CurrentStepWeight` is derived from the *spec* step
(`updateStatusFromResult:907-912`), not from the mesh. There is no per-route
request-rate / latency / error-rate read path at all.

---

## 7. Engine (`internal/engine`) — drift detail

Relevant to gap item 9 (per-resource drift detail).

- `DiffResult` (`diff.go:22`): `Added, Modified, Deleted, Unchanged []ResourceDiff`, `Summary string`.
- `ResourceDiff` (`diff.go:31`): `Kind, Name, Namespace, Action, LiveHash, DesiredHash`.
  **No changed-field list, no changed-field count, no drift timestamp, no reason.**
- `DiffOptions` (`diff.go:41`): `Namespace, LabelSelector, FieldSelector, ApplicationName, IgnoreDifferences []IgnoreDiff`.
- `DiffEngine.ComputeDiff` (`diff.go:67`); helpers `resourceEqual` (`:217`),
  `metaEqual` (`:226`), `specContains`/`specContainsAt`/`mapContains`/`sliceContains`
  (`:307,:314,:333,:353`) — these **walk to the exact differing path and then
  discard it**, returning only a bool. Adding changed-field counts/paths is a
  localized change here (thread a `[]string` out of `specContainsAt`).
- `DiffResult.ResourceSyncs()` (`diff.go:454`) is the lossy projection into the
  CRD type `pipelinesv1alpha1.ResourceSync`
  (`application_types.go:526`) = `{Kind, Name, Namespace, Status}` with
  `Status ∈ Synced|OutOfSync|Missing|Pruned`. `OutOfSyncCount()` at `:477`.
  Stored on `ApplicationStatus.Resources` (`application_types.go:598`) and
  `PrunableResources` (`:618`).
- `ScalableDiffEngine` (`scalable_diff.go:55`) — informer-backed variant;
  `ComputeDiff` (`:89`), `classifyDiffs` (`:134`),
  `isGeneratedChildResource` (`:188`), `ensureManagedLabels` (`:300`).
  Label constants at `:20-29`: `app.paprika.io/managed-by`, `app.paprika.io/name`,
  `app.paprika.io/release`.
- `LiveResourceCache` (`live_cache.go:21`) — dynamic informers per GVR.
- **Ignoring a drifted field**: `ApplyIgnoreDifferences(desired, live, ignoreDiffs)`
  (`diff_ignore.go:14`) + `removeField` (`:32`). Backed by
  `IgnoreDiff { JSONPointers []string }` (`application_types.go:145`) on
  `ApplicationSpec.IgnoreDifferences` (`:517`). ⚠️ **This is global to the
  Application — there is no group/kind/name scoping like Argo's.** A per-resource
  "ignore this field" mutation therefore needs `IgnoreDiff` extended with
  `Group/Kind/Name/Namespace` plus matching logic in `ApplyIgnoreDifferences`.
- Rendering: `templateRenderer` (`renderer.go:11`), `TemplateRenderer`
  (`template.go:17`), `HelmSDKRenderer` (`helm_sdk_renderer.go`),
  `KustomizeRenderer`, `RepoServerRenderer`, `CachedTemplateRenderer`
  (`cached_renderer.go:23`, TTL `:14`).
- Sync hooks: `internal/engine/hooks/` — `Phase` (`classify.go:14`),
  `ClassifyPaired` (`:107`), `Bucket` (`:73`), `IsHook`/`FilterHooks`
  (`filter.go:12,:22`), `CompletionFunc` + job/pod checkers (`completion.go:27,:52,:61`).
  Surfaced as `HookStatus` (`release_types.go:81`) →
  `ReleaseStatus.HookStatuses` (`:127`) → `ApplicationStatus.HookStatuses`
  (`application_types.go:604`) — cleared at the start of each promote, so again
  **current run only**.
- **Selective per-resource sync does not exist.** `SyncApplicationRequest`
  (`api.proto`) is `{name, namespace}` only; `SyncApplication`
  (`server.go` ~`:660`) annotates the Application for a full sync. There is no
  resource-scoped apply path and no JSON-patch RPC (`ApplyBundle` at
  `internal/api/apply_bundle.go` applies a whole rendered bundle).

---

## 8. Where rollout / pipeline history would have to be persisted

**There is no database.** Verified:
- `go.mod` has no SQL driver as a direct dependency (`jmoiron/sqlx` and
  `rubenv/sql-migrate` are `// indirect`, pulled in by Helm). No sqlite, no
  postgres driver, no bolt/badger.
- `internal/cache` is Redis-or-memory **KV with TTL** only:
  `Getter/Setter/Deleter/Pinger/Closer/PrefixDeleter` (`cache/interfaces.go`),
  `New(ctx, Config{Backend: "redis"|"memory", ...})` (`cache/factory.go`).
  Used for rendered-manifest and source-resolution caching
  (`ManifestCachePrefix`/`SourceCachePrefix`, `ManifestKey`/`SourceKey` at
  `cache/interfaces.go:69,:75`). Everything is TTL'd — unsuitable as a system of record.
- `internal/api/events.Broker` (`broker.go:30`) is **Redis pub/sub, zero retention**.
  `Publish` (`:167`) fans out locally then `redis.Publish`; `publishLocal` (`:182`)
  **drops events when a subscriber buffer is full** ("deliberate backpressure
  policy"). Subscribers get only what arrives after they subscribe. Payload shape:
  `events.EventPayload` (`eventtypes.go:5`) — `{ResourceType, Name, Namespace,
  Phase, PreviousPhase, Reason, Message, Timestamp, StartedAt, CompletedAt}`.
  Consumed by `internal/api/sse.go`.
- `internal/audit` is a log-line auditor (`LogAuditor.Record`, `audit.go:62`) —
  append-only to an `io.Writer`, not queryable.
- Metrics: Prometheus + OTel in `internal/metrics`. `PipelineDuration` (`:17`) and
  `ReleaseDuration` (`:36`) histograms exist; **no rollout duration histogram**.
  Aggregate only — cannot answer "list the last 20 rollouts".

### Options, in rough order of fit

**A. New CRDs (`RolloutRecord` / `PipelineRun`) in etcd.** Consistent with
everything else here; survives restart; free RBAC, watch, and list. Costs etcd
space and needs a TTL/limit controller. Precedent for content-addressed naming
already exists (`applicationReleaseName`, `application_controller.go:1112`) and
for prune-by-limit (`pruneReleaseHistory` at `:1746`, `maxReleaseHistory = 10` at
`:48`; `pruneReplicaSets` at `rollout_controller.go:537`). Write points:
- rollouts: `updateStatusFromResult` (`rollout_controller.go:888`) on transition
  into `Healthy|Failed|Aborted|RolledBack`;
- pipelines: `handlePipelineResult` (`pipeline_controller.go:120`), which already
  has `start time.Time` in hand for a duration.

**B. Bounded ring-buffer on existing status.** Add e.g.
`RolloutStatus.History []RolloutHistoryEntry` (cap ~20) and
`PipelineStatus.RunHistory []PipelineRunRecord`. Cheapest to ship, no new
controller. ⚠️ Both `patchPipelineStatus` (`pipeline_controller.go:101`,
`fresh.Status = *desiredStatus`) and `syncApplicationGateStatus`
(`release_controller.go:2881`, `fresh.Status.Gates = statuses`) do **whole-field
replacement**, so the reconciler must read-then-append, and the API server must
never write these lists. Also bounded by the ~1.5MB etcd object limit.

**C. Redis with real retention** (`LPUSH`/`LTRIM` or Streams) alongside the
existing broker. Requires extending `internal/cache` beyond `Get/Set/Delete` or
using `redis.UniversalClient` directly (already a dependency and already held by
`events.Broker`). Fast reads for "last N", but Redis is currently optional
(`PAPRIKA_CACHE_BACKEND` defaults to `memory`, `cache/factory.go`) — history
would silently vanish in default deployments.

**D. Prometheus/OTel only.** Already partly there for medians
(`PipelineDuration`, `ReleaseDuration`). Cannot serve a per-rollout list.
Would need a new `RolloutDuration` histogram at minimum.

### Fields that must be *captured at write time* (they are not derivable later)

| Needed | Where it must be captured | Currently |
|---|---|---|
| rollout `startedAt`/`finishedAt`/`duration` | `rollout_controller.go:888` | absent |
| rollout outcome + reason | same | only transient `Message`/condition |
| triggering revision + commit author/message | `ApplicationStatus.SourceRevision`/`SourceHash` (`application_types.go:578-579`) is the only revision; no commit metadata anywhere | absent |
| run number | nothing monotonic exists (`LastExecutionID = "run-"+name`, `pipeline_controller.go:191`) | absent |
| per-step duration for a *finished* run | `StepStatus.StartedAt/CompletedAt` before they are overwritten | ephemeral |
| per-step CPU/memory requests | needs a new `PipelineStep.Resources` field + `CreateStepJob` (`engine/workflow.go:372`) | absent |
| analysis results per cycle | `AnalysisRunStatus.Results` is latest-cycle-only (`analysis_run_types.go:65`) | ephemeral |
| gate approve/reject actor + timestamp | `ApproveGate` hard-codes `ApprovedBy = "api"` (`server.go:709`); `GateStatus` has no timestamp | absent |

---

## 9. Quick "does it exist?" table for this subsystem

| Design need | Exists? | Nearest existing thing |
|---|---|---|
| Rollout steps / weights | ✅ | `RolloutStatus.CurrentStepIndex/CurrentStepWeight/CurrentStepStartedAt`; `CanaryStrategy.Steps` |
| Rollout *history* / durations / medians | ❌ | `ReleaseStatus.PromotionHistory` (start-time only, ≤10 Releases retained, wiped on resync) |
| Analysis runs, persisted | ⚠️ | `AnalysisRun` CRD exists but keeps only the latest cycle; rollout-triggered analysis persists nothing |
| Real latency / error-rate / request-rate | ❌ | `latencyP99` is stubbed to pass; `errorRate` = pod-exit ratio; selector hard-coded to `demo-app` |
| Pipeline run history / run number | ❌ | `PipelineStatus.LastExecutionID` = constant `"run-<name>"` |
| Per-step timings | ⚠️ | `StepStatus.StartedAt/CompletedAt`, current run only, retries collapse into one span |
| Per-step resource requests / CPU-minutes | ❌ | `CreateStepJob` (`engine/workflow.go:372`) sets no resources |
| Test counts / cache-hit rate | ❌ | only raw logs (`GetStepLogs`); manifest cache has no hit metric |
| Gate model + Approve/Reject | ✅ | `internal/gates/approval.go`, `ApplicationStatus.Gates`, `ApproveGate`/`RejectGate` RPCs |
| Hold mutation | ❌ | `spec.paused` short-circuit (`rollout_controller.go:164`) + `AbortRollout` annotation pattern |
| Per-resource drift detail (fields, timestamps, reasons) | ❌ | `ResourceDiff{LiveHash,DesiredHash}` in memory, flattened to `ResourceSync{Kind,Name,Namespace,Status}` |
| Ignore a drifted field | ⚠️ | `IgnoreDiff.JSONPointers`, **Application-global**, no group/kind/name scoping |
| Selective per-resource sync / JSON patch | ❌ | `SyncApplicationRequest{name,namespace}` only; `ApplyBundle` applies whole bundles |
| 6-phase lifecycle vector | ❌ | `ApplicationPhase` is a single enum (`Pending/Building/Promoting/Canarying/Verifying/Healthy/Degraded/Failed/RolledBack`) |
| Ownership / on-call / tier / runbook | ❌ | nothing in `ApplicationSpec`/`Status`; would be labels/annotations today |

---

## 10. Landmine list for implementers

1. `reconcileRolloutManagedRelease` (`release_controller.go:587`) does
   `ro.Spec = expected.Spec` every reconcile → **anything the API writes to a
   release-managed `Rollout.spec` (including `spec.paused`) is reverted.**
2. `syncApplicationGateStatus` (`release_controller.go:2881`) replaces
   `app.Status.Gates` wholesale → new `GateStatus` fields need explicit
   carry-forward in `checkApprovalGates` (`:2899`).
3. `patchPipelineStatus` (`pipeline_controller.go:101`) replaces the whole
   `Status` → any history list added there must be owned by the reconciler.
4. `requestReleaseResync` (`application_controller.go:1960`) re-runs a **terminal
   Release in place**, destroying its recorded outcome.
5. `PromoteRollout` is a no-op for `Canary` (the canary strategy never reads
   `core.PromoteAnnotation`).
6. `core.ActionRollback` is declared but never produced by any strategy.
7. `ApproveGate` hard-codes `ApprovedBy = "api"` (`server.go:709`) — the real
   principal is available from the auth interceptor and should be threaded in.
8. `internal/analysis` pod checks use the hard-coded selector
   `app.kubernetes.io/name=demo-app` (`analysis.go:179`, `:208`).
9. `AnalysisCheck.WindowSeconds` is parsed and ignored.
10. `events.Broker.publishLocal` (`broker.go:182`) silently **drops** events for
    slow subscribers — never treat the SSE stream as a complete log.
11. Redis is optional (`PAPRIKA_CACHE_BACKEND` defaults to `memory`) — do not
    make history depend on it without changing that default.
