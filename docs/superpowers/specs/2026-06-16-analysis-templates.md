# Analysis Templates Design

## Goal

Make Paprika analysis checks reusable, versionable, and continuously executable:

- **Reusable templates**: define analysis checks once in an `AnalysisTemplate` CRD and reference them from multiple `Application` resources.
- **Template references in Application CRD**: `Application.Spec.AnalysisTemplates` selects templates by name and supplies per-reference arguments.
- **Background analysis**: an `AnalysisRun` CRD runs the referenced checks on a schedule and reports results back to the `Application` status, enabling continuous health monitoring outside of canary promotion.

## Context

Paprika already runs analysis checks during canary promotion:

- `api/pipelines/v1alpha1/stage_types.go` defines `AnalysisCheck` and `AnalysisConfig`.
- `analysis.Analyzer` / `analysis.AnalyzerImpl` in `analysis/` executes `http` and `podMetrics` checks.
- `ReleaseReconciler.runCanaryAnalysis` calls the analyzer at each canary step and can roll back on failure.

Those checks are inline inside `CanaryConfig`. This design extracts them into standalone, reusable `AnalysisTemplate` resources and adds an `AnalysisRun` lifecycle so the same checks can run continuously after a release completes.

## API Changes

### New CRD: `AnalysisTemplate`

Create `api/pipelines/v1alpha1/analysis_template_types.go`.

```go
// AnalysisTemplateArg declares a parameter that can be supplied by referencing resources.
type AnalysisTemplateArg struct {
    Name string `json:"name"`
    // +optional
    Default string `json:"default,omitempty"`
}

// AnalysisTemplateSpec defines a reusable set of analysis checks.
type AnalysisTemplateSpec struct {
    // Args are the named parameters accepted by this template.
    // +optional
    Args []AnalysisTemplateArg `json:"args,omitempty"`
    // Checks are the analysis checks to run.
    // +optional
    Checks []AnalysisCheck `json:"checks,omitempty"`
}

// AnalysisTemplateStatus defines the observed state of an AnalysisTemplate.
type AnalysisTemplateStatus struct {
    // +optional
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:printcolumn:name="Checks",type=integer,JSONPath=".spec.checks"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

type AnalysisTemplate struct { ... }
```

`AnalysisCheck` is reused from `stage_types.go` (no duplication).

### New CRD: `AnalysisRun`

Create `api/pipelines/v1alpha1/analysis_run_types.go`.

```go
// AnalysisRunPhase represents the phase of an analysis run.
type AnalysisRunPhase string

const (
    AnalysisRunPending     AnalysisRunPhase = "Pending"
    AnalysisRunRunning     AnalysisRunPhase = "Running"
    AnalysisRunSuccessful  AnalysisRunPhase = "Successful"
    AnalysisRunFailed      AnalysisRunPhase = "Failed"
    AnalysisRunError       AnalysisRunPhase = "Error"
    AnalysisRunCompleted   AnalysisRunPhase = "Completed"
)

// AnalysisRunResult records the outcome of a single check execution.
type AnalysisRunResult struct {
    Name      string       `json:"name"`
    Passed    bool         `json:"passed"`
    Message   string       `json:"message,omitempty"`
    Detail    string       `json:"detail,omitempty"`
    CheckedAt *metav1.Time `json:"checkedAt,omitempty"`
}

// AnalysisRunSpec defines the desired state of an AnalysisRun.
type AnalysisRunSpec struct {
    // TemplateRef references the AnalysisTemplate to execute.
    TemplateRef string `json:"templateRef"`
    // ApplicationRef references the Application that owns this run.
    ApplicationRef string `json:"applicationRef"`
    // Args override template arguments.
    // +optional
    Args map[string]string `json:"args,omitempty"`
    // IntervalSeconds between consecutive analysis cycles (default 60).
    // +kubebuilder:default=60
    // +optional
    IntervalSeconds int `json:"intervalSeconds,omitempty"`
    // Count limits the number of analysis cycles. 0 or unset means indefinite.
    // +optional
    Count int `json:"count,omitempty"`
    // TerminateOnFailure stops the run after the first failed cycle.
    // +optional
    TerminateOnFailure bool `json:"terminateOnFailure,omitempty"`
}

// AnalysisRunStatus defines the observed state of an AnalysisRun.
type AnalysisRunStatus struct {
    // +optional
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`
    // +kubebuilder:validation:Enum=Pending;Running;Successful;Failed;Error;Completed
    Phase AnalysisRunPhase `json:"phase,omitempty"`
    // CyclesExecuted is the number of completed analysis cycles.
    // +optional
    CyclesExecuted int `json:"cyclesExecuted,omitempty"`
    // +optional
    Results []AnalysisRunResult `json:"results,omitempty"`
    // +optional
    StartedAt *metav1.Time `json:"startedAt,omitempty"`
    // +optional
    CompletedAt *metav1.Time `json:"completedAt,omitempty"`
    // +optional
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=".status.phase"
// +kubebuilder:printcolumn:name="Template",type=string,JSONPath=".spec.templateRef"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

type AnalysisRun struct { ... }
```

### `ApplicationSpec` additions

In `api/pipelines/v1alpha1/application_types.go`:

```go
// AnalysisTemplateRef references an AnalysisTemplate and supplies arguments.
type AnalysisTemplateRef struct {
    Name string `json:"name"`
    // Args override template arguments.
    // +optional
    Args map[string]string `json:"args,omitempty"`
    // IntervalSeconds overrides the default analysis interval.
    // +optional
    IntervalSeconds int `json:"intervalSeconds,omitempty"`
    // OnFailure defines the action to take when the analysis fails.
    // +optional
    OnFailure *FailureAction `json:"onFailure,omitempty"`
}
```

Add to `ApplicationSpec`:

```go
    // AnalysisTemplates references reusable analysis templates that run continuously
    // in the background after the application is healthy.
    // +optional
    AnalysisTemplates []AnalysisTemplateRef `json:"analysisTemplates,omitempty"`
```

### `ApplicationStatus` additions

```go
// AnalysisResult aggregates the latest state of a single AnalysisRun for the UI/API.
type AnalysisResult struct {
    Name      string           `json:"name"`
    Phase     AnalysisRunPhase `json:"phase"`
    Passed    bool             `json:"passed"`
    Message   string           `json:"message,omitempty"`
    CheckedAt *metav1.Time     `json:"checkedAt,omitempty"`
}
```

Add to `ApplicationStatus`:

```go
    // AnalysisResults aggregate the latest background analysis state.
    // +optional
    AnalysisResults []AnalysisResult `json:"analysisResults,omitempty"`
```

## Controller Behavior

### New controller: `AnalysisRunReconciler`

Create `internal/controller/pipelines/analysisrun_controller.go`.

Responsibilities:

1. Fetch the referenced `AnalysisTemplate`.
2. Merge template args with run args (run args win).
3. Substitute simple placeholders (`{{ .args.name }}`) in check URLs / thresholds if needed; for v1 keep substitution minimal and optional.
4. Run all checks via `analysis.Analyzer`.
5. Update `AnalysisRun.Status.Results`, `Status.Phase`, `Status.CyclesExecuted`, and `Status.CompletedAt`.
6. Requeue after `IntervalSeconds` while the run is active.
7. Stop requeuing when `Count > 0` and `CyclesExecuted >= Count`, or when `TerminateOnFailure` is true and the latest cycle failed.

Allowed transitions:

| From      | To        | Condition                                      |
|-----------|-----------|------------------------------------------------|
| Pending   | Running   | template resolved                              |
| Running   | Successful| latest cycle passed                            |
| Running   | Failed    | latest cycle failed                            |
| Running   | Error     | template not found or check execution errored  |
| Running   | Completed | Count reached                                  |

The controller reports a `Ready` condition and a `Running` condition.

### Application controller integration

Add an `AnalysisRunManager` helper to the `ApplicationReconciler`:

```go
func (r *ApplicationReconciler) reconcileAnalysisRuns(ctx context.Context, app *pipelinesv1alpha1.Application) error
```

Call it in both evaluation paths:

- `reconcileReleaseFlow` after `r.evaluateResourceHealth` and before `r.reconcileSelfHeal`.
- `handleHealthyPhase` after `r.evaluateResourceHealth` and before patching status.

Behavior:

1. For each `AnalysisTemplateRef` in `app.Spec.AnalysisTemplates`, ensure a child `AnalysisRun` exists with:
   - Name derived from `app.Name + "-" + templateRef.Name + "-analysis"`.
   - Owner reference to the Application.
   - `Spec.TemplateRef`, `Spec.ApplicationRef`, `Spec.Args`, `Spec.IntervalSeconds` populated.
2. List all `AnalysisRun` objects owned by the Application.
3. Aggregate each run's latest result into `app.Status.AnalysisResults`.
4. Delete stale AnalysisRuns for templates no longer referenced.
5. If any run is `Failed` and the corresponding `AnalysisTemplateRef.OnFailure.Action == "rollback"`, annotate the current release with `paprika.io/rollback-requested` (reusing the self-healing rollback path). Set an `AnalysisFailed` condition on the Application.

Only act on `OnFailure: rollback` when the Application phase is `Healthy` or `Degraded` and the current release is `Complete`, mirroring self-heal guards.

### Parameter substitution (v1 minimal)

To keep v1 simple, the `AnalysisRunReconciler` performs literal substitution on a small set of placeholders before executing checks:

- `{{ .args.<name> }}` → value from merged args.
- `{{ .application }}` → Application name.
- `{{ .namespace }}` → Application namespace.

Only `AnalysisCheck.URL` and `AnalysisCheck.Threshold` are substituted in v1. The substitution helper lives in `analysis/` so canary analysis can reuse it later.

## Safety

- A missing `AnalysisTemplate` sets the run phase to `Error` and surfaces the error in Application status; it does not fail the Application.
- Failed background analysis does not roll back a release unless the user explicitly sets `analysisTemplates[*].onFailure.action: rollback`.
- Background analysis runs only after the release reaches `Complete` (i.e., Application phase `Healthy` or evaluation paths that are not blocked).
- The Application controller owns the AnalysisRuns, so they are garbage-collected when the Application is deleted.
- Analysis runs are rate-limited by `IntervalSeconds` and the run controller's `RequeueAfter`.

## Status Conditions

Introduce a new Application condition type:

| Type           | Status | Reason              | Meaning                                  |
|----------------|--------|---------------------|------------------------------------------|
| AnalysisFailed | True   | AnalysisRunFailed   | A background analysis run failed         |
| AnalysisFailed | False  | AnalysisRunning     | Analysis is running and healthy          |
| AnalysisFailed | False  | NoAnalysisConfigured| No analysis templates referenced         |
| AnalysisFailed | False  | AnalysisError       | Template missing or run in Error phase   |

## UI / API Impact

### Protocol Buffers

Add to `proto/paprika/v1/api.proto`:

```protobuf
message AnalysisResult {
  string name = 1;
  string phase = 2;
  bool passed = 3;
  string message = 4;
  string checked_at = 5; // RFC3339
}
```

Add `repeated AnalysisResult analysis_results = 26;` to the `Application` message and map `a.Status.AnalysisResults` in `convertApplication`.

### UI

- In `ApplicationCard`, show a compact "Analysis" indicator when `analysisResults` is non-empty (pass/fail counts and latest status).
- In `ApplicationDetailPage`, add an "Analysis Results" card listing each referenced template, its phase, latest message, and checked-at timestamp.

## Testing Plan

### Unit tests

- `analysisrun_controller_test.go`: template resolution, arg merging, count termination, terminate-on-failure, placeholder substitution.
- `application_controller_unit_test.go`: AnalysisRun creation/deletion, status aggregation, rollback annotation on analysis failure.

### Envtest tests

- Create an `AnalysisTemplate` with a passing HTTP check, reference it from an `Application`, and assert the controller creates an `AnalysisRun` and the Application status eventually shows `AnalysisResults` with `Phase=Successful`.
- Create an `AnalysisTemplate` with a failing check and `OnFailure: rollback`, assert the current release gets the `paprika.io/rollback-requested` annotation.
- Update `Application.Spec.AnalysisTemplates` and assert stale `AnalysisRun` objects are removed.

## Generated Artifacts

Run after API and proto changes:

```bash
make generate manifests
make generate-proto
```

Expected updates:

- `api/pipelines/v1alpha1/zz_generated.deepcopy.go`
- `config/crd/bases/pipelines.paprika.io_analysistemplates.yaml`
- `config/crd/bases/pipelines.paprika.io_analysisruns.yaml`
- `config/crd/bases/pipelines.paprika.io_applications.yaml`
- `charts/chart/templates/crd/applications.pipelines.paprika.io.yaml`
- `charts/chart/templates/crd/analysistemplates.pipelines.paprika.io.yaml`
- `charts/chart/templates/crd/analysisruns.pipelines.paprika.io.yaml`
- `config/rbac/role.yaml` (new RBAC for analysistemplates and analysisruns)
- `proto/paprika/v1/api.proto`
- `internal/api/paprika/v1/api.pb.go`
- `internal/api/paprika/v1/v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/*`

## Open Questions

1. Should canary `AnalysisConfig` also gain a `templateRef` field so canary checks can reuse `AnalysisTemplate`? Out of scope for this iteration but the data model should not block it.
2. Should analysis checks support Prometheus queries directly? The existing `podMetrics` check stubs `latencyP99`; extending it is a follow-up.
3. Should failing background analysis also trigger auto-sync like self-heal? Keep separate for now; only rollback is supported in v1.
