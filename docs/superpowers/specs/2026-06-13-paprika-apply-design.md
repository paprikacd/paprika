# `paprika apply -f` — Intelligent Kubernetes Apply

**Date:** 2026-06-13  
**Status:** Draft  
**Author:** Kimi Code (brainstorming session)  

## 1. Overview

This design adds a `paprika apply -f` command that reimagines `kubectl apply -f` as an intelligent, platform-aware deployment operation. The CLI accepts raw Kubernetes YAML, Kustomize directories, or Helm charts, renders them locally, submits the resulting manifest bundle to the Paprika API server, and watches the rollout in an interactive TUI until the application reaches a terminal state.

Behind the command, Paprika creates an `Application` CR, a versioned `Release` CR, and a snapshot ConfigMap. The existing operator applies the manifests, evaluates built-in policies, monitors health, and provides a grouped application view in the UI.

## 2. Goals & Non-Goals

### Goals
- Provide a `kubectl apply`-like UX that is immediately tracked by Paprika.
- Support raw YAML, Kustomize, and Helm inputs with auto-detection.
- Create a versioned `Release` per apply so history, rollback, and diff are first-class.
- Add a built-in policy engine (`Policy` CRD) for pre-apply validation, with configurable enforce/warn actions.
- Deliver an interactive CLI TUI that shows rendering, policy results, resource health, and rollout progress.
- Surface applied resources in the existing dashboard as a grouped Application.

### Non-Goals
- Replace `kubectl` for imperative debugging or port-forwarding.
- Implement a full admission webhook in the first cut (server-side policy evaluation in the API handler is sufficient).
- Support external manifest snapshot storage in MVP (ConfigMap only; large-bundle storage is Phase 3).
- Re-implement Helm or Kustomize rendering libraries from scratch; we shell out or use existing SDKs.

## 3. User Experience

### 3.1 Command surface

```bash
paprika apply -f <path> [-f <path> ...] \
  [-n namespace] \
  [--name my-app] \
  [--skip-policy no-latest-tag] \
  [--policy-override require-labels=warn] \
  [--dry-run] \
  [--wait] \
  [--timeout 300]
```

| Flag | Description |
|------|-------------|
| `-f, --file` | File, directory, or archive. Repeatable. |
| `-n, --namespace` | Target namespace (defaults to kubeconfig context or CLI config). |
| `--name` | Application name. Derived from first manifest name or directory name if omitted. |
| `--skip-policy` | Skip a named `Policy` for this apply. |
| `--policy-override` | Override a policy action for this apply (`enforce` or `warn`). |
| `--dry-run` | Render and evaluate policies without mutating the cluster. |
| `--wait` | Block and show TUI until terminal phase (default `true`; `--wait=false` returns after submission). |
| `--timeout` | Watch timeout in seconds (default `300`). |
| `--set` | Helm value override (`--set key=value`). Repeatable. Phase 2. |
| `--values` | Path to Helm values file. Repeatable. Phase 2. |

### 3.2 Input detection

The CLI inspects each `-f` path and renders it into a single YAML bundle:

| Input | Detection | Render step |
|-------|-----------|-------------|
| `.yaml`/`.yml` file | extension | read raw YAML (Phase 1) |
| Plain directory of YAMLs | default | concatenate all `.yaml` files (Phase 1) |
| Directory with `kustomization.yaml` | file presence | `kustomize build <dir>` (Phase 2) |
| Directory with `Chart.yaml` | file presence | `helm template <dir>` (Phase 2) |
| `.tgz`/`.tar.gz` | extension | `helm template <archive>` (Phase 2) |

Multiple inputs are concatenated with `\n---\n` separators. Helm values are passed with `--set` and `--values` flags. When multiple `-f` paths include Helm charts, the same `--set`/`--values` are applied to all of them; per-chart values require separate `paprika apply` invocations.

### 3.3 CLI flow

1. **Render:** CLI detects input type and produces a manifest bundle.
2. **Submit:** CLI sends `ApplyBundle` RPC to the Paprika API server.
3. **Policy check:** Server evaluates `Policy` CRDs against the bundle.
4. **Create resources:** Server creates/updates `Application`, `Stage`, manifest ConfigMap, and `Release`.
5. **Watch:** CLI polls `GetApplication` and renders a TUI until the rollout is terminal.
6. **Report:** CLI exits `0` on success, `1` on failure, printing the final state and any warnings.

### 3.4 TUI screens

The CLI uses [Bubble Tea](https://github.com/charmbracelet/bubbletea) for interactive mode.

**Submitting phase:**

```
Paprika Apply
━━━━━━━━━━━━━
Rendering manifests...          ✓ 12 resources
Evaluating policies...          ✓ 1 warning
Creating Application my-app...  ✓
Creating Release my-app-release-abc12d7... ✓
```

**Watching phase:**

```
my-app  •  namespace: dev  •  phase: Promoting  •  health: Progressing

Resources:
KIND          NAME            NAMESPACE   STATUS      HEALTH
Deployment    nginx           dev         Applied     Progressing  2/3 ready
Service       nginx           dev         Applied     Healthy
ConfigMap     nginx-config    dev         Applied     Healthy

Policies:
NAME                SEVERITY   ACTION   RESULT
require-labels      warning    warn     passed
no-latest-tag       critical   enforce  passed

Events:
[14:32:01] Applied Deployment/nginx
[14:32:03] Deployment/nginx: 2/3 replicas ready
```

**Terminal success:**

```
✓ my-app is Healthy

Resources applied: 3
Policies passed:   2
Warnings:          0
Duration:          12s
```

**Non-TTY fallback:** plain polling output with timestamped phase lines, suitable for CI.

## 4. Architecture

```
┌─────────────┐     render      ┌─────────────────────┐
│  paprika    │ ──(helm/kustomize)──▶│  manifest bundle    │
│  apply -f   │                   └──────────┬──────────┘
│  (CLI)      │                              │
└──────┬──────┘                              ▼
       │                         ┌─────────────────────┐
       │  ApplyBundle RPC        │  Policy evaluation  │
       │  + bundle + namespace   │  (Policy CRDs)      │
       ▼                         └──────────┬──────────┘
┌─────────────────────┐                    │
│   Paprika API       │◀──── block/warn    │
│   server            │                    ▼
└──────────┬──────────┘         ┌─────────────────────┐
           │                     │  Application CR     │
           │  create/update      │  Release CR         │
           ▼                     │  (manifest snapshot)│
┌─────────────────────┐          └──────────┬──────────┘
│  Kubernetes API     │                     │
│  (etcd)             │◀────────────────────┘
└──────────┬──────────┘
           │
           │ watch/own
           ▼
┌─────────────────────┐
│  Paprika operator   │
│  - Release ctrl     │── apply manifests ──▶ cluster
│  - Health eval      │◀── resource state ── cluster
│  - Diff engine      │
└─────────────────────┘
```

The CLI is a smart renderer and watcher; the platform owns policy enforcement, versioning, apply, health, and rollback.

## 5. CRDs & API

### 5.1 `Policy` CRD (`policy.paprika.io/v1alpha1`)

A reusable policy evaluated against rendered manifests before apply.

> **Note on API group:** `Policy` is placed in a dedicated `policy.paprika.io` group to keep policy lifecycle independent of application APIs. The CRD is **cluster-scoped** so platform teams can define global guardrails.
>
> Scaffolding required:
> - `api/policy/v1alpha1/policy_types.go`
> - `api/policy/v1alpha1/groupversion_info.go` with `GroupName = "policy.paprika.io"`
> - `api/policy/v1alpha1/zz_generated.deepcopy.go` via `make generate`
> - `config/crd/bases/policy.paprika.io_policies.yaml` via `make manifests`
> - Registration in `cmd/main.go`:
>   ```go
>   policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
>   utilruntime.Must(policyv1alpha1.AddToScheme(scheme))
>   ```
>
> The API server also builds a separate scheme in `cmd/main.go` for API-only mode (`createAPIClient`). Register `policyv1alpha1.AddToScheme(apiScheme)` there as well, or refactor API mode to share the operator scheme.
>
> If the new group proves too heavy, it can be folded into `pipelines.paprika.io` later.

```yaml
apiVersion: policy.paprika.io/v1alpha1
kind: Policy
metadata:
  name: no-latest-tag
spec:
  description: "Container images must have an explicit tag that is not 'latest'"
  severity: critical          # critical | warning
  defaultAction: enforce      # enforce | warn
  match:
    apiGroups: ["apps", ""]    # empty string = core group; empty list = all groups
    kinds: ["Deployment", "DaemonSet", "StatefulSet", "ReplicaSet", "Pod", "Job"]
    namespaces: []             # empty = all namespaces
    labelSelector:             # nil or empty matchLabels = match all resources
      matchLabels:
        app.paprika.io/managed-by: paprika
  expression: |
    object.spec.template.spec.containers.all(c,
      c.image.matches('^.+:[^:]+$') && c.image != 'latest'
    )
```

**Fields:**
- `description`: human-readable explanation.
- `severity`: intrinsic classification (`critical` or `warning`).
- `defaultAction`: default behavior when matched (`enforce` or `warn`).
- `match`: which resources the policy applies to.
  - `apiGroups`: list of API groups to match; empty = all groups.
  - `kinds`: list of resource kinds; empty = all kinds.
  - `namespaces`: list of namespaces; empty = all namespaces.
  - `labelSelector`: standard `metav1.LabelSelector`; nil/empty = match all resources.
- `expression`: CEL expression returning a boolean. `true` = pass, `false` = violation.

**CEL variables available:**
- `object` — full manifest as a map (defaults to `{}`).
- `kind`, `apiVersion` — strings (defaults to `""`).
- `name`, `namespace` — strings (defaults to `""`).
- `labels`, `annotations` — maps (default to `{}`).
- `spec` — `object.spec` (defaults to `{}`).

If a variable is not present in a manifest, the evaluator supplies the default so expressions do not error on missing keys.

**Policy result object:**

```yaml
name: no-latest-tag
severity: critical
action: enforce
passed: false
message: "Deployment/nginx uses image 'nginx:latest'"
```

**Go types (`api/policy/v1alpha1/policy_types.go`):**

```go
type PolicySeverity string
const (
    PolicySeverityCritical PolicySeverity = "critical"
    PolicySeverityWarning  PolicySeverity = "warning"
)

type PolicyAction string
const (
    PolicyActionEnforce PolicyAction = "enforce"
    PolicyActionWarn    PolicyAction = "warn"
)

type PolicyMatch struct {
    APIGroups     []string               `json:"apiGroups,omitempty"`
    Kinds         []string               `json:"kinds,omitempty"`
    Namespaces    []string               `json:"namespaces,omitempty"`
    LabelSelector *metav1.LabelSelector  `json:"labelSelector,omitempty"`
}

type PolicySpec struct {
    Description   string         `json:"description,omitempty"`
    Severity      PolicySeverity `json:"severity"`
    DefaultAction PolicyAction   `json:"defaultAction,omitempty"`
    Match         PolicyMatch    `json:"match"`
    Expression    string         `json:"expression"`
}

// DefaultAction is optional. If empty, the evaluator defaults to enforce for critical and warn for warning.

type PolicyStatus struct {
    // Phase 3: last evaluation summary
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Cluster
// +kubebuilder:subresource:status

type Policy struct { ... }
```

### 5.2 Action resolution

Precedence (highest wins):
1. Per-apply override (`--policy-override`).
2. Policy `spec.defaultAction`.
3. Default derived from severity (`critical` → `enforce`, `warning` → `warn`).

**Apply decision:**
- Any matching policy with `action: enforce` that fails → **blocked**. No resources created.
- Any matching policy with `action: warn` that fails → **not blocked**, warnings returned and stored.
- All enforced policies pass → proceed.

### 5.3 Protobuf additions

Add to `proto/paprika/v1/api.proto`:

```protobuf
message ApplyBundleRequest {
  string namespace = 1;
  string name = 2;
  bytes manifests = 3;
  repeated string skip_policies = 4;
  map<string, string> policy_overrides = 5; // policy name -> "enforce" | "warn"
  bool dry_run = 6;
}

message ApplyBundleResponse {
  Application application = 1;
  Release release = 2;
  repeated PolicyResult policy_results = 3;
  bool blocked = 4;
  string block_reason = 5;
}

message PolicyResult {
  string name = 1;
  string severity = 2;
  string action = 3;
  bool passed = 4;
  string message = 5;
}

// Extend ApplicationSource
message ApplicationSource {
  // ... existing fields 1-11 ...
  InlineSource inline = 12;
}

message InlineSource {
  string config_map_ref = 1;
}

// Extend Release
message Release {
  // ... existing fields 1-8 ...
  ManifestSource manifest_source = 9;
  repeated PolicyResult policy_results = 10;
}

message ManifestSource {
  string config_map_ref = 1;
}

rpc ApplyBundle(ApplyBundleRequest) returns (ApplyBundleResponse);
```

**Converter updates:** Update `convertRelease` in `internal/api/server.go` to map `ManifestSource` and `PolicyResults` to the protobuf `Release`. Update `convertApplication` to populate `Source.Inline`. Add a `convertPolicyResults` helper.

### 5.4 `Release` inline manifest source

Extend `ReleaseSpec` and `ReleaseStatus`:

```go
type ManifestSource struct {
    ConfigMapRef string `json:"configMapRef,omitempty"`
}

type ReleasePolicyResult struct {
    Name     string `json:"name"`
    Severity string `json:"severity"`
    Action   string `json:"action"`
    Passed   bool   `json:"passed"`
    Message  string `json:"message,omitempty"`
}

type ReleaseSpec struct {
    // existing fields...
    ManifestSource *ManifestSource `json:"manifestSource,omitempty"`
}

type ReleaseStatus struct {
    // existing fields...
    PolicyResults []ReleasePolicyResult `json:"policyResults,omitempty"`
}
```

`ReleasePolicyResult` mirrors the protobuf `PolicyResult`. `convertRelease` in `internal/api/server.go` maps between them.

The `ApplyBundle` handler creates a ConfigMap in the **same namespace as the Release/Application**:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-app-release-abc12d7-1778847600-manifests
  namespace: dev
  labels:
    app.paprika.io/managed-by: paprika
    app.paprika.io/name: my-app
    app.paprika.io/release: my-app-release-abc12d7-1778847600
    app.paprika.io/history: "true"
  ownerReferences:
    - apiVersion: pipelines.paprika.io/v1alpha1
      kind: Release
      name: my-app-release-abc12d7-1778847600
      uid: <release-uid>
      controller: true
data:
  manifests.yaml: |
    # full bundle
```

The `Release` references it:

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Release
metadata:
  name: my-app-release-abc12d7-1778847600
  namespace: dev
spec:
  target: my-app-default
  pipeline: ""
  manifestSource:
    configMapRef: my-app-release-abc12d7-1778847600-manifests
status:
  renderedManifestSnapshot: my-app-release-abc12d7-1778847600-manifests
  policyResults:
    - name: no-latest-tag
      severity: critical
      action: enforce
      passed: true
```

### 5.5 Unique Release names

Each apply creates a new `Release`:

```
{app}-release-{short-sha}-{timestamp}
```

where `short-sha` is the first 7 characters of the manifest bundle SHA-256 and `timestamp` is the Unix seconds of creation (e.g., `my-app-release-abc12d7-1778847600`). The full SHA is stored in an annotation on the Release for diff and history lookup. This guarantees uniqueness even when re-applying the same bundle.

The `ApplyBundle` handler updates the Application’s `status.releaseRef` to the new Release using an optimistic-lock patch. The previous Release is marked `Superseded` if it is in a terminal phase.

### 5.6 `Application` inline source

Add a new source type and sub-spec:

```go
const SourceTypeInline = "inline"

type InlineSourceSpec struct {
    ConfigMapRef string `json:"configMapRef,omitempty"`
}
```

Update the `ApplicationSource` enum and struct:

```go
// +kubebuilder:validation:Enum=git;helm;s3;oci;inline

type ApplicationSource struct {
    // ... existing fields ...
    Inline *InlineSourceSpec `json:"inline,omitempty"`
}
```

(Add `SourceTypeInline` to the existing source-type constants alongside `SourceTypeGit`, `SourceTypeHelm`, etc.)

Example:

```yaml
spec:
  source:
    type: inline
    inline:
      configMapRef: my-app-release-abc12-manifests
  stages:
    - name: default
      ring: 1
```

For `apply -f`, the `ApplyBundle` handler pre-creates the auto-generated `default` Stage. The Application controller skips Template creation for inline sources and watches the Release created by the handler.

## 6. Policy Engine

Create a new `policy/` package:

```go
type Evaluator interface {
    Evaluate(ctx context.Context, bundle []byte, opts EvaluateOptions) (*EvaluationResult, error)
}

type EvaluateOptions struct {
    Namespace       string
    ApplicationName string
    SkipPolicies    []string
    PolicyOverrides map[string]PolicyAction
}

type EvaluationResult struct {
    Passed  bool
    Results []PolicyResult
    Blocked bool
    Message string
}
```

**Implementation:**
1. List `Policy` CRDs from the API server.
2. For each manifest document, check `match.kinds`, `match.namespaces`, and `match.labelSelector`.
3. Skip policies named in `SkipPolicies`.
4. Evaluate matching policies using CEL.
5. Apply overrides from `PolicyOverrides`.
6. Return aggregated results.

The evaluator is invoked by the `ApplyBundle` handler before any mutating operation. On `dry-run`, it evaluates and returns without creating resources.

## 7. Controller Changes

### 7.1 `ApplyBundle` handler (`internal/api/server.go`)

1. Validate namespace exists (or can be created) and derive app name.
2. Render policy evaluator inputs from the bundle.
3. Run policy evaluator.
4. If blocked, return violations without mutating cluster state.
5. Compute the unique Release name and snapshot ConfigMap name.
6. Create or update the `Application` CR with optimistic lock:
   - Set `spec.source.type = "inline"` and `spec.source.inline.configMapRef` to the snapshot name.
   - Ensure `spec.stages` contains one auto-generated stage `default` with `ring: 1`.
7. Create or update the auto-generated `Stage` CR.
8. Create the unique `Release` CR with:
   - `ownerReference` to the `Application`.
   - `spec.target` pointing to the auto-generated Stage.
   - `spec.pipeline: ""` (inline applies do not use pipelines).
   - `spec.manifestSource.configMapRef` pre-populated with the snapshot name.
9. Inject `app.paprika.io/managed-by`, `app.paprika.io/name`, and `app.paprika.io/release` labels into the manifest bundle, then create the snapshot `ConfigMap` with an `ownerReference` to the Release.
10. Update `Application.status.releaseRef` to the new Release using optimistic lock.
11. Return Application, Release, and policy results.

**Concurrency & orphan cleanup:** Two simultaneous `ApplyBundle` calls for the same app race to update `Application.status.releaseRef`. To avoid orphan ConfigMaps and Releases:

1. Create or update the `Application` CR with an optimistic lock. For new Applications, use `Create` or server-side apply; for existing ones, use `Patch`. Only the winner proceeds; the loser retries from the top.
2. The winner creates the `Release` CR with `spec.manifestSource.configMapRef` already set.
3. The winner creates the snapshot `ConfigMap` with an `ownerReference` to the `Release`.
4. The winner patches `Application.status.releaseRef` with an optimistic lock.

If the final status patch fails, the handler deletes the Release it just created; Kubernetes garbage-collects the ConfigMap via the `ownerReference`. The handler then retries from step 1.

### 7.2 Release controller

Modify `promote()` in `release_controller.go` to branch when `manifestSource` is set:

```go
func (r *ReleaseReconciler) promote(ctx context.Context, release *paprikav1.Release) error {
    stage, err := r.fetchStage(ctx, release)
    if err != nil {
        return err
    }

    var manifests []byte
    if release.Spec.ManifestSource != nil && release.Spec.ManifestSource.ConfigMapRef != "" {
        manifests, err = r.loadManifestsFromConfigMap(ctx, release)
        if err != nil {
            return fmt.Errorf("load inline manifests: %w", err)
        }
        release.Status.RenderedManifestSnapshot = release.Spec.ManifestSource.ConfigMapRef
    } else {
        templates, err := r.fetchTemplates(ctx, release)
        if err != nil {
            return err
        }
        params := r.buildPromoteParams(release)
        manifests, err = r.TemplateRenderer.RenderAll(ctx, templates, params)
        if err != nil {
            return fmt.Errorf("template rendering failed: %w", err)
        }
        snapshotName := stage.Name + "-manifest-snapshot"
        if err := r.storeManifestSnapshot(ctx, release, stage, snapshotName, manifests); err != nil {
            return fmt.Errorf("store manifest snapshot: %w", err)
        }
        release.Status.RenderedManifestSnapshot = snapshotName
    }

    if err := r.applyPromotedManifests(ctx, release, stage, manifests); err != nil {
        return err
    }
    return nil
}
```

`loadManifestsFromConfigMap` reads the `manifests.yaml` key from the referenced ConfigMap in the Release namespace.

> **Snapshot namespace unification:** All manifest snapshots (both template-rendered and inline) are stored in the **Release namespace** (target namespace), not the operator namespace. Update `storeManifestSnapshot`, `cleanup`, and `rollback` to use `release.Namespace` consistently.

**Resource labeling for cleanup:** Because the snapshot ConfigMap already contains manifests with `app.paprika.io/release: <release-name>` injected at snapshot creation time, `applyDocument()` does not need to mutate labels at apply time. `cleanup()` selects resources by the `app.paprika.io/release` label. To support arbitrary resource kinds in inline bundles, `cleanup()` discovers GVRs dynamically from the snapshot manifest instead of using the hard-coded `managedGVRs` list.

### 7.3 Application controller

Changes to `application_controller.go`:

1. In `reconcileApp`, skip `reconcileTemplate` when `app.Spec.Source.Type == "inline"`:
   ```go
   if app.Spec.Source.Type != paprikav1.SourceTypeInline {
       if err := r.reconcileTemplate(ctx, app); err != nil { ... }
   }
   ```

2. In `buildStageSpec`, pass an empty `Templates` list for inline sources:
   ```go
   Templates: []string{}, // inline sources do not use Templates
   ```

3. In `checkSourceChanged`, short-circuit for inline sources. The source hash is the manifest bundle SHA stored on the Release/ConfigMap; change detection is driven by new Release creation rather than polling.

4. In `reconcileRelease`, short-circuit inline sources when `status.releaseRef` is empty:
   ```go
   if app.Spec.Source.Type == paprikav1.SourceTypeInline && app.Status.ReleaseRef == "" {
       r.updatePhase(ctx, app, paprikav1.ApplicationPending, "AwaitingInlineRelease", "waiting for ApplyBundle to create release")
       return ctrl.Result{RequeueAfter: defaultRequeue}, nil
   }
   ```
   This prevents the controller from auto-creating a Release with no `manifestSource`.

### 7.4 Diff & health

For inline sources, `evaluateDiff` loads the current Release’s manifest ConfigMap and uses it as desired state. Resource health already works via the existing `evaluateResourceHealth` path.

### 7.5 Rollback

The current `release_controller.go` marks a failed Release as `RolledBack` but does not re-apply a previous snapshot. For `paprika apply -f`, we implement true rollback:

1. When a Release fails and `spec.onFailure.action == "rollback"` (or a user invokes rollback via API/CLI), the controller finds the newest `Complete` Release for the same Application and Stage. If no `Complete` Release exists, it falls back to the newest non-failed, non-superseded Release that has a snapshot.
2. It reads that Release’s `status.renderedManifestSnapshot` ConfigMap.
3. It applies the snapshot manifests to the target cluster using the same dynamic-client path.
4. It marks the failing Release as `RolledBack` and records the source Release in its status.

**Ownership model:** Snapshot ConfigMaps are owned by their parent `Release`. Releases are retained for history; a janitor runs during each `Application` reconcile. It deletes the oldest `Superseded` Releases once an Application has more than `N` total Releases (default `10`). Deleting a Release cascades to its snapshot ConfigMap. The active Release (`Application.status.releaseRef`) and the most recent non-superseded Release are always protected so rollback has a target. The janitor emits a Kubernetes Event for each deletion.

**Rollback state machine:**
1. `handleFailedRollback()` finds the newest non-failed, non-superseded Release for the same Application and Stage.
2. It loads that Release’s `status.renderedManifestSnapshot` ConfigMap.
3. It applies the snapshot manifests to the target cluster via `applyManifestsForCluster()`.
4. It sets the failing Release to `ReleaseRolledBack` and records `rolledBackTo: <previous-release>`.
5. It patches `Application.status.releaseRef` back to the previous Release so the Application controller treats it as the active Release again.

The UI distinguishes a rolled-back Release by its `RolledBack` phase and `rolledBackTo` field.

## 8. UI Integration

### 8.1 Application detail page

Extend the existing application view to show:
- Current Release name, phase, duration, and source.
- Release history with timestamps and rollback action.
- Managed resources table (kind, name, namespace, sync status, health).
- Per-apply policy results.
- Manifest diff against the previous Release.

### 8.2 Policies page

New page listing all `Policy` CRDs with severity, match rules, and recent evaluation results.

### 8.3 Real-time updates

The API server already exposes an SSE broker. The dashboard can subscribe for live updates. The CLI TUI can consume SSE in Phase 3, with polling in Phase 1.

## 9. Error Handling

| Scenario | Behavior |
|----------|----------|
| Policy blocks apply | CLI prints violations, exits `1`. No resources created. |
| Policy warns | CLI prints warnings, proceeds. Warnings stored in Release status. |
| Invalid YAML | CLI fails fast before RPC. |
| Apply fails mid-rollout | Release → `Failed`, Application → `Degraded`. TUI shows events. |
| Timeout waiting for health | CLI exits `1`. Controller continues reconciling. |
| Apply of existing app | New Release created; prior terminal Release marked `Superseded`. |
| Rollback | Controller applies previous Release’s snapshot ConfigMap. |
| Concurrent applies to same app | `ApplyBundle` handler uses optimistic-lock patch on `Application.status.releaseRef`. Release controller concurrency guard prevents two Releases promoting to the same Stage simultaneously. |
| Large manifest bundle | ConfigMap limit (~1 MiB). Phase 3 moves to external storage. |

## 10. RBAC

Add the following markers to the API server and Release controller:

```go
// API server
// +kubebuilder:rbac:groups=policy.paprika.io,resources=policies,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=namespaces,verbs=get;list;watch;create
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch

// Release controller (in addition to existing RBAC)
// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
```

## 11. Testing Strategy

| Level | Scope |
|-------|-------|
| **Unit** | Policy evaluator CEL expressions, input detection, Release name generation, ConfigMap loading. |
| **Integration** | `ApplyBundle` handler with fake K8s client; policy evaluation; Release controller inline path with envtest. |
| **E2E** | Kind cluster: `paprika apply -f`, assert CRs created, resources applied, TUI returns healthy, rollback works. |
| **Policy tests** | Sample policies against violating/passing manifests in `policy/testdata/`. |

## 12. Implementation Phases

### Phase 1 — Core `paprika apply -f` (raw YAML)
- `Policy` CRD and `policy` evaluator.
- `ApplyBundle` RPC, handler, and generated Go code.
- CLI `apply` command with raw YAML file/directory support.
- Unique Release names and inline manifest path in Release controller.
- True rollback path that re-applies the previous snapshot.
- Bubble Tea TUI with polling.
- Dashboard application detail enhancements.

### Phase 2 — Rich inputs
- Kustomize support (`kustomize build`).
- Helm chart support (`helm template`).
- Helm `--set` / `--values` flags.
- `paprika apply -f -` stdin support.

### Phase 3 — Advanced policy & UX
- Built-in policy library.
- Policy override config files.
- Manifest diff in UI.
- SSE streaming in CLI TUI.
- External manifest snapshot storage for large bundles.
- `--prune` support for removing resources no longer in the bundle.

## 13. Open Questions

1. Should policies be re-evaluated asynchronously by the controller after apply, or only synchronously in the `ApplyBundle` handler? (Current default: synchronous only; async re-evaluation is Phase 3.)
2. Should the CLI override `metadata.namespace` in manifests that already specify one, or only default resources without a namespace? (Current default: respect explicit namespace; only default missing ones.)
3. Should there be a maximum Release count or TTL per Application to prevent unbounded history growth? (Current default: retain last 10 Releases via janitor.)
