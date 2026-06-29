# ArgoCD-compatible Resource Hooks (MVP) — Design

## Status
Draft, 2026-06-29. Target branch: `feature/sync-hooks`.

## Goal
Paprika's release apply path is a flat, single-phase loop. Real-world Helm charts that use ArgoCD-style resource hooks (pre-install Jobs, post-sync Pods, etc.) are silently mis-applied: hooks are applied inline with the rest of the manifests, no phase ordering, no completion waiting, no deletion lifecycle. This spec adds the four most-used phases (PreSync, Sync, PostSync, SyncFail) with ArgoCD annotation compatibility, so existing Helm charts work unchanged.

## Non-goals (deferred)
- **PostDelete phase** — requires finalizer coordination; deferred.
- **`HookSucceeded` and `HookFailed` deletion policies** — require prune-on-sync; deferred. MVP supports only `BeforeHookCreation`.
- **Hook weights** (`argocd.argoproj.io/hook-weight`) — deferred. YAML declaration order is used within a phase.
- **Custom hook completion checkers** beyond Job and Pod (Argo Workflow, CronTab, etc.) — extension point left open via a registry; not implemented in MVP.
- **Prune-on-sync** — orthogonal; the diff engine already computes the `Deleted` set but paprika does not call Delete. Hooks are excluded from the diff entirely (not "managed"), so they do not interact with prune either way.

## Architecture

### Current apply path

```
ReleaseReconciler.promote(ctx, release)
 ├─ render manifests → []byte
 ├─ governance + conftest gates (parse manifests separately)
 ├─ store manifest snapshot (ConfigMap)
 ├─ applyPromotedManifests
 │    └─ applyManifestsForCluster
 │         └─ applyManifests (or applyViaAgent for remote-cluster mode)
 │              └─ applyAllDocuments  ← flat loop over [][]byte
 │                   └─ applyDocument  ← per-resource; SWALLOWS errors
 └─ patch release status (aggregate only; no per-resource status)
```

### Proposed apply path

```
ReleaseReconciler.promote(ctx, release)
 ├─ render manifests → []byte
 ├─ governance + conftest gates (unchanged)
 ├─ store manifest snapshot (unchanged)
 ├─ [NEW] hooks.Classify(manifests) → *hooks.Bucket
 │     buckets: PreSync, Sync, PostSync, SyncFail
 │     (hooks identified by `argocd.argoproj.io/hook` annotation,
 │      comma-separated values supported)
 ├─ [NEW] executeHooks(PreSync)  — wait-for-completion per kind
 ├─ applyManifests(Sync)  — existing applyAllDocuments path
 ├─ [NEW] executeHooks(PostSync) — wait-for-completion per kind
 └─ on failure of PreSync/Sync/PostSync:
        ├─ executeHooks(SyncFail)
        └─ patch release status (Phase=Failed)
```

The agent (`internal/agent/server/server.go`) has a duplicated apply path. It gets the **same** `internal/engine/hooks` package (shared code) and a parallel hook-execution path triggered by a new `ApplyRequest.Hooks` field on the existing `Apply` RPC.

## Components

### `internal/engine/hooks/` (new package)

```
hooks/
  classify.go      - Classify(docs []byte) (*Bucket, error)
  classify_test.go
  completion.go    - CompletionFunc registry + Job/Pod checkers
  completion_test.go
  doc.go           - package doc + shared annotation constants
```

**Types:**

```go
package hooks

// Phase is a hook execution phase. Matches ArgoCD semantics.
type Phase string

const (
    PhasePreSync  Phase = "PreSync"
    PhaseSync     Phase = "Sync"      // default for non-hook resources
    PhasePostSync Phase = "PostSync"
    PhaseSyncFail Phase = "SyncFail"
)

// HookStatus is the per-resource status of a hook during/after execution.
type HookStatus string

const (
    HookStatusRunning     HookStatus = "Running"
    HookStatusSucceeded   HookStatus = "Succeeded"
    HookStatusFailed      HookStatus = "Failed"
    HookStatusTerminated  HookStatus = "Terminated" // timed out or aborted
)

// Shared annotation constants (ArgoCD-compatible strings).
const (
    // HookAnnotation identifies a resource as a hook. Value is a
    // comma-separated list of phases, e.g. "PreSync,PostSync".
    // Empty value or absent annotation => Sync-phase (managed) resource.
    HookAnnotation = "argocd.argoproj.io/hook"
    // HookDeletePolicyAnnotation controls when a hook resource is deleted.
    // MVP honors only "BeforeHookCreation" (default); other values are
    // accepted but treated as no-ops until prune-on-sync lands.
    HookDeletePolicyAnnotation = "argocd.argoproj.io/hook-delete-policy"
    // HookWeightAnnotation is parsed in MVP for forward-compat but ignored
    // (YAML order is used within a phase).
    HookWeightAnnotation = "argocd.argoproj.io/hook-weight"
)

// Resource is a single parsed manifest tagged with its phase.
type Resource struct {
    Obj           *unstructured.Unstructured
    Phase         Phase
    DeletePolicy  string // raw value of HookDeletePolicyAnnotation; "" = BeforeHookCreation default
}

// Bucket is the phase-partitioned manifest set for a single release.
type Bucket struct {
    PreSync  []Resource
    Sync     []Resource
    PostSync []Resource
    SyncFail []Resource
}

// Classify parses a multi-doc YAML bundle and partitions resources into
// phase buckets. Resources without the hook annotation land in Sync. Hook
// resources are removed from Sync. Hook resources appear ONLY in their
// declared phase(s) — a hook annotated "PreSync,PostSync" appears in both.
func Classify(docs []byte) (*Bucket, error)

// HasHooks reports whether any phase bucket (other than Sync) is non-empty.
func (b *Bucket) HasHooks() bool
```

**Completion checkers:**

```go
// CompletionFunc reports whether a hook resource has reached a terminal
// state. Returns (done, succeeded, message). When done is false, the
// controller should re-check on the next reconcile. When done is true,
// succeeded indicates whether the hook succeeded; message is human-readable
// status text (typically the underlying workload's status message).
type CompletionFunc func(ctx context.Context, client dynamic.Interface, ns, name string) (done, succeeded bool, message string, err error)

// RegisterCompletionChecker registers a completion checker for a GVK string
// "group/version, Kind=kind". Job and Pod are registered by default;
// callers can add more (e.g. Argo Workflow, custom operators).
func RegisterCompletionChecker(gvk string, fn CompletionFunc)

// CompletionFor returns the registered checker for the given GVK, or nil
// (meaning "fire-and-forget" — creation is considered completion).
func CompletionFor(gvk string) CompletionFunc
```

Built-in checkers:
- `batch/v1, Kind=Job`: watches `.status.conditions` for `Complete=true` or `Failed=true`, or `.status.succeeded > 0` / `.status.failed > 0`.
- `core/v1, Kind=Pod`: `.status.phase` Succeeded/Failed.
- **Anything else**: `nil` (fire-and-forget — `Classify` time, no further wait).

### `api/pipelines/v1alpha1/release_types.go` (and application_types.go)

Add to `ReleaseStatus`:

```go
// HookStatuses tracks per-hook execution state across the four phases
// (PreSync/Sync/PostSync/SyncFail). Populated by the release controller
// as hooks run; cleared at the start of each promote.
// +optional
HookStatuses []HookStatus `json:"hookStatuses,omitempty"`
```

Where `HookStatus` is:

```go
// HookStatus is the observed state of a single hook resource.
type HookStatus struct {
    Kind        string      `json:"kind"`
    Name        string      `json:"name"`
    Namespace   string      `json:"namespace,omitempty"`
    Phase       string      `json:"phase"`       // PreSync/Sync/PostSync/SyncFail
    Status      string      `json:"status"`      // Running/Succeeded/Failed/Terminated
    StartedAt   *metav1.Time `json:"startedAt,omitempty"`
    CompletedAt *metav1.Time `json:"completedAt,omitempty"`
    Message     string      `json:"message,omitempty"`
}
```

(Using `string` instead of importing `hooks.Phase` keeps the API package decoupled from the engine package.)

Add to `SyncOptions`:

```go
// HookTimeoutSeconds is the max time to wait for any single hook to reach
// a terminal state. Default 300 (5 minutes). 0 means no wait — fire and
// forget for all hooks.
// +optional
HookTimeoutSeconds int32 `json:"hookTimeoutSeconds,omitempty"`
```

### Controller orchestration (`release_controller.go`)

New method on `ReleaseReconciler`:

```go
// executeHooks runs one phase's hooks in YAML-declaration order. Each hook:
//   - if DeletePolicy=BeforeHookCreation (default), delete any existing
//     resource with the same kind/name/namespace before applying
//   - apply via SSA (existing applyDocument path)
//   - if a CompletionFunc is registered for the GVK, wait for done (with
//     timeout from SyncOptions.HookTimeoutSeconds). Otherwise, fire-and-forget.
//
// Returns the first error encountered (which triggers SyncFail in the caller).
// Successful hook outcomes are stamped into release.Status.HookStatuses
// as the method runs.
func (r *ReleaseReconciler) executeHooks(
    ctx context.Context,
    release *paprikav1.Release,
    dynClient dynamic.Interface,
    resources []hooks.Resource,
    phase hooks.Phase,
) error
```

`promote()` calls it before/after the existing `applyPromotedManifests`:

```go
// after rendering + governance + snapshot:
bucket, err := hooks.Classify(manifests)
if err != nil { return ... }

if bucket.HasHooks() {
    if err := r.executeHooks(ctx, release, dynClient, bucket.PreSync, hooks.PhasePreSync); err != nil {
        r.executeHooks(ctx, release, dynClient, bucket.SyncFail, hooks.PhaseSyncFail) // best-effort
        return fmt.Errorf("pre-sync hooks: %w", err)
    }
}

if err := r.applyPromotedManifests(ctx, release, stage, bucket.SyncDocs()); err != nil {
    if bucket.HasHooks() {
        r.executeHooks(ctx, release, dynClient, bucket.SyncFail, hooks.PhaseSyncFail) // best-effort
    }
    return fmt.Errorf("apply promoted manifests: %w", err)
}

if bucket.HasHooks() {
    if err := r.executeHooks(ctx, release, dynClient, bucket.PostSync, hooks.PhasePostSync); err != nil {
        r.executeHooks(ctx, release, dynClient, bucket.SyncFail, hooks.PhaseSyncFail) // best-effort
        return fmt.Errorf("post-sync hooks: %w", err)
    }
}
```

`Bucket.SyncDocs()` returns the Sync-phase manifests as `[]byte` (re-serialized) so `applyPromotedManifests` continues to work with its existing signature.

### Agent parity (`internal/agent/server/server.go`)

The agent's `Apply(ctx, req)` RPC currently applies a manifest bundle in a flat loop. Changes:

1. Import `internal/engine/hooks`.
2. In `Apply`, call `hooks.Classify(req.Manifests)`.
3. If `bucket.HasHooks()`:
   - Run PreSync hooks via a new `s.executeHooks(...)` helper (mirror of the controller-side method).
   - Apply Sync docs (existing path).
   - Run PostSync hooks.
   - On any failure, run SyncFail hooks and return error.
4. Add `HookStatuses []HookStatus` to the `ApplyResponse` so the controller can fold them into the Release status.

The agent already has the K8s client + RESTMapper needed for completion waits.

### Diff/engine integration

`ScalableDiffEngine.ComputeDiff` (in `internal/engine/scalable_diff.go`) currently lists all resources with the `app.paprika.io/managed-by=paprika,app.paprika.io/name=<app>` selector and compares against the desired set. With hooks, the desired set will include hook resources (because paprika still applies them) but those should NOT appear in the diff or the prune set.

Fix: in `ComputeDiff`, after fetching live + building desired, filter out any resource whose annotations include `argocd.argoproj.io/hook`. Filter both sides (desired and live) so the diff is consistent. This is a small change localized to the diff engine.

Application controller's `convertDiffToResourceSyncs` (application_controller.go line 1164) automatically inherits the filtering because the diff engine returns a filtered set.

### Cleanup-on-release-delete

Existing `cleanupManagedResources` (release_controller.go line 1575) lists resources by `paprika.io/release=<release.Name>` selector. As noted in the audit, this label is NOT stamped on deployed resources today, so cleanup is effectively scoped to ConfigMaps + Release-children. Hooks inherit the same `app.paprika.io/managed-by=paprika` label as Sync docs, so any future cleanup that switches to that selector (orthogonal work) will catch hooks too. MVP does not change cleanup behavior.

## Error semantics

Critical change: today `applyDocument` returns `(false, nil)` on apply errors — the loop continues. **For hooks this is wrong.** The new `executeHooks` propagates the first error to the caller, which triggers SyncFail and marks the release Failed.

The existing `applyAllDocuments` (Sync phase) keeps its current best-effort contract. Only hooks get strict error propagation.

## Status reporting

`HookStatuses` is written to `Release.Status` as the phase runs. Each hook's entry is stamped `Running` when applied, then updated to `Succeeded`/`Failed`/`Terminated` when the completion checker returns done. The Application controller propagates `HookStatuses` to `Application.Status` via the existing reconcile path (small change in `application_controller.go` to copy the field when it observes the active Release).

UI surfacing is out of scope for MVP — the data is available via the existing Connect-ES types (regenerated automatically).

## Testing

### Unit tests

- `hooks.Classify` (the parser):
  - No-hook bundle → all in Sync bucket.
  - PreSync-only Job → in PreSync only, NOT in Sync.
  - Multi-phase annotation `"PreSync,PostSync"` → in both phases.
  - Unknown phase value (e.g. `argocd.argoproj.io/hook=Garbage`) → in Sync (treated as non-hook).
  - Empty `argocd.argoproj.io/hook` value → in Sync (treated as non-hook).
  - SyncFail-only hooks → in SyncFail only.
  - Mixed bundle (real ArgoCD chart fixture) → bucketed correctly.

- Completion checkers:
  - Job with `.status.conditions[Complete=true]` → done, succeeded.
  - Job with `.status.conditions[Failed=true]` → done, failed.
  - Job with no conditions → not done.
  - Pod `.status.phase=Succeeded` → done, succeeded.
  - Pod `.status.phase=Pending` → not done.

### envtest (controller)

- `RolloutReconciler hooks` Describe block:
  1. PreSync Job + Sync Deployment + PostSync Pod → all three phases run in order, Release reaches Healthy.
  2. PreSync Job fails → Sync docs NOT applied, SyncFail hook runs, Release = Failed.
  3. PreSync Job times out → Release = Failed, HookStatus = Terminated.
  4. Pod PostSync hook with `.status.phase=Failed` → Release = Failed.
  5. BeforeHookCreation: second reconcile deletes prior hook Job before creating the new one.

### envtest (agent)

- Apply RPC with a manifest bundle containing hooks → same end state as the controller-side test.

### Smoke test (manual / e2e)

- Deploy a chart from the wild that uses `argocd.argoproj.io/hook=PreSync` (e.g. many cert-manager charts, sealed-secrets, etc.) → works unchanged.

## Effort estimate

3-4 days, 6-7 commits:

1. CRD schema additions (`HookStatus`, `SyncOptions.HookTimeoutSeconds`) + annotation constants + deepcopy regen.
2. `internal/engine/hooks` package (Classify, completion checkers) + full unit tests.
3. Diff-engine integration (exclude hook resources from diff) + test.
4. Controller-side orchestration (`executeHooks`, wire into `promote`) + envtest.
5. Agent-side parity + envtest.
6. Application controller status propagation + e2e smoke test.
7. (Optional) UI surface of `HookStatuses` (deferred — not in MVP).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Agent/controller drift (duplicated apply paths) | Shared `internal/engine/hooks` package keeps classification logic single-sourced. Hook execution still has to be written twice (controller and agent) but both call into the same primitives. |
| Existing Helm charts without hooks silently regress | `bucket.HasHooks()` short-circuit: if no hook annotations are present, the new code path is skipped entirely and `applyPromotedManifests` works exactly as before. |
| Completion-wait blocks the reconcile loop | Timeouts via `HookTimeoutSeconds`. The reconcile returns and requeues; on requeue, the controller re-enters `executeHooks` and observes existing HookStatuses to resume waiting (state machine pattern). |
| Status field inflation on Release | `HookStatuses` is bounded by the number of hooks in a chart (typically <10). No pagination needed for MVP. |
| Hook Job hangs forever | `HookTimeoutSeconds` (default 300s) terminates the wait; the hook is marked `Terminated` and the release goes Failed. |

## References

- Plan reference (rollout-correctness): `docs/superpowers/plans/2026-06-28-rollout-correctness-bugs.md` — same execution model (chunked, TDD, subagent-driven).
- ArgoCD hook docs: https://argo-cd.readthedocs.io/en/stable/user-guide/hooks/
- Apply path audit: stored in this session's explore-agent output; key files cited inline above.
