# Analysis Templates Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement reusable `AnalysisTemplate` CRDs and continuous background `AnalysisRun` checks for Paprika Applications.

**Architecture:** Add `AnalysisTemplate` and `AnalysisRun` CRDs to the `pipelines.paprika.io` group. A new `AnalysisRunReconciler` resolves a referenced template, executes its checks via the existing `analysis.Analyzer`, and updates run status. The `Application` controller ensures child `AnalysisRun` resources exist for each `analysisTemplates` entry, aggregates their latest state into `Application.Status.AnalysisResults`, and optionally requests rollback on failure. The API/UI expose analysis results on the Application resource.

**Tech Stack:** Go, Kubernetes controller-runtime, kubebuilder, Protocol Buffers (buf), Ginkgo/Gomega, envtest.

---

## Chunk 1: API Schema

### Task 1: Add `AnalysisTemplate` and `AnalysisRun` types

**Files:**
- Create: `api/pipelines/v1alpha1/analysis_template_types.go`
- Create: `api/pipelines/v1alpha1/analysis_run_types.go`
- Modify: `api/pipelines/v1alpha1/application_types.go`
- Modify: `api/pipelines/v1alpha1/groupversion_info.go` (if needed for new resource names)

- [ ] **Step 1: Create `api/pipelines/v1alpha1/analysis_template_types.go`**

```go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

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

// AnalysisTemplate represents a reusable set of analysis checks.
type AnalysisTemplate struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitzero"`

    Spec AnalysisTemplateSpec `json:"spec"`
    // +optional
    Status AnalysisTemplateStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// AnalysisTemplateList contains a list of AnalysisTemplates.
type AnalysisTemplateList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitzero"`
    Items           []AnalysisTemplate `json:"items"`
}

func init() {
    SchemeBuilder.Register(&AnalysisTemplate{}, &AnalysisTemplateList{})
}
```

- [ ] **Step 2: Create `api/pipelines/v1alpha1/analysis_run_types.go`**

```go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// AnalysisRunPhase represents the phase of an analysis run.
type AnalysisRunPhase string

const (
    // AnalysisRunPending indicates the run is waiting for the template.
    AnalysisRunPending AnalysisRunPhase = "Pending"
    // AnalysisRunRunning indicates the run is actively executing checks.
    AnalysisRunRunning AnalysisRunPhase = "Running"
    // AnalysisRunSuccessful indicates the latest cycle passed.
    AnalysisRunSuccessful AnalysisRunPhase = "Successful"
    // AnalysisRunFailed indicates the latest cycle failed.
    AnalysisRunFailed AnalysisRunPhase = "Failed"
    // AnalysisRunError indicates the run could not execute (template missing, etc.).
    AnalysisRunError AnalysisRunPhase = "Error"
    // AnalysisRunCompleted indicates the run reached its configured count.
    AnalysisRunCompleted AnalysisRunPhase = "Completed"
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
    // ObservedGeneration is the last observed generation of the spec.
    // +optional
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`
    // +kubebuilder:validation:Enum=Pending;Running;Successful;Failed;Error;Completed
    Phase AnalysisRunPhase `json:"phase,omitempty"`
    // CyclesExecuted is the number of completed analysis cycles.
    // +optional
    CyclesExecuted int `json:"cyclesExecuted,omitempty"`
    // Results are the latest check results from the most recent cycle.
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

// AnalysisRun represents an instance of an AnalysisTemplate executing for an Application.
type AnalysisRun struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitzero"`

    Spec AnalysisRunSpec `json:"spec"`
    // +optional
    Status AnalysisRunStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// AnalysisRunList contains a list of AnalysisRuns.
type AnalysisRunList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitzero"`
    Items           []AnalysisRun `json:"items"`
}

func init() {
    SchemeBuilder.Register(&AnalysisRun{}, &AnalysisRunList{})
}
```

- [ ] **Step 3: Add `AnalysisTemplateRef`, `AnalysisResult` to `application_types.go`**

Insert after `SelfHealConfig` in `application_types.go`:

```go
// AnalysisTemplateRef references an AnalysisTemplate and supplies arguments.
type AnalysisTemplateRef struct {
    // Name of the AnalysisTemplate to use.
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

// AnalysisResult aggregates the latest state of a single AnalysisRun for the UI/API.
type AnalysisResult struct {
    Name      string           `json:"name"`
    Phase     AnalysisRunPhase `json:"phase"`
    Passed    bool             `json:"passed"`
    Message   string           `json:"message,omitempty"`
    CheckedAt *metav1.Time     `json:"checkedAt,omitempty"`
}
```

Add to `ApplicationSpec` after `SelfHeal`:

```go
    // AnalysisTemplates references reusable analysis templates that run continuously
    // in the background after the application is healthy.
    // +optional
    AnalysisTemplates []AnalysisTemplateRef `json:"analysisTemplates,omitempty"`
```

Add to `ApplicationStatus` after `LastSelfHealTime`:

```go
    // AnalysisResults aggregate the latest background analysis state.
    // +optional
    AnalysisResults []AnalysisResult `json:"analysisResults,omitempty"`
```

- [ ] **Step 4: Run `go fmt`**

```bash
go fmt ./api/pipelines/v1alpha1/...
```

### Task 2: Regenerate deepcopy and CRDs

- [ ] **Step 1: Run code generation**

```bash
make generate
```

Expected: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` gains `DeepCopyInto` for `AnalysisTemplate`, `AnalysisRun`, `AnalysisTemplateRef`, `AnalysisResult`, and related structs.

- [ ] **Step 2: Run manifest generation**

```bash
make manifests
```

Expected new files:
- `config/crd/bases/pipelines.paprika.io_analysistemplates.yaml`
- `config/crd/bases/pipelines.paprika.io_analysisruns.yaml`

Expected modifications:
- `config/crd/bases/pipelines.paprika.io_applications.yaml` gains `spec.analysisTemplates` and `status.analysisResults`.
- `config/rbac/role.yaml` gains RBAC for `analysistemplates` and `analysisruns`.

- [ ] **Step 3: Regenerate Helm chart CRDs**

```bash
make helm-generate
```

Verify the chart contains the new CRDs:

```bash
git diff --stat -- charts/chart/templates/crd/
```

---

## Chunk 2: Analysis Package Enhancements

### Task 3: Add parameter substitution to analysis checks

**Files:**
- Modify: `analysis/analysis.go`
- Create: `analysis/substitute.go`

- [ ] **Step 1: Create `analysis/substitute.go`**

```go
package analysis

import (
    "bytes"
    "fmt"
    "strings"
    "text/template"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// SubstituteContext provides values for check substitution.
type SubstituteContext struct {
    Args        map[string]string
    Application string
    Namespace   string
}

// SubstituteCheck returns a copy of the check with placeholders replaced.
func SubstituteCheck(check pipelinesv1alpha1.AnalysisCheck, ctx SubstituteContext) (pipelinesv1alpha1.AnalysisCheck, error) {
    out := check
    rendered, err := substitute(check.URL, ctx)
    if err != nil {
        return out, fmt.Errorf("substituting URL: %w", err)
    }
    out.URL = rendered

    rendered, err = substitute(check.Threshold, ctx)
    if err != nil {
        return out, fmt.Errorf("substituting threshold: %w", err)
    }
    out.Threshold = rendered

    for k, v := range check.HTTPHeaders {
        rendered, err := substitute(v, ctx)
        if err != nil {
            return out, fmt.Errorf("substituting header %s: %w", k, err)
        }
        if out.HTTPHeaders == nil {
            out.HTTPHeaders = map[string]string{}
        }
        out.HTTPHeaders[k] = rendered
    }
    return out, nil
}

func substitute(input string, ctx SubstituteContext) (string, error) {
    if input == "" {
        return "", nil
    }
    if !strings.Contains(input, "{{") {
        return input, nil
    }
    tmpl, err := template.New("check").Parse(input)
    if err != nil {
        return "", err
    }
    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, ctx); err != nil {
        return "", err
    }
    return buf.String(), nil
}
```

- [ ] **Step 2: Add `SubstituteChecks` helper**

Add to `analysis/analysis.go`:

```go
// SubstituteChecks applies substitution to a slice of checks.
func SubstituteChecks(checks []pipelinesv1alpha1.AnalysisCheck, ctx SubstituteContext) ([]pipelinesv1alpha1.AnalysisCheck, error) {
    out := make([]pipelinesv1alpha1.AnalysisCheck, 0, len(checks))
    for _, c := range checks {
        rendered, err := SubstituteCheck(c, ctx)
        if err != nil {
            return nil, err
        }
        out = append(out, rendered)
    }
    return out, nil
}
```

- [ ] **Step 3: Add unit tests for substitution**

Create `analysis/substitute_test.go`:

```go
package analysis

import (
    "testing"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestSubstituteCheck(t *testing.T) {
    check := pipelinesv1alpha1.AnalysisCheck{
        Type:      "http",
        URL:       "http://{{ .application }}/{{ .args.path }}",
        Threshold: "{{ .args.threshold }}",
        HTTPHeaders: map[string]string{
            "X-Namespace": "{{ .namespace }}",
        },
    }
    ctx := SubstituteContext{
        Args:        map[string]string{"path": "health", "threshold": "99"},
        Application: "my-app",
        Namespace:   "prod",
    }
    got, err := SubstituteCheck(check, ctx)
    if err != nil {
        t.Fatalf("substitute check: %v", err)
    }
    if got.URL != "http://my-app/health" {
        t.Errorf("url: got %q, want %q", got.URL, "http://my-app/health")
    }
    if got.Threshold != "99" {
        t.Errorf("threshold: got %q, want %q", got.Threshold, "99")
    }
    if got.HTTPHeaders["X-Namespace"] != "prod" {
        t.Errorf("header: got %q, want %q", got.HTTPHeaders["X-Namespace"], "prod")
    }
}
```

- [ ] **Step 4: Run `go test ./analysis -v`**

Expected: substitution tests pass.

---

## Chunk 3: AnalysisRun Controller

### Task 4: Implement `AnalysisRunReconciler`

**Files:**
- Create: `internal/controller/pipelines/analysisrun_controller.go`

- [ ] **Step 1: Scaffold the reconciler**

```go
package controller

import (
    "context"
    "fmt"
    "strconv"
    "time"

    "github.com/benebsworth/paprika/analysis"
    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    "github.com/benebsworth/paprika/internal/observability"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/apimachinery/pkg/api/meta"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/types"
    "k8s.io/client-go/tools/record"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller"
    "sigs.k8s.io/controller-runtime/pkg/log"
)

// AnalysisRunReconciler reconciles AnalysisRun resources.
type AnalysisRunReconciler struct {
    client.Client
    Scheme        *runtime.Scheme
    Analyzer      analysis.Analyzer
    EventRecorder record.EventRecorder
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=analysisruns,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=analysisruns/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=analysisruns/finalizers,verbs=update
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=analysistemplates,verbs=get;list;watch

func (r *AnalysisRunReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    log := log.FromContext(ctx)
    log.Info("Reconciling AnalysisRun", "namespace", req.Namespace, "name", req.Name)

    var run pipelinesv1alpha1.AnalysisRun
    if err := r.Get(ctx, req.NamespacedName, &run); err != nil {
        if client.IgnoreNotFound(err) != nil {
            return ctrl.Result{}, fmt.Errorf("getting analysisrun: %w", err)
        }
        return ctrl.Result{}, nil
    }

    if err := r.reconcileRun(ctx, &run); err != nil {
        return ctrl.Result{}, err
    }

    interval := time.Duration(run.Spec.IntervalSeconds) * time.Second
    if interval <= 0 {
        interval = 60 * time.Second
    }
    return ctrl.Result{RequeueAfter: interval}, nil
}

func (r *AnalysisRunReconciler) SetupWithManager(mgr ctrl.Manager) error {
    if err := ctrl.NewControllerManagedBy(mgr).
        For(&pipelinesv1alpha1.AnalysisRun{}).
        WithOptions(controller.Options{MaxConcurrentReconciles: 5}).
        Named("analysisrun").
        Complete(r); err != nil {
        return fmt.Errorf("setting up analysisrun controller: %w", err)
    }
    return nil
}
```

- [ ] **Step 2: Implement `reconcileRun`**

```go
func (r *AnalysisRunReconciler) reconcileRun(ctx context.Context, run *pipelinesv1alpha1.AnalysisRun) error {
    template, err := r.resolveTemplate(ctx, run)
    if err != nil {
        return r.markRunError(ctx, run, "TemplateResolutionFailed", err.Error())
    }
    if template == nil {
        return r.markRunError(ctx, run, "TemplateNotFound", fmt.Sprintf("template %q not found", run.Spec.TemplateRef))
    }

    if run.Status.Phase == "" || run.Status.Phase == pipelinesv1alpha1.AnalysisRunPending {
        run.Status.Phase = pipelinesv1alpha1.AnalysisRunRunning
        if run.Status.StartedAt == nil {
            now := metav1.Now()
            run.Status.StartedAt = &now
        }
    }

    args := r.mergeArgs(template.Spec.Args, run.Spec.Args)
    checks := make([]pipelinesv1alpha1.AnalysisCheck, 0, len(template.Spec.Checks))
    for _, c := range template.Spec.Checks {
        rendered, err := analysis.SubstituteCheck(c, analysis.SubstituteContext{
            Args:        args,
            Application: run.Spec.ApplicationRef,
            Namespace:   run.Namespace,
        })
        if err != nil {
            return r.markRunError(ctx, run, "SubstitutionFailed", err.Error())
        }
        checks = append(checks, rendered)
    }

    results := r.Analyzer.RunChecks(ctx, checks)
    run.Status.Results = r.convertResults(results)
    run.Status.CyclesExecuted++

    passed := r.allPassed(results)
    if passed {
        run.Status.Phase = pipelinesv1alpha1.AnalysisRunSuccessful
    } else {
        run.Status.Phase = pipelinesv1alpha1.AnalysisRunFailed
    }

    if run.Spec.Count > 0 && run.Status.CyclesExecuted >= run.Spec.Count {
        run.Status.Phase = pipelinesv1alpha1.AnalysisRunCompleted
        now := metav1.Now()
        run.Status.CompletedAt = &now
    }

    if run.Status.Phase == pipelinesv1alpha1.AnalysisRunFailed && run.Spec.TerminateOnFailure {
        now := metav1.Now()
        run.Status.CompletedAt = &now
    }

    return r.Status().Update(ctx, run)
}

func (r *AnalysisRunReconciler) resolveTemplate(ctx context.Context, run *pipelinesv1alpha1.AnalysisRun) (*pipelinesv1alpha1.AnalysisTemplate, error) {
    var template pipelinesv1alpha1.AnalysisTemplate
    if err := r.Get(ctx, types.NamespacedName{Name: run.Spec.TemplateRef, Namespace: run.Namespace}, &template); err != nil {
        if apierrors.IsNotFound(err) {
            return nil, nil
        }
        return nil, err
    }
    return &template, nil
}

func (r *AnalysisRunReconciler) mergeArgs(templateArgs []pipelinesv1alpha1.AnalysisTemplateArg, runArgs map[string]string) map[string]string {
    out := map[string]string{}
    for _, a := range templateArgs {
        out[a.Name] = a.Default
    }
    for k, v := range runArgs {
        out[k] = v
    }
    return out
}

func (r *AnalysisRunReconciler) convertResults(results []analysis.Result) []pipelinesv1alpha1.AnalysisRunResult {
    out := make([]pipelinesv1alpha1.AnalysisRunResult, 0, len(results))
    now := metav1.Now()
    for _, r := range results {
        out = append(out, pipelinesv1alpha1.AnalysisRunResult{
            Name:      "", // populated by caller if needed
            Passed:    r.Passed,
            Message:   r.Message,
            Detail:    r.Detail,
            CheckedAt: &now,
        })
    }
    return out
}

func (r *AnalysisRunReconciler) allPassed(results []analysis.Result) bool {
    for _, res := range results {
        if !res.Passed {
            return false
        }
    }
    return len(results) > 0
}

func (r *AnalysisRunReconciler) markRunError(ctx context.Context, run *pipelinesv1alpha1.AnalysisRun, reason, message string) error {
    run.Status.Phase = pipelinesv1alpha1.AnalysisRunError
    meta.SetStatusCondition(&run.Status.Conditions, metav1.Condition{
        Type:               "Ready",
        Status:             metav1.ConditionFalse,
        Reason:             reason,
        Message:            message,
        LastTransitionTime: metav1.Now(),
    })
    return r.Status().Update(ctx, run)
}
```

Note: `AnalysisResult.Name` is left empty in the snippet above because the existing `analysis.Result` struct does not carry the check name. Extend `analysis.Result` with a `Name` field populated by `AnalyzerImpl.RunChecks`, or map results by position. Prefer adding `Name string` to `analysis.Result`.

- [ ] **Step 3: Add `Name` to `analysis.Result`**

Modify `analysis/interfaces.go`:

```go
type Result struct {
    Name    string
    Passed  bool
    Message string
    Detail  string
}
```

Modify `analysis/analysis.go` in `RunChecks` to set `r.Name = c.Name` before executing.

- [ ] **Step 4: Wire the controller in `cmd/main.go`**

Add to `setupOperatorControllers` after the notification controller:

```go
{"analysisrun", func() error {
    return (&controller.AnalysisRunReconciler{
        Client:        mgr.GetClient(),
        Scheme:        mgr.GetScheme(),
        Analyzer:      analysis.NewAnalyzer(k8sClient, operatorNamespace, mgr.GetConfig()),
        EventRecorder: mgr.GetEventRecorderFor("analysisrun-controller"),
    }).SetupWithManager(mgr)
}},
```

- [ ] **Step 5: Run `go fmt` and `go vet`**

```bash
go fmt ./...
go vet ./...
```

---

## Chunk 4: Application Controller Integration

### Task 5: Create analysis run manager helper

**Files:**
- Create: `internal/controller/pipelines/analysis_manager.go`
- Modify: `internal/controller/pipelines/application_controller.go`

- [ ] **Step 1: Create `internal/controller/pipelines/analysis_manager.go`**

```go
package controller

import (
    "context"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/meta"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    "github.com/benebsworth/paprika/engine"
)

const analysisRunNameFmt = "%s-%s-analysis"

func analysisRunName(appName, templateName string) string {
    return fmt.Sprintf(analysisRunNameFmt, appName, templateName)
}

func (r *ApplicationReconciler) reconcileAnalysisRuns(ctx context.Context, app *pipelinesv1alpha1.Application) error {
    log := log.FromContext(ctx)

    desiredRuns := map[string]bool{}
    for _, ref := range app.Spec.AnalysisTemplates {
        runName := analysisRunName(app.Name, ref.Name)
        desiredRuns[runName] = true
        if err := r.ensureAnalysisRun(ctx, app, ref, runName); err != nil {
            log.Error(err, "Failed to ensure AnalysisRun", "run", runName)
            continue
        }
    }

    if err := r.deleteStaleAnalysisRuns(ctx, app, desiredRuns); err != nil {
        log.Error(err, "Failed to delete stale analysis runs")
    }

    results, err := r.aggregateAnalysisResults(ctx, app)
    if err != nil {
        return fmt.Errorf("aggregating analysis results: %w", err)
    }
    app.Status.AnalysisResults = results

    if err := r.handleAnalysisFailure(ctx, app); err != nil {
        log.Error(err, "Failed to handle analysis failure")
    }

    r.setAnalysisCondition(app)
    return nil
}

func (r *ApplicationReconciler) ensureAnalysisRun(ctx context.Context, app *pipelinesv1alpha1.Application, ref pipelinesv1alpha1.AnalysisTemplateRef, runName string) error {
    var existing pipelinesv1alpha1.AnalysisRun
    err := r.Get(ctx, types.NamespacedName{Name: runName, Namespace: app.Namespace}, &existing)
    if client.IgnoreNotFound(err) != nil {
        return fmt.Errorf("getting analysisrun %s: %w", runName, err)
    }
    if err == nil {
        // Update spec if the reference changed.
        if existing.Spec.IntervalSeconds != ref.IntervalSeconds || existing.Spec.ArgsChanged(ref.Args) {
            existing.Spec.IntervalSeconds = ref.IntervalSeconds
            existing.Spec.Args = ref.Args
            return r.Update(ctx, &existing)
        }
        return nil
    }

    run := &pipelinesv1alpha1.AnalysisRun{
        ObjectMeta: metav1.ObjectMeta{
            Name:      runName,
            Namespace: app.Namespace,
            Labels: withProjectLabels(app, map[string]string{
                engine.ApplicationNameLabelKey: app.Name,
                "app.paprika.io/analysis-template": ref.Name,
            }),
        },
        Spec: pipelinesv1alpha1.AnalysisRunSpec{
            TemplateRef:     ref.Name,
            ApplicationRef:  app.Name,
            Args:            ref.Args,
            IntervalSeconds: ref.IntervalSeconds,
        },
    }
    if err := ctrl.SetControllerReference(app, run, r.Scheme); err != nil {
        return fmt.Errorf("setting controller reference: %w", err)
    }
    return r.Create(ctx, run)
}

func (r *ApplicationReconciler) deleteStaleAnalysisRuns(ctx context.Context, app *pipelinesv1alpha1.Application, desired map[string]bool) error {
    var list pipelinesv1alpha1.AnalysisRunList
    if err := r.List(ctx, &list,
        client.InNamespace(app.Namespace),
        client.MatchingLabels{engine.ApplicationNameLabelKey: app.Name},
    ); err != nil {
        return fmt.Errorf("listing analysis runs: %w", err)
    }
    for i := range list.Items {
        run := &list.Items[i]
        if desired[run.Name] {
            continue
        }
        if err := r.Delete(ctx, run); client.IgnoreNotFound(err) != nil {
            return fmt.Errorf("deleting analysis run %s: %w", run.Name, err)
        }
    }
    return nil
}

func (r *ApplicationReconciler) aggregateAnalysisResults(ctx context.Context, app *pipelinesv1alpha1.Application) ([]pipelinesv1alpha1.AnalysisResult, error) {
    var list pipelinesv1alpha1.AnalysisRunList
    if err := r.List(ctx, &list,
        client.InNamespace(app.Namespace),
        client.MatchingLabels{engine.ApplicationNameLabelKey: app.Name},
    ); err != nil {
        return nil, fmt.Errorf("listing analysis runs: %w", err)
    }

    results := make([]pipelinesv1alpha1.AnalysisResult, 0, len(list.Items))
    for _, run := range list.Items {
        result := pipelinesv1alpha1.AnalysisResult{
            Name:  run.Spec.TemplateRef,
            Phase: run.Status.Phase,
        }
        for _, res := range run.Status.Results {
            if res.CheckedAt != nil && (result.CheckedAt == nil || res.CheckedAt.After(result.CheckedAt.Time)) {
                result.Passed = res.Passed
                result.Message = res.Message
                result.CheckedAt = res.CheckedAt
            }
        }
        results = append(results, result)
    }
    return results, nil
}

func (r *ApplicationReconciler) handleAnalysisFailure(ctx context.Context, app *pipelinesv1alpha1.Application) error {
    if app.Status.ReleaseRef == "" {
        return nil
    }
    if app.Status.Phase != pipelinesv1alpha1.ApplicationHealthy && app.Status.Phase != pipelinesv1alpha1.ApplicationDegraded {
        return nil
    }

    var release pipelinesv1alpha1.Release
    if err := r.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &release); err != nil {
        return fmt.Errorf("fetching release for analysis failure: %w", client.IgnoreNotFound(err))
    }
    if release.Status.Phase != pipelinesv1alpha1.ReleaseComplete {
        return nil
    }
    if _, ok := release.Annotations[rollbackAnnotation]; ok {
        return nil
    }

    for _, ref := range app.Spec.AnalysisTemplates {
        runName := analysisRunName(app.Name, ref.Name)
        var run pipelinesv1alpha1.AnalysisRun
        if err := r.Get(ctx, types.NamespacedName{Name: runName, Namespace: app.Namespace}, &run); err != nil {
            continue
        }
        if run.Status.Phase != pipelinesv1alpha1.AnalysisRunFailed {
            continue
        }
        if ref.OnFailure == nil || ref.OnFailure.Action != "rollback" {
            continue
        }

        patch := client.MergeFrom(release.DeepCopy())
        if release.Annotations == nil {
            release.Annotations = map[string]string{}
        }
        release.Annotations[rollbackAnnotation] = metav1.Now().String()
        if err := r.Patch(ctx, &release, patch); err != nil {
            return fmt.Errorf("annotating release for rollback: %w", err)
        }
        r.recordEvent(app, corev1.EventTypeWarning, "AnalysisFailureRollback", fmt.Sprintf("Analysis %s failed; requested rollback", ref.Name))
        return nil
    }
    return nil
}

func (r *ApplicationReconciler) setAnalysisCondition(app *pipelinesv1alpha1.Application) {
    if len(app.Spec.AnalysisTemplates) == 0 {
        meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
            Type:               "AnalysisFailed",
            Status:             metav1.ConditionFalse,
            Reason:             "NoAnalysisConfigured",
            Message:            "No analysis templates referenced",
            LastTransitionTime: metav1.Now(),
        })
        return
    }

    hasFailed := false
    hasError := false
    for _, res := range app.Status.AnalysisResults {
        switch res.Phase {
        case pipelinesv1alpha1.AnalysisRunFailed:
            hasFailed = true
        case pipelinesv1alpha1.AnalysisRunError:
            hasError = true
        }
    }

    if hasFailed {
        meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
            Type:               "AnalysisFailed",
            Status:             metav1.ConditionTrue,
            Reason:             "AnalysisRunFailed",
            Message:            "One or more analysis runs failed",
            LastTransitionTime: metav1.Now(),
        })
        return
    }
    if hasError {
        meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
            Type:               "AnalysisFailed",
            Status:             metav1.ConditionFalse,
            Reason:             "AnalysisError",
            Message:            "One or more analysis runs are in error",
            LastTransitionTime: metav1.Now(),
        })
        return
    }

    meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
        Type:               "AnalysisFailed",
        Status:             metav1.ConditionFalse,
        Reason:             "AnalysisRunning",
        Message:            "Analysis is running",
        LastTransitionTime: metav1.Now(),
    })
}
```

Note: `ArgsChanged` helper needs to be added to `AnalysisRunSpec` or implemented inline. Implement inline with a small helper:

```go
func argsEqual(a, b map[string]string) bool {
    if len(a) != len(b) { return false }
    for k, v := range a { if b[k] != v { return false } }
    return true
}
```

- [ ] **Step 2: Wire `reconcileAnalysisRuns` into Application controller**

In `internal/controller/pipelines/application_controller.go`, in `reconcileReleaseFlow` after `r.evaluateResourceHealth` and before `r.reconcileSelfHeal`, add:

```go
    if err := r.reconcileAnalysisRuns(ctx, app); err != nil {
        log.Error(err, "Failed to reconcile analysis runs")
    }
```

In `handleHealthyPhase` after `r.evaluateResourceHealth` and before `r.reconcileSelfHeal`, add the same call.

- [ ] **Step 3: Add RBAC markers to Application controller**

Add to the RBAC block at the top of `application_controller.go`:

```go
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=analysistemplates,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=analysisruns,verbs=get;list;watch;create;update;patch;delete
```

- [ ] **Step 4: Run `go fmt` and `go vet`**

```bash
go fmt ./...
go vet ./...
```

---

## Chunk 5: Proto and API Surface

### Task 6: Extend the protobuf schema

**Files:**
- Modify: `proto/paprika/v1/api.proto`

- [ ] **Step 1: Add `AnalysisResult` message**

Insert before `message Application`:

```protobuf
message AnalysisResult {
  string name = 1;
  string phase = 2;
  bool passed = 3;
  string message = 4;
  string checked_at = 5; // RFC3339
}
```

- [ ] **Step 2: Add `analysis_results` field to `Application`**

Add to `message Application` after `conditions = 25;`:

```protobuf
  repeated AnalysisResult analysis_results = 26;
```

### Task 7: Regenerate protobuf clients

- [ ] **Step 1: Run proto generation**

```bash
make generate-proto
```

Expected updates:
- `internal/api/paprika/v1/api.pb.go`
- `internal/api/paprika/v1/v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/*`

### Task 8: Map analysis results in `convertApplication`

**Files:**
- Modify: `internal/api/server.go`

- [ ] **Step 1: Add `convertAnalysisResults` helper**

Insert near `convertHealthChecks`:

```go
func convertAnalysisResults(results []pipelinesv1alpha1.AnalysisResult) []*paprikav1.AnalysisResult {
    out := make([]*paprikav1.AnalysisResult, 0, len(results))
    for _, r := range results {
        checkedAt := ""
        if r.CheckedAt != nil {
            checkedAt = r.CheckedAt.Format(time.RFC3339)
        }
        out = append(out, &paprikav1.AnalysisResult{
            Name:      r.Name,
            Phase:     string(r.Phase),
            Passed:    r.Passed,
            Message:   r.Message,
            CheckedAt: checkedAt,
        })
    }
    return out
}
```

- [ ] **Step 2: Set `AnalysisResults` in `convertApplication`**

In the returned `&paprikav1.Application{...}`, add:

```go
    AnalysisResults: convertAnalysisResults(a.Status.AnalysisResults),
```

- [ ] **Step 3: Run `go fmt` and `go vet`**

---

## Chunk 6: UI

### Task 9: Display analysis results on the application card

**Files:**
- Modify: `ui/src/components/dashboard/application-card.tsx`

- [ ] **Step 1: Add analysis summary component**

After `PolicySummary`, add:

```tsx
function AnalysisSummary({ results }: { results?: Application["analysisResults"] }) {
  if (!results || results.length === 0) return null
  const failed = results.filter((r) => !r.passed).length
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground">Analysis</span>
      <Badge className={`gap-1 ${failed > 0 ? "bg-destructive/10 text-destructive border-destructive/20" : "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"}`}>
        {failed > 0 ? <XCircle className="size-3" /> : <CheckCircle2 className="size-3" />}
        {results.length - failed}/{results.length}
      </Badge>
    </div>
  )
}
```

Import `CheckCircle2` and `XCircle` if not already imported (they are already imported).

- [ ] **Step 2: Render the summary in `ApplicationCard`**

After the `PolicySummary` block, add:

```tsx
{application.analysisResults && application.analysisResults.length > 0 && (
  <AnalysisSummary results={application.analysisResults} />
)}
```

### Task 10: Display analysis results on the application detail page

**Files:**
- Modify: `ui/src/app/dashboard/application/page.tsx`

- [ ] **Step 1: Add `AnalysisResultsCard` component**

Insert before the closing fragment:

```tsx
function AnalysisResultsCard({ results }: { results?: Application["analysisResults"] }) {
  if (!results || results.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Analysis Results
        </CardTitle>
        <CardDescription>Continuous analysis checks for this application.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Template</TableHead>
              <TableHead>Phase</TableHead>
              <TableHead>Passed</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Checked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((result, idx) => (
              <TableRow key={idx}>
                <TableCell className="font-medium">{result.name}</TableCell>
                <TableCell><StatusBadge status={result.phase} /></TableCell>
                <TableCell>{result.passed ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-destructive" />}</TableCell>
                <TableCell className="text-muted-foreground">{result.message || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{result.checkedAt || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
```

Import `Activity` from `lucide-react` at the top of the file (already imported).

- [ ] **Step 2: Render the card in `ApplicationDetail`**

Add `<AnalysisResultsCard results={application.analysisResults} />` near the other cards, e.g., after the Source card.

- [ ] **Step 3: Verify TypeScript types compile**

```bash
cd ui && npm run typecheck
```

Expected: no type errors related to `analysisResults`.

---

## Chunk 7: Samples and Documentation

### Task 11: Add sample AnalysisTemplate and Application

**Files:**
- Create: `config/samples/pipelines_v1alpha1_analysistemplate.yaml`
- Create: `config/samples/pipelines_v1alpha1_application_with_analysis.yaml`

- [ ] **Step 1: Create AnalysisTemplate sample**

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: http-success-rate
  namespace: paprika-system
spec:
  args:
    - name: endpoint
      default: http://my-app/health
    - name: threshold
      default: "95"
  checks:
    - type: http
      url: "{{ .args.endpoint }}"
      successThreshold: "{{ .args.threshold }}"
      timeoutSeconds: 5
      requestCount: 10
```

- [ ] **Step 2: Create Application sample referencing the template**

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: paprika-system
spec:
  source:
    type: helm
    chart:
      repo: https://charts.example.com
      name: my-app
      version: 1.2.3
  strategy: Rolling
  syncPolicy: Auto
  analysisTemplates:
    - name: http-success-rate
      args:
        endpoint: http://my-app-prod/health
        threshold: "99"
      intervalSeconds: 60
      onFailure:
        action: rollback
  stages:
    - name: dev
      ring: 1
    - name: prod
      ring: 2
```

### Task 12: Update user-facing docs

**Files:**
- Create: `docs/guides/analysis-templates.md`

- [ ] **Step 1: Write the guide**

Cover:
- What `AnalysisTemplate` is and when to use it.
- Supported check types (`http`, `podMetrics`) and arguments.
- How to reference templates from an `Application`.
- How background analysis results appear in status and UI.
- Failure actions (`rollback`).

- [ ] **Step 2: Link from `docs/getting-started.md` or `docs/features.md`**

Add a short mention under "Advanced rollout / verification".

---

## Chunk 8: Tests

### Task 13: Unit tests for AnalysisRun controller

**Files:**
- Create: `internal/controller/pipelines/analysisrun_controller_test.go`

- [ ] **Step 1: Test template resolution and phase transitions**

Use the fake client to create an `AnalysisTemplate` and `AnalysisRun`, then call `reconcileRun` and assert:
- Run phase moves from `Pending` to `Successful` or `Failed`.
- `CyclesExecuted` is incremented.
- Missing template sets phase to `Error`.

- [ ] **Step 2: Test count and terminate-on-failure**

Assert that:
- `Count=1` leads to `Completed` after one cycle.
- `TerminateOnFailure=true` leads to `Completed` on failure.

### Task 14: Unit tests for Application analysis manager

**Files:**
- Create or modify: `internal/controller/pipelines/application_controller_unit_test.go`

- [ ] **Step 1: Test AnalysisRun creation and aggregation**

Create an `Application` with `analysisTemplates`, then call `reconcileAnalysisRuns` and assert:
- The expected `AnalysisRun` is created.
- `Application.Status.AnalysisResults` reflects run status.
- Removing a template reference deletes the corresponding run.

- [ ] **Step 2: Test rollback on analysis failure**

Create a `Release` in `Complete` phase, an `AnalysisRun` in `Failed` phase, and an Application referencing the template with `onFailure.action: rollback`. Assert the release gets the `paprika.io/rollback-requested` annotation.

### Task 15: Envtest integration tests

**Files:**
- Create: `internal/controller/pipelines/analysis_envtest_test.go`

- [ ] **Step 1: Test end-to-end analysis lifecycle**

Use the existing envtest suite. Create an `AnalysisTemplate`, an `Application` referencing it, and reconcile. Assert:
- `AnalysisRun` is created.
- Eventually `Application.Status.AnalysisResults` is non-empty.

- [ ] **Step 2: Test rollback path**

Create a template with a failing HTTP check and an Application with `onFailure: rollback`. Assert the current release eventually gets the rollback annotation.

### Task 16: Run verification

- [ ] **Step 1: Run unit/envtest suite**

```bash
make test
```

Expected: all tests pass.

- [ ] **Step 2: Run linter**

```bash
make lint
```

Expected: no errors.

- [ ] **Step 3: Commit the implementation**

```bash
git add -A
git commit -m "feat(pipelines): add AnalysisTemplate and AnalysisRun background analysis

- Add AnalysisTemplate and AnalysisRun CRDs
- Add analysisTemplates to Application spec and analysisResults to status
- Implement AnalysisRunReconciler to execute templates on interval
- Integrate AnalysisRun lifecycle into Application controller
- Expose analysis results via proto/API and UI
- Support rollback on analysis failure"
```

---

## Notes for Implementers

- The design spec is at `/Users/benebsworth/projects/paprika/docs/superpowers/specs/2026-06-16-analysis-templates.md`.
- Do not modify `config/crd/bases/*.yaml`, `config/rbac/role.yaml`, `**/zz_generated.*.go`, or `PROJECT` by hand; always regenerate via `make`.
- The existing `analysis.Analyzer` interface is reused without changes to its contract (other than adding `Name` to `analysis.Result`).
- Placeholder substitution is intentionally minimal in v1; expand only if needed.
- Analysis failure rollback reuses the `rollbackAnnotation` from `release_controller.go`.
