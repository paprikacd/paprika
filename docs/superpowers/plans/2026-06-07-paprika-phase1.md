# Paprika Phase 1 — Core CI/CD Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Core CI/CD operator — Pipeline CRD with DAG-step execution, Template CRD (Helm), Stage CRD, Release CRD with promotion controller, smoke-test/duration gates, and rollback via manifest snapshots.

**Architecture:** Go operator using controller-runtime. CRDs in `paprika.io/v1alpha1`. Workflow engine resolves step DAGs and executes via K8s Jobs. Template renderer wraps `helm template`. Promotion controller manages Release state machine. Rollback stores manifest snapshots as ConfigMaps.

**Tech Stack:** Go 1.22+, controller-runtime, kubebuilder, Helm (CLI), client-go, envtest

---

## Chunk 1: Project Scaffolding & CRD Types

### File Structure

```
/
├── go.mod
├── main.go
├── api/
│   └── v1alpha1/
│       ├── groupversion_info.go
│       ├── pipeline_types.go
│       ├── stage_types.go
│       ├── release_types.go
│       ├── template_types.go
│       └── artifact_types.go
├── config/
│   ├── crd/
│   ├── rbac/
│   ├── manager/
│   └── samples/
```

### Task 1.1: Initialize Go module and kubebuilder project

- [ ] **Create Go module**

```bash
cd /Users/benebsworth/projects/paprika
go mod init github.com/benebsworth/paprika
```

- [ ] **Initialize kubebuilder project**

```bash
go version  # verify Go 1.22+
kubebuilder init --domain paprika.io --repo github.com/benebsworth/paprika --skip-go-version-check
```

Expected: Creates `main.go`, `go.mod`, `config/` directory tree, `Makefile`, `PROJECT` file.

### Task 1.2: Create CRD API types

- [ ] **Create the 5 CRD API groups**

```bash
kubebuilder create api --group pipelines --version v1alpha1 --kind Pipeline --resource --controller
kubebuilder create api --group stages --version v1alpha1 --kind Stage --resource --controller
kubebuilder create api --group releases --version v1alpha1 --kind Release --resource --controller
kubebuilder create api --group templates --version v1alpha1 --kind Template --resource --controller
kubebuilder create api --group artifacts --version v1alpha1 --kind Artifact --resource --controller
```

Expected: Creates `api/v1alpha1/` types files, `controllers/` files, registers in `main.go`.

- [ ] **Write Pipeline types** in `api/v1alpha1/pipeline_types.go`

```go
type PipelineSpec struct {
	MaxParallel int              `json:"maxParallel,omitempty"`
	Sources     []Source         `json:"sources,omitempty"`
	Steps       []PipelineStep   `json:"steps"`
	Artifacts   []PipelineOutput `json:"artifacts,omitempty"`
}

type Source struct {
	Type    string `json:"type"`
	URL     string `json:"url,omitempty"`
	SecretRef string `json:"secretRef,omitempty"`
}

type PipelineStep struct {
	Name      string   `json:"name"`
	Depends   []string `json:"depends,omitempty"`
	Image     string   `json:"image"`
	Script    string   `json:"script"`
	Timeout   int      `json:"timeout,omitempty"`
	Retry     int      `json:"retry,omitempty"`
}

type PipelineOutput struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type StepStatus struct {
	Name        string      `json:"name"`
	Phase       StepPhase   `json:"phase"`
	LogRef      string      `json:"logRef,omitempty"`
	StartedAt   *metav1.Time `json:"startedAt,omitempty"`
	CompletedAt *metav1.Time `json:"completedAt,omitempty"`
}

type StepPhase string
const (
	StepPending   StepPhase = "Pending"
	StepRunning   StepPhase = "Running"
	StepSucceeded StepPhase = "Succeeded"
	StepFailed    StepPhase = "Failed"
	StepSkipped   StepPhase = "Skipped"
)

type PipelineStatus struct {
	Phase            PipelinePhase  `json:"phase,omitempty"`
	StepStatuses     []StepStatus   `json:"stepStatuses,omitempty"`
	LastExecutionTime *metav1.Time  `json:"lastExecutionTime,omitempty"`
	LastExecutionID  string         `json:"lastExecutionID,omitempty"`
}

type PipelinePhase string
const (
	PipelineRunning   PipelinePhase = "Running"
	PipelineSucceeded PipelinePhase = "Succeeded"
	PipelineFailed    PipelinePhase = "Failed"
)
```

- [ ] **Add kubebuilder markers**:

Add the following markers to type definitions:

```
// Pipeline struct:        +kubebuilder:subresource:status
// Stage struct:           +kubebuilder:subresource:status
// Release struct:         +kubebuilder:subresource:status
// Template struct:        +kubebuilder:subresource:status
// Artifact struct:        +kubebuilder:subresource:status
// PipelinePhase type:            +kubebuilder:validation:Enum=Running;Succeeded;Failed
// StepPhase type:                +kubebuilder:validation:Enum=Pending;Running;Succeeded;Failed;Skipped
// ReleasePhase type:             +kubebuilder:validation:Enum=Pending;Promoting;Verifying;Complete;Failed;RolledBack;Superseded
// Source.Type field:             +kubebuilder:validation:Enum=git (Phase 1 only)
// TemplateSpec.Type field:       +kubebuilder:validation:Enum=helm (Phase 1 only)
// FailureAction.Action field:    +kubebuilder:validation:Enum=rollback;halt;ignore
// GateConfig.Type field:         +kubebuilder:validation:Enum=smoke-test;duration (Phase 1)
// ArtifactSpec.Type field:       +kubebuilder:validation:Enum=oci (Phase 1 only)
```

- [ ] **Write Stage types** in `api/v1alpha1/stage_types.go`

```go
type StageSpec struct {
	Name      string          `json:"name"`
	Ring      int             `json:"ring"`
	Cluster   ClusterRef      `json:"cluster,omitempty"`
	Templates []string        `json:"templates"`
	Gates     []GateConfig    `json:"gates,omitempty"`
}

type ClusterRef struct {
	Name string `json:"name"`
}

type GateConfig struct {
	Type     string `json:"type"`
	Endpoint string `json:"endpoint,omitempty"`  // smoke-test
	Timeout  int    `json:"timeout,omitempty"`
}

type StageStatus struct {
	LastPromotion *metav1.Time `json:"lastPromotion,omitempty"`
}
```

- [ ] **Write Release types** in `api/v1alpha1/release_types.go`

```go
type ReleaseSpec struct {
	Pipeline  string         `json:"pipeline"`
	Target    string         `json:"target"`
	From      string         `json:"from,omitempty"`
	Verify    []GateConfig   `json:"verify,omitempty"`
	OnFailure *FailureAction `json:"on_failure,omitempty"`
}

type FailureAction struct {
	Action string   `json:"action"` // rollback | halt | ignore
	Notify []string `json:"notify,omitempty"`
}

type ReleaseStatus struct {
	Phase                   ReleasePhase      `json:"phase,omitempty"`
	CurrentStage            string            `json:"currentStage,omitempty"`
	PromotionHistory        []PromotionEntry  `json:"promotionHistory,omitempty"`
	Conditions              []metav1.Condition `json:"conditions,omitempty"`
	RenderedManifestSnapshot string           `json:"renderedManifestSnapshot,omitempty"`
}

type PromotionEntry struct {
	Stage            string      `json:"stage"`
	Result           string      `json:"result"`
	ManifestSnapshot string      `json:"manifestSnapshot,omitempty"`
	Timestamp        metav1.Time `json:"timestamp"`
}

type ReleasePhase string
const (
	ReleasePending    ReleasePhase = "Pending"
	ReleasePromoting  ReleasePhase = "Promoting"
	ReleaseVerifying  ReleasePhase = "Verifying"
	ReleaseComplete   ReleasePhase = "Complete"
	ReleaseFailed     ReleasePhase = "Failed"
	ReleaseRolledBack ReleasePhase = "RolledBack"
	ReleaseSuperseded ReleasePhase = "Superseded"
)
```

- [ ] **Write Template types** in `api/v1alpha1/template_types.go`

```go
type TemplateSpec struct {
	Type  string      `json:"type"` // helm only for P1
	Chart ChartRef    `json:"chart,omitempty"`
}

type ChartRef struct {
	Repo    string `json:"repo"`
	Name    string `json:"name"`
	Version string `json:"version"`
}

type TemplateStatus struct {
	LastRendered   *metav1.Time `json:"lastRendered,omitempty"`
	LastRenderHash string       `json:"lastRenderHash,omitempty"`
}
```

- [ ] **Write Artifact types** in `api/v1alpha1/artifact_types.go`

```go
type ArtifactSpec struct {
	Type       string          `json:"type"`
	Reference  string          `json:"reference"`
	Digest     string          `json:"digest,omitempty"`
	Provenance ArtifactProvenance `json:"provenance,omitempty"`
}

type ArtifactProvenance struct {
	Pipeline string `json:"pipeline,omitempty"`
	Build    string `json:"build,omitempty"`
}

type ArtifactStatus struct {
	Verified bool `json:"verified,omitempty"`
}
```

- [ ] **Generate deepcopy and CRD manifests**

```bash
make generate
make manifests
```

Expected: `zz_generated.deepcopy.go` files created. CRD YAML manifests in `config/crd/`.

- [ ] **Verify CRD generation**

```bash
ls config/crd/*.yaml                         # All 5 CRD YAMLs exist
ls api/v1alpha1/*.go                          # Types + deepcopy + groupversion files exist
grep -l "subresource" config/crd/*.yaml       # Status subresource present
grep -l "enum" config/crd/*.yaml              # Enum validation present
```

Expected: 5 CRD YAMLs, 7+ Go files, subresource and enum markers present.

- [ ] **Commit**

```bash
git add -A && git commit -m "feat: scaffold operator with 5 CRD types"
```

---

## Chunk 2: Workflow Engine (DAG Executor)

### File Structure

```
engine/
  workflow.go    # DAG resolution, scheduling, job creation
  workflow_test.go
```

### Task 2.1: Implement DAG resolution

- [ ] **Write the DAG resolver** in `engine/workflow.go`

```go
package engine

type Graph struct {
	Nodes map[string]*Node
}

type Node struct {
	Name       string
	DependsOn  []string
	Step       paprika.PipelineStep
	Status     paprika.StepPhase
}

// ResolveDAG builds the dependency graph and returns execution order
// Returns error on cycles
```

Function computes topological sort. Detects cycles via DFS back-edge detection. Returns ordered batches: `[][]Step` where each inner slice can run in parallel.

- [ ] **Write unit test for DAG resolution**

`engine/workflow_test.go`: Test linear DAG, fan-out, fan-in, diamond, cycle detection.

```go
func TestLinearDAG(t *testing.T) {
	steps := []paprika.PipelineStep{
		{Name: "build"},
		{Name: "test", Depends: []string{"build"}},
		{Name: "deploy", Depends: []string{"test"}},
	}
	batches, err := ResolveDAG(steps)
	assert.NoError(t, err)
	assert.Equal(t, 3, len(batches))
}
```

- [ ] **Run test to verify**

```bash
go test ./engine/ -v
```
Expected: All DAG tests pass.

- [ ] **Commit**

```bash
git add -A && git commit -m "feat: add DAG resolver with cycle detection"
```

### Task 2.2: Implement step executor (K8s Jobs)

- [ ] **Write the step executor** in `engine/workflow.go`

```go
// ExecuteStep creates a K8s Job for a pipeline step and watches for completion
func (e *WorkflowEngine) ExecuteStep(ctx context.Context, step paprika.PipelineStep, pipelineName string) (*batchv1.Job, error)
```

Creates a `batchv1.Job` with:
- Container image from step spec
- Command: `sh -c "<script>"`
- Labels: `paprika.io/pipeline`, `paprika.io/step`
- BackoffLimit: step.Retry
- ActiveDeadlineSeconds: step.Timeout
- RestartPolicy: Never

Returns the Job reference. Function watches the Job until completion or failure via a watcher.

- [ ] **Implement log capture from Jobs**

After a Job completes, fetch logs via `client.CoreV1().Pods(ns).GetLogs(podName, opts).Do(ctx)`.
Store the log output and populate `StepStatus.LogRef` with a reference like `"<pipeline-name>/<step-name>/logs"`.
Implementation: logs stored in a ConfigMap or a deterministic Pod log query path.

- [ ] **Implement maxParallel throttling in DAG execution**

When executing batches, limit concurrent step Jobs to `pipeline.Spec.MaxParallel` (default 10). If a batch has more steps than `maxParallel`, split into sub-batches of size `maxParallel` and execute them sequentially. Steps within a sub-batch run in parallel. Steps across sub-batches run in spec-defined order.

```go
func (e *WorkflowEngine) executeBatch(ctx context.Context, batch []paprika.PipelineStep, pipeline paprika.Pipeline) error {
	// Apply maxParallel throttling
	// Execute sub-batches in series
	// Track step statuses
}
```

- [ ] **Write the WorkflowEngine.RunPipeline method**

```go
func (e *WorkflowEngine) RunPipeline(ctx context.Context, pipeline *paprika.Pipeline) error
```

Resolves DAG → splits into maxParallel-constrained sub-batches → executes in order → captures logs → updates Pipeline status.<template>

- [ ] **Write unit test for job creation**

Use fake clientset. Verify Job spec matches step definition.

```go
func TestExecuteStep_CreatesJob(t *testing.T) {
	step := paprika.PipelineStep{Name: "build", Image: "golang:1.22", Script: "make build"}
	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, nil)
	job, err := engine.ExecuteStep(context.Background(), step, "test-pipeline")
	assert.NoError(t, err)
	assert.Equal(t, "paprika-step-build", job.Name)
	assert.Equal(t, "golang:1.22", job.Spec.Template.Spec.Containers[0].Image)
}
```

- [ ] **Run tests**

```bash
go test ./engine/ -v
```

- [ ] **Commit**

```bash
git add -A && git commit -m "feat: add K8s Job-based step executor"
```

---

## Chunk 3: Template Renderer (Helm)

### File Structure

```
engine/
  template.go         # Helm chart fetcher + renderer
  template_test.go
```

### Task 3.1: Implement Helm template renderer

- [ ] **Write template renderer** in `engine/template.go`

```go
type TemplateRenderer struct {
	// embeds helm template execution
}

// Render fetches a Helm chart and runs `helm template` with values
// Returns rendered YAML as []byte
func (r *TemplateRenderer) Render(ctx context.Context, template *paprika.Template, params map[string]string) ([]byte, error)
```

Implementation:
1. `helm repo add <name> <repo-url> --no-update` (idempotent)
2. `helm repo update`
3. `helm template <name> <chart-ref> --version <version>`
4. Capture stdout as rendered YAML
5. Return bytes

Uses `os/exec` to call helm binary (must be in PATH).

- [ ] **Write RenderManifestSnapshots method**

```go
// RenderAll renders all Templates for a Stage and returns combined manifests
func (r *TemplateRenderer) RenderAll(ctx context.Context, templates []paprika.Template, stage paprika.Stage) ([]byte, error)
```

Renders each template in order, concatenates with `---` separator.

- [ ] **Write unit test** (can't run helm in unit tests, mock it)

```go
func TestRenderAll_ConcatenatesTemplates(t *testing.T) {
	// Use a mock helm command that returns known output
	// Verify templates are rendered in order and concatenated
}
```

- [ ] **Run tests**

```bash
go test ./engine/ -v
```

- [ ] **Commit**

```bash
git add -A && git commit -m "feat: add Helm template renderer"
```

---

## Chunk 4: Pipeline Controller

### File Structure

```
controllers/
  pipeline_controller.go    # Pipeline reconciler
  pipeline_controller_test.go
```

### Task 4.1: Implement Pipeline reconciler

- [ ] **Write Pipeline controller** in `controllers/pipeline_controller.go`

The reconciler watches Pipeline CRDs. When a new Pipeline is created or triggered:
1. Create a WorkflowEngine
2. Call RunPipeline with the Pipeline spec
3. Update Pipeline status with step results

```go
func (r *PipelineReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	// Fetch Pipeline
	// If phase == Running, check step statuses
	// If phase == "", start execution: set phase to Running, execute DAG
	// Update status after each batch
	// On completion: set Succeeded or Failed, create Artifact CRDs
}
```

- [ ] **Write Artifact creation on pipeline success**

On Pipeline completion with phase `Succeeded`, create Artifact CRD objects for each entry in `spec.artifacts`.

- [ ] **Write pipeline controller test**

```go
func TestPipelineReconciler_RunsPipeline(t *testing.T) {
	// Create Pipeline CR
	// Reconcile
	// Verify Jobs are created
	// Verify status transitions
}
```

- [ ] **Run tests**

```bash
go test ./controllers/ -v
```

- [ ] **Commit**

```bash
git add -A && git commit -m "feat: add Pipeline reconciler with step execution"
```

---

## Chunk 5: Stage + Template Controllers

### File Structure

```
controllers/
  stage_controller.go
  template_controller.go
```

### Task 5.1: Implement Stage controller

- [ ] **Write Stage controller** in `controllers/stage_controller.go`

Stage reconciler is lightweight in Phase 1. It validates:
1. Referenced Template CRDs exist
2. Stage is ready for promotions

```go
func (r *StageReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	// Fetch Stage
	// Validate templates exist
	// Update status with readiness
}
```

### Task 5.2: Implement Template controller

- [ ] **Write Template controller** in `controllers/template_controller.go`

Template reconciler validates the chart is accessible.

```go
func (r *TemplateReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	// Fetch Template
	// Validate helm chart is reachable (dry-run helm repo add + search)
	// Update status
}
```

- [ ] **Write Stage controller test**

```go
func TestStageReconciler_ValidatesTemplates(t *testing.T) {
	// Create Stage referencing a non-existent Template
	// Reconcile
	// Verify status has error condition
}
```

- [ ] **Write Template controller test**

```go
func TestTemplateReconciler_ValidatesChart(t *testing.T) {
	// Create Template with helm chart ref
	// Reconcile
	// Verify status updated (even if chart unreachable in test env)
}
```

- [ ] **Run controller tests**

```bash
go test ./controllers/ -v
```

Expected: Stage and Template controller tests pass.

- [ ] **Commit**

```bash
git add -A && git commit -m "feat: add Stage and Template controllers"
```

---

## Chunk 6: Promotion Controller + Verification Gates

### File Structure

```
controllers/
  release_controller.go        # Release/Promotion reconciler
  release_controller_test.go
gates/
  smoke.go                     # Smoke-test gate implementation
  duration.go                  # Duration gate implementation
  gates_test.go
```

### Task 6.1: Implement verification gates

- [ ] **Write Smoke-test gate** in `gates/smoke.go`

```go
package gates

type SmokeGate struct{}

// Execute makes an HTTP GET to the gate endpoint
// Returns pass/fail with message
func (g *SmokeGate) Execute(ctx context.Context, config paprika.GateConfig) (bool, string, error)
```

Makes HTTP GET to `config.Endpoint`. 2xx = pass. Times out after `config.Timeout` seconds.

- [ ] **Write Duration gate** in `gates/duration.go`

```go
type DurationGate struct{}

// Execute waits for config.Timeout seconds, then returns pass
func (g *DurationGate) Execute(ctx context.Context, config paprika.GateConfig) (bool, string, error)
```

Uses `time.Sleep` or `time.After`. Simple timer.

- [ ] **Write gate dispatcher**

```go
func ExecuteGate(ctx context.Context, config paprika.GateConfig) (bool, string, error) {
	switch config.Type {
	case "smoke-test":
		return (&SmokeGate{}).Execute(ctx, config)
	case "duration":
		return (&DurationGate{}).Execute(ctx, config)
	default:
		return false, "", fmt.Errorf("unknown gate type: %s", config.Type)
	}
}
```

- [ ] **Write gate tests**

```go
func TestSmokeGate_Success(t *testing.T) {
	// Start test HTTP server that returns 200
	// Execute gate
	// Assert pass
}

func TestDurationGate_Waits(t *testing.T) {
	// Execute with 1s timeout
	// Assert pass after 1s
}
```

- [ ] **Run tests**

```bash
go test ./gates/ -v
```

- [ ] **Commit**

```bash
git add -A && git commit -m "feat: add smoke-test and duration verification gates"
```

### Task 6.2: Implement Release/Promotion controller

- [ ] **Write Release controller** in `controllers/release_controller.go`

State machine:

```
Pending → Promoting (render templates + apply to Stage cluster)
              ↓
         Verifying (execute gates)
              ↓
         Complete | Failed | RolledBack
```

```go
func (r *ReleaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	// Fetch Release
	// Fetch Stage
	// Fetch Pipeline (for artifact info)
	// Fetch Templates referenced by Stage
	//
	// Check concurrent Release queuing:
	//   If another Release exists targeting the same Stage with phase Promoting or Verifying,
	//   set this Release to Pending and requeue
	//
	// Switch on Release.Status.Phase:
	//   "":       initialize → set Promoting
	//   Promoting: render templates, store manifest snapshot, apply manifests (client-go Apply) → Verifying
	//   Verifying: execute gates → Complete | Failed
	//   Failed:    if on_failure.action == rollback → RolledBack
}
```

- [ ] **Implement manifest snapshot storage**

Before promoting, store current rendered manifests as a ConfigMap:
```go
func (r *ReleaseReconciler) storeManifestSnapshot(ctx context.Context, release paprika.Release, stage paprika.Stage, manifests []byte) error {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-manifest-snapshot", stage.Name),
			Namespace: "paprika-system",
			Labels: map[string]string{
				"paprika.io/stage":   stage.Name,
				"paprika.io/release": release.Name,
			},
		},
		Data: map[string]string{"manifests.yaml": string(manifests)},
	}
	_, err := r.Client.CoreV1().ConfigMaps("paprika-system").Create(ctx, cm, metav1.CreateOptions{})
	return err
}
```

- [ ] **Implement rollback**

On failure with `action == rollback`, fetch previous ConfigMap snapshot and apply:

```go
func (r *ReleaseReconciler) rollback(ctx context.Context, release paprika.Release, stage paprika.Stage) error {
	// Fetch previous manifest snapshot ConfigMap
	// If no snapshot exists (first-ever deployment), log warning and set status to RolledBack with "no snapshot available"
	// Apply manifests via client-go
	// Set release status to RolledBack
}
```

- [ ] **Write release controller tests**

```go
func TestReleaseReconciler_PromoteFlow(t *testing.T) {
	// Create Release, Stage, Template CRs
	// Run reconcile
	// Verify phase transitions: "" → Promoting → (rendered) → Verifying → Complete
}

func TestReleaseReconciler_Rollback(t *testing.T) {
	// Create Release with on_failure.action=rollback
	// Set up gate to fail
	// Run reconcile
	// Verify phase: Failed → RolledBack
	// Verify manifest snapshot ConfigMap was applied
}
```

- [ ] **Run tests**

```bash
go test ./controllers/ -v
```

- [ ] **Commit**

```bash
git add -A && git commit -m "feat: add Release/Promotion controller with rollback"
```

---

## Chunk 7: Integration Tests & Wiring

### Task 7.1: Wire controllers into main.go

- [ ] **Update `main.go`** to register all controllers and start the manager

```go
func main() {
	// Standard kubebuilder main with leader election
	// Add manager options:
	//   LeaderElection: true
	//   LeaderElectionID: "paprika-operator.paprika.io"
	//   LeaseDuration: 15 * time.Second
	//   RenewDeadline: 10 * time.Second
	//   RetryPeriod: 2 * time.Second
	//
	// Register controllers:
	//   PipelineReconciler
	//   StageReconciler
	//   ReleaseReconciler
	//   TemplateReconciler
	// Start manager
}
```

### Task 7.2: Write envtest integration test

- [ ] **Write integration test** in `controllers/suite_test.go`

```go
// envtest suite that:
// 1. Starts a local K8s API server
// 2. Registers all CRDs from filepath.Join("..", "config", "crd"))
// 3. Creates Pipeline, Stage, Template, Release CRs
// 4. Asserts the operator reconciles them correctly
```

- [ ] **Run integration tests**

```bash
go test ./controllers/ -v -tags=integration
```

Expected: All tests pass with real K8s envtest environment.

### Task 7.3: Create sample CR YAMLs

- [ ] **Write samples** in `config/samples/`:

```yaml
# config/samples/pipeline.yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Pipeline
metadata:
  name: app-pipeline
spec:
  sources:
    - type: git
      url: https://github.com/example/app
  steps:
    - name: build
      image: golang:1.22
      script: go build -o app .
    - name: test
      depends: [build]
      image: golang:1.22
      script: go test ./...
  artifacts:
    - name: image
      path: registry.example.com/app:latest
```

Create `stage.yaml`, `template.yaml`, `release.yaml`, `artifact.yaml` following the same pattern.

- [ ] **Commit**

```bash
git add -A && git commit -m "feat: add integration tests and sample CRs"
```

---

## Plan Review

After completing each chunk, dispatch the plan-document-reviewer subagent for that chunk.

### Review Chunk 1

```
Task: general-purpose
description: "Review Paprika plan chunk 1"
prompt: |
  You are a plan document reviewer. Verify this plan chunk is complete and ready for implementation.

  **Plan chunk to review:** /Users/benebsworth/projects/paprika/docs/superpowers/plans/2026-06-07-paprika-phase1.md - Chunk 1 only (Project Scaffolding & CRD Types)
  **Spec for reference:** /Users/benebsworth/projects/paprika/docs/superpowers/specs/2026-06-07-paprika-design.md

  ## What to Check

  | Category | What to Look For |
  |----------|------------------|
  | Completeness | TODOs, placeholders, incomplete tasks, missing steps |
  | Spec Alignment | Chunk covers relevant spec requirements, no scope creep |
  | Task Decomposition | Tasks atomic, clear boundaries, steps actionable |
  | File Structure | Files have clear single responsibilities, split by responsibility not layer |
  | Task Syntax | Checkbox syntax (`- [ ]`) on steps for tracking |

  ## Output Format

  **Status:** Approved | Issues Found
  **Issues (if any):** ...
  **Recommendations (advisory):** ...
```

Repeat for each chunk.
