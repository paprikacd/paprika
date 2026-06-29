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
- **Widening strict error propagation to the Sync-phase apply path.** MVP scopes SyncFail to PreSync/PostSync hook failures + Sync-phase parse/mapping errors. Sync-phase apply errors continue to be swallowed (existing behavior). Widening is a follow-up — it's a separate concern (correctness of `applyDocument`'s error contract) that affects every release, not just hook-using ones.

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
 ├─ [NEW] hooks.Classify(objs, rawDocs) → *hooks.Bucket
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

The agent (`internal/agent/server/server.go`) has a duplicated apply path. It gets the **same** `internal/engine/hooks` package (shared code) and a parallel hook-execution path. The controller-to-agent `ApplyRequest`/`ApplyResponse` are NOT enriched with hook-specific fields — see "Agent parity" below for the version-skew policy.

## Components

### `internal/engine/hooks/` (new package)

```
hooks/
  classify.go      - Classify(objs []*unstructured.Unstructured, rawDocs []byte) (*Bucket, error)
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

// Classify partitions parsed manifests into phase buckets. See the
// "Controller orchestration" section for the signature rationale (no
// re-serialization; original bytes preserved via offset tracking).
func Classify(objs []*unstructured.Unstructured, rawDocs []byte) (*Bucket, error)

// SyncDocs returns the original raw bytes for the Sync-phase (non-hook)
// documents, preserving formatting. See Classify for the byte-offset
// tracking mechanism.
func (b *Bucket) SyncDocs() []byte

// HasHooks reports whether any phase bucket (other than Sync) is non-empty.
// Used in tests; in production the controller uses bytes.Contains on the
// raw bundle as a fast pre-check before calling Classify.
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

#### Re-entrancy contract (load-bearing — read carefully)

Hooks are executed across multiple reconciles. The controller may requeue while a Job hook is still `Running`, or while waiting on a timeout. Each reconcile of `executeHooks(phase)` reads the existing `release.Status.HookStatuses` for that phase and applies the following transition table per hook (matched by `Kind/Name/Namespace/Phase`):

| Existing status | Action this reconcile |
|---|---|
| `Succeeded` | Skip. Move to next hook. |
| `Failed` | Abort. Stop processing this phase; trigger SyncFail. Do NOT re-run. |
| `Terminated` (timed out) | Abort. Stop processing this phase; trigger SyncFail. Do NOT re-run. |
| `Running` | Poll the live resource via the completion checker. Transition to `Succeeded`/`Failed`/`Terminated` (if `time.Since(StartedAt) > HookTimeoutSeconds`). Do NOT re-apply. Do NOT delete (skip BeforeHookCreation for this reconcile). |
| (no entry) | First sighting. Apply BeforeHookCreation: delete any existing live resource with same kind/name/namespace, then SSA-apply the manifest. Stamp `StartedAt=now, Status=Running`. **If `HookTimeoutSeconds == 0`, immediately mark `Succeeded` (fire-and-forget) and skip the poll.** Otherwise poll the completion checker once on this reconcile. |

Hooks within a phase are processed in YAML-declaration order. A phase is "done" when every hook has reached `Succeeded` (in which case the next phase runs) or any hook has reached `Failed`/`Terminated` (in which case SyncFail runs and the release is marked Failed).

The phase bucket is re-built by `Classify` on every reconcile from the rendered manifests — the rendered output is deterministic, so the bucket identity is stable. The `HookStatuses` slice is the durable state; `Classify` does NOT read or depend on it.

#### New method on `ReleaseReconciler`

```go
// executeHooks runs one phase's hooks in YAML-declaration order, honoring the
// re-entrancy contract above. Reads release.Status.HookStatuses for prior
// state. Mutates release.Status.HookStatuses in place (caller persists).
//
// Returns nil when the phase is fully Succeeded; returns an error when any
// hook has Failed/Terminated (triggers SyncFail in the caller). Returns
// errHookPhasePending (sentinel) when one or more hooks are still Running
// and the caller should requeue.
func (r *ReleaseReconciler) executeHooks(
    ctx context.Context,
    release *paprikav1.Release,
    dynClient dynamic.Interface,
    resources []hooks.Resource,
    phase hooks.Phase,
) error
```

`promote()` calls it before/after the existing `applyPromotedManifests`. Critically, **the existing `applyPromotedManifests` call is unchanged when there are no hooks** (fast path below), and uses the **original rendered bytes** (not re-serialized) when there are.

#### Fast path for hook-free releases

```go
// In promote(), after rendering + governance + snapshot:
if !bytes.Contains(manifests, []byte(paprikav1.HookAnnotation)) {
    // No hooks present in the bundle. Apply exactly as before; no classify
    // overhead, no re-serialization. Identical behavior to pre-hook paprika.
    return r.applyPromotedManifests(ctx, release, stage, manifests)
}

// Otherwise: classify, partition, execute phases.
```

`HookAnnotation = "argocd.argoproj.io/hook"` is a stable substring; absence in the rendered bundle guarantees no resources are hooks. `bytes.Contains` is a single-pass scan over the byte slice that's already in memory.

#### Hook path (when `bytes.Contains` is true)

```go
// Parse the bundle into []*unstructured.Unstructured ONCE. The promote()
// path already does this for governance gates (parseManifests, line 752);
// reuse that result rather than re-parsing.
objs := r.parsedManifests // from parseManifests() earlier in promote()

bucket, err := hooks.Classify(objs, manifests) // see "Classify signature" below
if err != nil { return ... }

if err := r.executeHooks(ctx, release, dynClient, bucket.PreSync, hooks.PhasePreSync); err != nil {
    if !errors.Is(err, errHookPhasePending) {
        _ = r.executeHooks(ctx, release, dynClient, bucket.SyncFail, hooks.PhaseSyncFail) // best-effort, log errors
        return fmt.Errorf("pre-sync hooks: %w", err)
    }
    // Pending: persist status, requeue. Do not proceed to Sync yet.
    return r.requeueForHookWait(release)
}

// Sync phase: pass the ORIGINAL manifests, filtered to exclude hook docs.
// No re-serialization — see "Classify signature" below.
if err := r.applyPromotedManifests(ctx, release, stage, bucket.SyncDocs()); err != nil {
    _ = r.executeHooks(ctx, release, dynClient, bucket.SyncFail, hooks.PhaseSyncFail)
    return fmt.Errorf("apply promoted manifests: %w", err)
}

if err := r.executeHooks(ctx, release, dynClient, bucket.PostSync, hooks.PhasePostSync); err != nil {
    if !errors.Is(err, errHookPhasePending) {
        _ = r.executeHooks(ctx, release, dynClient, bucket.SyncFail, hooks.PhaseSyncFail)
        return fmt.Errorf("post-sync hooks: %w", err)
    }
    return r.requeueForHookWait(release)
}
```

`requeueForHookWait` sets a requeue after `min(remaining-timeout, 10s)` — constant 10s interval for predictable test behavior; timeout is computed from `StartedAt + HookTimeoutSeconds - now`.

#### Classify signature (avoiding re-serialization)

```go
// Classify partitions parsed manifests into phase buckets. The original
// rendered bytes are passed so SyncDocs() can return the same byte slice
// (filtered to exclude hook documents) rather than re-serializing parsed
// objects. This preserves YAML comments, key order, and scalar formatting
// through the existing apply path.
//
// Implementation: promote() already calls engine.SplitYAMLDocuments(manifests)
// (helm_sdk_renderer.go:419) which returns [][]byte where each element is the
// raw (trimmed) document body sliced from the original bundle. Classify pairs
// each parsed object with its source []byte; SyncDocs concatenates the
// non-hook byte slices with "\n---\n" separators. No offset tracking or
// re-serialization — SplitYAMLDocuments already did the work.
func Classify(objs []*unstructured.Unstructured, rawDocs []byte) (*Bucket, error)

// SyncDocs returns the original raw bytes for the Sync-phase (non-hook)
// documents, preserving formatting. Built by concatenating the per-doc
// byte slices captured by Classify (via SplitYAMLDocuments).
func (b *Bucket) SyncDocs() []byte
```

The controller's existing `parseManifests` (release_controller.go:805) and the byte-splitting `engine.SplitYAMLDocuments` (helm_sdk_renderer.go:419) already produce everything Classify needs. `Classify` is a thin partitioning layer over those two existing primitives; no parser changes required.

#### SyncFail idempotency

SyncFail hooks also follow the re-entrancy contract — they're stamped into `HookStatuses` with `Phase=SyncFail`. If a reconcile requeues after SyncFail has run, the next reconcile sees the existing SyncFail entries and skips them (`Succeeded`) or aborts (`Failed`). The controller must NOT re-trigger SyncFail on a release whose `Status.Phase == Failed` — gate the entire `executeHooks` entry on `release.Status.Phase` being in a non-terminal state.

### Agent parity (`internal/agent/server/server.go`)

The agent's `Apply(ctx, req)` RPC currently applies a manifest bundle in a flat loop. Changes:

1. Import `internal/engine/hooks`.
2. In `Apply`, call `hooks.Classify(objs, req.Manifests)` after parsing (reuse the agent's existing `splitYAMLDocuments`).
3. If `bucket.HasHooks()`:
   - Run PreSync hooks via a new `s.executeHooks(...)` helper (mirror of the controller-side method).
   - Apply Sync docs (existing path — note: the agent's `applyDocument` at `server.go:134` already returns errors rather than swallowing them, so SyncFail triggers correctly for Sync-phase apply errors in agent mode).
   - Run PostSync hooks.
   - On any failure, run SyncFail hooks and return error.

**RPC version-skew policy:** the controller-to-agent `ApplyRequest` and `ApplyResponse` are NOT enriched with hook-specific fields. The existing `ApplyRequest.Manifests []byte` field already carries the full bundle — the agent re-runs `Classify` itself. The new `ApplyResponse.HookStatuses` field is OPTIONAL: old agents that don't populate it leave the slice empty; the controller treats an empty slice from agent mode as "hooks not observed remotely, trust the controller-side classify" and stamps `HookStatuses` from its own classification (controller mode is the source of truth for status). New agents populate it; controller trusts agent-reported statuses in that case.

This means **agent and controller must be on versions that both understand hooks, but the controller can deploy safely to old agents** — old agents simply apply the bundle as a flat list (which is the existing buggy-but-not-worse behavior). New agents do proper phase execution.

### Conftest / governance gates see hook resources (intentional)

`promote()` parses manifests ONCE for governance (parseManifests at line 752) BEFORE Classify runs. This means conftest policy + governance validation runs against the full bundle including hook resources. **This is the intended behavior** — policies like "deny privileged containers" should apply to hook Jobs too. The classify step uses the same parsed slice. A future reader should not "fix" this by excluding hooks from governance.

### Type-name collision (intentional decoupling)

Two types are named `HookStatus`:
- `paprikav1.HookStatus` (in `api/pipelines/v1alpha1/release_types.go`) — the CRD status field.
- `hooks.HookStatus` (in `internal/engine/hooks/`) — the engine-level execution-state constants (`Running`/`Succeeded`/`Failed`/`Terminated`).

These are deliberately separate to keep the API package decoupled from the engine package. The controller has an explicit conversion boundary in `executeHooks`: the engine returns `hooks.HookStatus` constants; the controller maps them to `paprikav1.HookStatus` strings when stamping `release.Status.HookStatuses`. The mapping is trivial (string identity — the values match). Tests should pin both ends of the conversion.

### Diff/engine integration

`ScalableDiffEngine.ComputeDiff` (in `internal/engine/scalable_diff.go`) currently lists all resources with the `app.paprika.io/managed-by=paprika,app.paprika.io/name=<app>` selector and compares against the desired set. With hooks, the desired set will include hook resources (because paprika still applies them) but those should NOT appear in the diff or the prune set.

Fix: in `ComputeDiff`, after fetching live + building desired, filter out any resource whose annotations include `argocd.argoproj.io/hook`. Filter both sides (desired and live) so the diff is consistent. This is a small change localized to the diff engine.

Application controller's `convertDiffToResourceSyncs` (application_controller.go line 1164) automatically inherits the filtering because the diff engine returns a filtered set.

### Cleanup-on-release-delete

Existing `cleanupManagedResources` (release_controller.go line 1575) lists resources by `paprika.io/release=<release.Name>` selector. As noted in the audit, this label is NOT stamped on deployed resources today, so cleanup is effectively scoped to ConfigMaps + Release-children. Hooks inherit the same `app.paprika.io/managed-by=paprika` label as Sync docs, so any future cleanup that switches to that selector (orthogonal work) will catch hooks too. MVP does not change cleanup behavior.

## Error semantics

**Two paths, two contracts:**

- **`applyDocument` (controller, Sync-phase)** at `release_controller.go:1179` returns `(false, nil)` on apply errors. The loop continues, the Release still reaches Complete. MVP **does not change this** — it's a pre-existing footgun that affects every release, not just hook-using ones, and fixing it is in the non-goals list above (deferred).
- **`applyHookDocument` / `executeHooks`** (new) propagates the first error encountered. This is what triggers SyncFail.

**Note:** the agent's `applyDocument` (`server.go:134`) already returns errors rather than swallowing them, and accumulates them in `resp.Errors` (`:87-90`). So SyncFail correctly fires on Sync-phase apply errors when running through agent mode. The asymmetry is documented and intentional.

**`hook=Sync` annotation in MVP:** ArgoCD treats `argocd.argoproj.io/hook=Sync` as a real hook phase (a hook applied during sync WITH completion-wait). MVP does NOT — `Classify` treats an explicit `hook=Sync` annotation the same as no annotation: the resource lands in `PhaseSync` and is applied via the existing `applyPromotedManifests` path with no completion wait. This is a documented divergence from ArgoCD. If a chart uses `hook=Sync` AND needs completion-wait, MVP won't honor it (the resource is applied as a normal Sync doc). Deferred to a follow-up.

## Status reporting

`HookStatuses` is written to `Release.Status` as the phase runs. Each hook's entry is stamped `Running` when applied, then updated to `Succeeded`/`Failed`/`Terminated` when the completion checker returns done. The Application controller propagates `HookStatuses` to `Application.Status` at `application_controller.go:1111-1113` (in the `evaluateDiff` / status-patch block) by copying from the active Release when one is set (`release.Status.HookStatuses` → `app.Status.HookStatuses`). The copy is unconditional when an active Release exists; on no active Release, the field is left empty.

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
  - `argocd.argoproj.io/hook=Sync` (explicit) → in Sync only (NOT a real hook phase in MVP — divergence from ArgoCD, pinned by test).
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
| Existing Helm charts without hooks silently regress | `bytes.Contains(manifests, []byte(HookAnnotation))` fast pre-check: if the substring is absent (the common case), the new code path is skipped entirely and `applyPromotedManifests` receives the original bytes — byte-identical to pre-hook paprika. False positives (substring appears in a ConfigMap data value, comment, or CRD description) take the slow path; `Classify` correctly determines there are no real hooks, all docs land in Sync, and `SyncDocs()` returns the reconstituted bytes (semantically identical to the original, separated by normalized `---` separators). |
| Completion-wait blocks the reconcile loop | Timeouts via `HookTimeoutSeconds`. The reconcile returns and requeues; on requeue, the controller re-enters `executeHooks` and observes existing HookStatuses to resume waiting (state machine pattern). |
| Status field inflation on Release | `HookStatuses` is bounded by the number of hooks in a chart (typically <10). No pagination needed for MVP. |
| Hook Job hangs forever | `HookTimeoutSeconds` (default 300s) terminates the wait; the hook is marked `Terminated` and the release goes Failed. |

## References

- Plan reference (rollout-correctness): `docs/superpowers/plans/2026-06-28-rollout-correctness-bugs.md` — same execution model (chunked, TDD, subagent-driven).
- ArgoCD hook docs: https://argo-cd.readthedocs.io/en/stable/user-guide/hooks/
- Apply path audit: stored in this session's explore-agent output; key files cited inline above.
