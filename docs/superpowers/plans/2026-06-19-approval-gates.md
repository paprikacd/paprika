# Approval Gates Implementation Plan

> **For agentic workers:** REQUIRED: Use @superpowers:subagent-driven-development (if subagents available) or @superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manual, webhook, and Slack approval gates that pause a Release before promotion to a stage and resume once approved, exposing gate status through new API RPCs, CLI commands, and the UI.

**Architecture:** Extend the existing `ApprovalGate`/`GateStatus` CRD types and add per-stage gates on `StageSpec`. Move the blocking decision from the Application controller to the Release controller by evaluating gates at the start of `handlePromotingPhase`; pending gates transition the Release to a new `AwaitingApproval` phase and record status on the owning Application. Manual gates wait for API/UI approval; webhook gates call a configurable HTTP endpoint; Slack gates are scaffolded as Phase 2. New Connect-RPC methods (`ListGateStatus`, `ApproveGate`, `RejectGate`) and CLI/UI commands surface and mutate gate state.

**Tech Stack:** Go, Kubernetes controller-runtime, kubebuilder, Protocol Buffers (buf), Ginkgo/Gomega, envtest, React/TypeScript/Next.js, Tailwind CSS.

---

## Chunk 1: API Schema

### Task 1: Extend `ApprovalGate` and `GateStatus` in `Application`

**Files:**
- Modify: `api/pipelines/v1alpha1/application_types.go`

- [ ] **Step 1: Add approval gate constants**

  Insert after the existing `ApprovalGate`/`GateStatus` structs (around line 344):

  ```go
  // ApprovalGateType values.
  const (
      ApprovalGateTypeManual  = "manual"
      ApprovalGateTypeWebhook = "webhook"
      ApprovalGateTypeSlack   = "slack"
  )

  // GateStatus values.
  const (
      GateStatusPending  = "Pending"
      GateStatusApproved = "Approved"
      GateStatusRejected = "Rejected"
  )
  ```

- [ ] **Step 2: Replace the `ApprovalGate` struct**

  ```go
  // ApprovalGate defines a manual or automated approval gate for stage transitions.
  type ApprovalGate struct {
      // Name of the gate
      Name string `json:"name"`
      // Stage at which this gate applies (e.g., "prod"). Empty applies to all stages.
      // +optional
      Stage string `json:"stage,omitempty"`
      // Type of gate: manual, webhook, slack
      // +kubebuilder:validation:Enum=manual;webhook;slack
      Type string `json:"type"`
      // Whether the gate is required (default true)
      // +kubebuilder:default=true
      // +optional
      Required bool `json:"required,omitempty"`

      // URL is the webhook URL for webhook gates.
      // +optional
      URL string `json:"url,omitempty"`
      // HTTP method for webhook gates. Defaults to POST.
      // +kubebuilder:default=POST
      // +optional
      Method string `json:"method,omitempty"`
      // Headers to send with webhook requests.
      // +optional
      Headers map[string]string `json:"headers,omitempty"`
      // Body template sent to webhook gates.
      // +optional
      Body string `json:"body,omitempty"`
      // SuccessStatus is the expected HTTP status code for approval (default any 2xx).
      // +kubebuilder:default=200
      // +optional
      SuccessStatus int `json:"successStatus,omitempty"`
      // SecretRef names a Secret in the same namespace whose data is added to webhook headers.
      // +optional
      SecretRef string `json:"secretRef,omitempty"`

      // SlackWebhookURL is the incoming Slack webhook URL used to notify a channel.
      // Phase 2: actual Slack interaction handling.
      // +optional
      SlackWebhookURL string `json:"slackWebhookUrl,omitempty"`
      // SlackChannel is the channel to notify for Slack gates.
      // +optional
      SlackChannel string `json:"slackChannel,omitempty"`
  }
  ```

- [ ] **Step 3: Replace the `GateStatus` struct**

  ```go
  // GateStatus represents the current status of an approval gate.
  type GateStatus struct {
      Name       string `json:"name"`
      Stage      string `json:"stage"`
      Type       string `json:"type,omitempty"`
      Status     string `json:"status"` // Pending, Approved, Rejected
      ApprovedBy string `json:"approvedBy,omitempty"`
      Message    string `json:"message,omitempty"`
  }
  ```

- [ ] **Step 4: Commit the type changes**

  ```bash
  git add api/pipelines/v1alpha1/application_types.go
  git commit -m "feat(approval-gates): extend ApprovalGate and GateStatus types"
  ```

### Task 2: Add `ReleaseAwaitingApproval` phase

**Files:**
- Modify: `api/pipelines/v1alpha1/release_types.go`

- [ ] **Step 1: Add the phase constant**

  Insert after `ReleaseSuperseded` (around line 26):

  ```go
  // ReleaseAwaitingApproval indicates the release is waiting for approval gates.
  ReleaseAwaitingApproval ReleasePhase = "AwaitingApproval"
  ```

- [ ] **Step 2: Update the status enum marker**

  In `ReleaseStatus` update the existing enum marker (around line 84) to:

  ```go
  // +kubebuilder:validation:Enum=Pending;Promoting;Canarying;Verifying;Complete;Failed;RolledBack;Superseded;AwaitingApproval
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add api/pipelines/v1alpha1/release_types.go
  git commit -m "feat(approval-gates): add ReleaseAwaitingApproval phase"
  ```

### Task 3: Add per-stage approval gates

**Files:**
- Modify: `api/pipelines/v1alpha1/stage_types.go`

- [ ] **Step 1: Add `ApprovalGates` to `StageSpec`**

  Insert after `Gates []GateConfig` (around line 133):

  ```go
  // ApprovalGates define manual/webhook/Slack approval gates for promotion into this stage.
  // +optional
  ApprovalGates []ApprovalGate `json:"approvalGates,omitempty"`
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add api/pipelines/v1alpha1/stage_types.go
  git commit -m "feat(approval-gates): add ApprovalGates to StageSpec"
  ```

### Task 4: Regenerate deepcopy and CRDs

- [ ] **Step 1: Generate DeepCopy methods**

  ```bash
  make generate
  ```

  Expected: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` is updated for the new `ApprovalGate` fields and `StageSpec.ApprovalGates`.

- [ ] **Step 2: Generate manifests**

  ```bash
  make manifests
  ```

  Expected:
  - `config/crd/bases/pipelines.paprika.io_applications.yaml` gains new `approvalGates` fields.
  - `config/crd/bases/pipelines.paprika.io_stages.yaml` gains `approvalGates`.
  - `config/rbac/role.yaml` is regenerated (we add explicit RBAC markers in Chunk 3).

- [ ] **Step 3: Commit generated files**

  ```bash
  git add api/pipelines/v1alpha1/zz_generated.deepcopy.go config/crd/bases config/rbac/role.yaml
  git commit -m "feat(approval-gates): regenerate deepcopy, CRDs and RBAC"
  ```

### Task 5: Propagate `ApprovalGates` when reconciling stages

**Files:**
- Modify: `internal/controller/pipelines/application_controller.go`

- [ ] **Step 1: Copy per-stage approval gates in `buildStageSpec`**

  In `buildStageSpec` (around line 721), add inside `StageSpec` after `Gates: promotionStage.Gates,`:

  ```go
  ApprovalGates: promotionStage.ApprovalGates,
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add internal/controller/pipelines/application_controller.go
  git commit -m "feat(approval-gates): propagate ApprovalGates to Stage objects"
  ```

---

## Chunk 2: Approval Gate Engine

### Task 1: Create the approval gate evaluator

**Files:**
- Create: `internal/gates/approval.go`

- [ ] **Step 1: Write `internal/gates/approval.go`**

  ```go
  package gates

  import (
      "bytes"
      "context"
      "fmt"
      "net/http"
      "time"
  )

  // ApprovalGateType values.
  const (
      ApprovalGateTypeManual  = "manual"
      ApprovalGateTypeWebhook = "webhook"
      ApprovalGateTypeSlack   = "slack"
  )

  // ApprovalGateStatus values.
  const (
      ApprovalGateStatusPending  = "Pending"
      ApprovalGateStatusApproved = "Approved"
      ApprovalGateStatusRejected = "Rejected"
  )

  // ApprovalGate describes an approval gate to be evaluated.
  type ApprovalGate struct {
      Name            string
      Stage           string
      Type            string
      Required        bool
      URL             string
      Method          string
      Headers         map[string]string
      Body            string
      SuccessStatus   int
      SlackWebhookURL string
      SlackChannel    string
  }

  // ApprovalGatePayload is passed to webhook/Slack gates.
  type ApprovalGatePayload struct {
      Application string
      Namespace   string
      Release     string
      Stage       string
      Gate        string
  }

  // ApprovalGateResult is the outcome of evaluating one gate.
  type ApprovalGateResult struct {
      Status     string
      ApprovedBy string
      Message    string
      Error      error
  }

  // ApprovalGateEvaluator evaluates approval gates.
  type ApprovalGateEvaluator struct {
      HTTPClient *http.Client
  }

  // NewApprovalGateEvaluator creates an evaluator with the given HTTP client.
  func NewApprovalGateEvaluator(client *http.Client) *ApprovalGateEvaluator {
      if client == nil {
          client = http.DefaultClient
      }
      return &ApprovalGateEvaluator{HTTPClient: client}
  }

  // Evaluate returns the result for a single gate given its current status.
  func (e *ApprovalGateEvaluator) Evaluate(ctx context.Context, gate ApprovalGate, payload ApprovalGatePayload, currentStatus string) ApprovalGateResult {
      if currentStatus == ApprovalGateStatusApproved {
          return ApprovalGateResult{Status: ApprovalGateStatusApproved, ApprovedBy: "manual"}
      }
      if currentStatus == ApprovalGateStatusRejected {
          return ApprovalGateResult{Status: ApprovalGateStatusRejected}
      }

      switch gate.Type {
      case ApprovalGateTypeManual:
          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: "waiting for manual approval"}
      case ApprovalGateTypeWebhook:
          return e.evaluateWebhook(ctx, gate, payload)
      case ApprovalGateTypeSlack:
          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: "Slack interaction is Phase 2"}
      default:
          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: "unknown gate type: " + gate.Type}
      }
  }

  func (e *ApprovalGateEvaluator) evaluateWebhook(ctx context.Context, gate ApprovalGate, payload ApprovalGatePayload) ApprovalGateResult {
      if gate.URL == "" {
          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: "webhook gate missing URL"}
      }
      method := gate.Method
      if method == "" {
          method = http.MethodPost
      }
      body := gate.Body
      if body == "" {
          body = fmt.Sprintf(`{"application":"%s","namespace":"%s","release":"%s","stage":"%s","gate":"%s"}`,
              payload.Application, payload.Namespace, payload.Release, payload.Stage, payload.Gate)
      }

      req, err := http.NewRequestWithContext(ctx, method, gate.URL, bytes.NewBufferString(body))
      if err != nil {
          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf("invalid webhook request: %v", err), Error: err}
      }
      req.Header.Set("Content-Type", "application/json")
      for k, v := range gate.Headers {
          req.Header.Set(k, v)
      }

      ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
      defer cancel()

      resp, err := e.HTTPClient.Do(req.WithContext(ctx))
      if err != nil {
          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf("webhook call failed: %v", err), Error: err}
      }
      defer func() { _ = resp.Body.Close() }()

      if gate.SuccessStatus > 0 {
          if resp.StatusCode == gate.SuccessStatus {
              return ApprovalGateResult{Status: ApprovalGateStatusApproved, ApprovedBy: "webhook", Message: fmt.Sprintf("HTTP %d", resp.StatusCode)}
          }
          return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf("HTTP %d (expected %d)", resp.StatusCode, gate.SuccessStatus)}
      }
      if resp.StatusCode >= 200 && resp.StatusCode < 300 {
          return ApprovalGateResult{Status: ApprovalGateStatusApproved, ApprovedBy: "webhook", Message: fmt.Sprintf("HTTP %d", resp.StatusCode)}
      }
      return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf("HTTP %d (expected 2xx)", resp.StatusCode)}
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add internal/gates/approval.go
  git commit -m "feat(approval-gates): add approval gate evaluator"
  ```

### Task 2: Unit-test the evaluator

**Files:**
- Create: `internal/gates/approval_test.go`

- [ ] **Step 1: Write tests**

  ```go
  package gates

  import (
      "context"
      "net/http"
      "net/http/httptest"
      "testing"
  )

  func TestApprovalGateEvaluator_manual(t *testing.T) {
      e := NewApprovalGateEvaluator(nil)
      gate := ApprovalGate{Name: "m", Type: ApprovalGateTypeManual}

      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ""); got.Status != ApprovalGateStatusPending {
          t.Errorf("manual gate = %s, want Pending", got.Status)
      }
      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ApprovalGateStatusApproved); got.Status != ApprovalGateStatusApproved {
          t.Errorf("approved manual gate = %s, want Approved", got.Status)
      }
  }

  func TestApprovalGateEvaluator_webhook(t *testing.T) {
      srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
          w.WriteHeader(http.StatusOK)
      }))
      defer srv.Close()

      e := NewApprovalGateEvaluator(srv.Client())
      gate := ApprovalGate{Name: "w", Type: ApprovalGateTypeWebhook, URL: srv.URL, Method: http.MethodPost}
      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ""); got.Status != ApprovalGateStatusApproved {
          t.Errorf("webhook gate = %s, want Approved", got.Status)
      }

      gate.URL = ""
      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ""); got.Status != ApprovalGateStatusPending {
          t.Errorf("webhook missing url = %s, want Pending", got.Status)
      }
  }

  func TestApprovalGateEvaluator_slack(t *testing.T) {
      e := NewApprovalGateEvaluator(nil)
      gate := ApprovalGate{Name: "s", Type: ApprovalGateTypeSlack}
      if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ""); got.Status != ApprovalGateStatusPending {
          t.Errorf("slack gate = %s, want Pending", got.Status)
      }
  }
  ```

- [ ] **Step 2: Run the tests**

  ```bash
  go test ./internal/gates/... -run TestApprovalGateEvaluator -v
  ```

  Expected: PASS.

- [ ] **Step 3: Commit**

  ```bash
  git add internal/gates/approval_test.go
  git commit -m "test(approval-gates): add evaluator unit tests"
  ```

---

## Chunk 3: Release Controller Integration

### Task 1: Define the `ApprovalGateEvaluator` interface and wire the dependency

**Files:**
- Modify: `internal/controller/pipelines/gate_executor.go`
- Modify: `internal/controller/pipelines/release_controller.go`
- Modify: `cmd/main_controllers.go`

- [ ] **Step 1: Add the interface in `gate_executor.go`**

  Append to the file:

  ```go
  // ApprovalGateEvaluator evaluates approval gates before a Release is promoted.
  type ApprovalGateEvaluator interface {
      Evaluate(ctx context.Context, gate gates.ApprovalGate, payload gates.ApprovalGatePayload, currentStatus string) gates.ApprovalGateResult
  }
  ```

- [ ] **Step 2: Add the field to `ReleaseReconciler`**

  In `release_controller.go` inside the `ReleaseReconciler` struct (after `GateExecutor`), add:

  ```go
  // ApprovalGateEvaluator evaluates approval gates before promotion.
  ApprovalGateEvaluator ApprovalGateEvaluator
  ```

- [ ] **Step 3: Inject the evaluator in `cmd/main_controllers.go`**

  In `setupReleaseController` after `releaseRec.GateExecutor = gates.NewSmokeGate(http.DefaultClient)` add:

  ```go
  releaseRec.ApprovalGateEvaluator = gates.NewApprovalGateEvaluator(http.DefaultClient)
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add internal/controller/pipelines/gate_executor.go internal/controller/pipelines/release_controller.go cmd/main_controllers.go
  git commit -m "feat(approval-gates): wire ApprovalGateEvaluator into release reconciler"
  ```

### Task 2: Implement gate checking helpers in the release controller

**Files:**
- Modify: `internal/controller/pipelines/release_controller.go`

- [ ] **Step 1: Add conversion and collection helpers**

  Append near the bottom of `release_controller.go`:

  ```go
  func (r *ReleaseReconciler) effectiveApprovalGates(app *paprikav1.Application, stage *paprikav1.Stage) []gates.ApprovalGate {
      target := stage.Spec.Name
      var out []gates.ApprovalGate
      for _, g := range app.Spec.ApprovalGates {
          if !g.Required {
              continue
          }
          if g.Stage != "" && g.Stage != target {
              continue
          }
          out = append(out, convertApprovalGate(g))
      }
      for _, g := range stage.Spec.ApprovalGates {
          if !g.Required {
              continue
          }
          out = append(out, convertApprovalGate(g))
      }
      return out
  }

  func convertApprovalGate(g paprikav1.ApprovalGate) gates.ApprovalGate {
      return gates.ApprovalGate{
          Name:            g.Name,
          Stage:           g.Stage,
          Type:            g.Type,
          Required:        g.Required,
          URL:             g.URL,
          Method:          g.Method,
          Headers:         g.Headers,
          Body:            g.Body,
          SuccessStatus:   g.SuccessStatus,
          SlackWebhookURL: g.SlackWebhookURL,
          SlackChannel:    g.SlackChannel,
      }
  }

  func (r *ReleaseReconciler) findGateStatus(app *paprikav1.Application, name string) paprikav1.GateStatus {
      for _, s := range app.Status.Gates {
          if s.Name == name {
              return s
          }
      }
      return paprikav1.GateStatus{}
  }

  func (r *ReleaseReconciler) syncApplicationGateStatus(ctx context.Context, app *paprikav1.Application, statuses []paprikav1.GateStatus) error {
      return retry.RetryOnConflict(retry.DefaultRetry, func() error {
          var fresh paprikav1.Application
          if err := r.client.Get(ctx, types.NamespacedName{Name: app.Name, Namespace: app.Namespace}, &fresh); err != nil {
              return fmt.Errorf("fetch application for gate sync: %w", err)
          }
          fresh.Status.Gates = statuses
          if err := r.client.Status().Update(ctx, &fresh); err != nil {
              return fmt.Errorf("update application gate status: %w", err)
          }
          return nil
      })
  }
  ```

- [ ] **Step 2: Add `checkApprovalGates`**

  ```go
  func (r *ReleaseReconciler) checkApprovalGates(ctx context.Context, release *paprikav1.Release) (approved bool, rejected bool, err error) {
      log := logf.FromContext(ctx)
      app, err := r.resolveOwningApplication(ctx, release)
      if err != nil {
          return false, false, fmt.Errorf("resolve owning application: %w", err)
      }
      stage, err := r.fetchStage(ctx, release)
      if err != nil {
          return false, false, fmt.Errorf("fetch stage: %w", err)
      }

      gateList := r.effectiveApprovalGates(app, stage)
      if len(gateList) == 0 {
          return true, false, nil
      }

      payload := gates.ApprovalGatePayload{
          Application: app.Name,
          Namespace:   app.Namespace,
          Release:     release.Name,
          Stage:       stage.Spec.Name,
      }

      statuses := make([]paprikav1.GateStatus, 0, len(gateList))
      anyPending := false
      anyRejected := false

      for _, g := range gateList {
          current := r.findGateStatus(app, g.Name)
          result := r.ApprovalGateEvaluator.Evaluate(ctx, g, payload, current.Status)
          status := paprikav1.GateStatus{
              Name:   g.Name,
              Stage:  g.Stage,
              Type:   g.Type,
              Status: result.Status,
          }
          if result.Status == GateStatusApproved {
              status.ApprovedBy = result.ApprovedBy
          } else {
              status.Message = result.Message
          }
          statuses = append(statuses, status)
          if result.Status == GateStatusPending {
              anyPending = true
          }
          if result.Status == GateStatusRejected {
              anyRejected = true
          }
          log.Info("Evaluated approval gate", "gate", g.Name, "type", g.Type, "status", result.Status)
      }

      if err := r.syncApplicationGateStatus(ctx, app, statuses); err != nil {
          return false, false, fmt.Errorf("sync gate status: %w", err)
      }

      if anyRejected {
          return false, true, nil
      }
      if anyPending {
          return false, false, nil
      }
      return true, false, nil
  }
  ```

  Note: `GateStatusPending`/`Approved`/`Rejected` constants come from `paprikav1` since the same names are defined there; use the `paprikav1` package constants.

- [ ] **Step 3: Commit**

  ```bash
  git add internal/controller/pipelines/release_controller.go
  git commit -m "feat(approval-gates): add release controller gate evaluation helpers"
  ```

### Task 3: Wire gates into the release lifecycle

**Files:**
- Modify: `internal/controller/pipelines/release_controller.go`

- [ ] **Step 1: Add `AwaitingApproval` handler in `reconcileReleasePhase`**

  After the `ReleasePending` branch (around line 217) add:

  ```go
  if release.Status.Phase == paprikav1.ReleaseAwaitingApproval {
      return r.handleAwaitingApprovalPhase(ctx, release, result)
  }
  ```

- [ ] **Step 2: Implement `handleAwaitingApprovalPhase`**

  Add near `handlePendingPhase`:

  ```go
  func (r *ReleaseReconciler) handleAwaitingApprovalPhase(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
      approved, rejected, err := r.checkApprovalGates(ctx, release)
      if err != nil {
          *result = resultError
          return ctrl.Result{}, fmt.Errorf("checking approval gates: %w", err)
      }
      if rejected {
          return r.failRelease(ctx, release, result)
      }
      if approved {
          oldPhase := release.Status.Phase
          release.Status.Phase = paprikav1.ReleasePromoting
          metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Promoting").Inc()
          if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
              *result = resultError
              return ctrl.Result{}, fmt.Errorf("failed to transition from awaiting approval to promoting: %w", err)
          }
          return ctrl.Result{Requeue: true}, nil
      }
      return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
  }
  ```

- [ ] **Step 3: Check gates at the start of `handlePromotingPhase`**

  Replace the first lines of `handlePromotingPhase` (currently `oldPhase := release.Status.Phase; if err := r.promote(...)`):

  ```go
  func (r *ReleaseReconciler) handlePromotingPhase(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
      log := logf.FromContext(ctx)
      oldPhase := release.Status.Phase

      approved, rejected, err := r.checkApprovalGates(ctx, release)
      if err != nil {
          log.Error(err, "Failed to check approval gates", "release", release.Name)
          release.Status.Phase = paprikav1.ReleaseFailed
          metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "Failed").Inc()
          if updateErr := r.patchReleaseStatus(ctx, release, oldPhase); updateErr != nil {
              *result = resultError
              return ctrl.Result{}, fmt.Errorf("failed to set release failed: %w", updateErr)
          }
          return ctrl.Result{}, nil
      }
      if rejected {
          return r.failRelease(ctx, release, result)
      }
      if !approved {
          release.Status.Phase = paprikav1.ReleaseAwaitingApproval
          metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "AwaitingApproval").Inc()
          if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
              *result = resultError
              return ctrl.Result{}, fmt.Errorf("failed to transition to awaiting approval: %w", err)
          }
          return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
      }

      if err := r.promote(ctx, release); err != nil {
          ...
      }
      ...
  }
  ```

- [ ] **Step 4: Treat `AwaitingApproval` as active in concurrency check**

  In `hasActiveConcurrentRelease` (around line 646) change the phase check to:

  ```go
  if other.Status.Phase == paprikav1.ReleasePromoting ||
      other.Status.Phase == paprikav1.ReleaseVerifying ||
      other.Status.Phase == paprikav1.ReleaseAwaitingApproval {
      return true, nil
  }
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add internal/controller/pipelines/release_controller.go
  git commit -m "feat(approval-gates): evaluate gates before promotion and add AwaitingApproval phase"
  ```

### Task 4: Remove the old blocking gate check from the Application controller

**Files:**
- Modify: `internal/controller/pipelines/application_controller.go`

- [ ] **Step 1: Remove the blocking call from `reconcileReleaseFlow`**

  Replace this block in `reconcileReleaseFlow` (around line 339):

  ```go
  if blocked, msg := r.checkGates(ctx, app); blocked {
      log.Info("Gate blocked release", "app", app.Name, "reason", msg)
      r.updatePhase(ctx, app, paprikav1.ApplicationPending, "GatePending", msg)
      return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
  }
  ```

  with a comment:

  ```go
  // Approval gates are now evaluated by the Release controller before promotion.
  ```

- [ ] **Step 2: Delete the now-unused gate helpers**

  Remove these functions (around lines 1193–1318): `checkGates`, `isGateRelevant`, `isGateApproved`, `recordPendingGate`, `gateStatusExists`. Keep `getTargetStage` because it is still used for sync windows.

- [ ] **Step 3: Map `ReleaseAwaitingApproval` to an Application phase**

  In `handleActiveRelease` (around line 813), add to `phaseMap`:

  ```go
  paprikav1.ReleaseAwaitingApproval: {paprikav1.ApplicationPromoting, "ReleaseAwaitingApproval", true},
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add internal/controller/pipelines/application_controller.go
  git commit -m "refactor(approval-gates): move gate blocking from Application to Release controller"
  ```

### Task 5: Add RBAC markers

**Files:**
- Modify: `internal/controller/pipelines/release_controller.go`

- [ ] **Step 1: Add RBAC markers near the top of the file**

  After the existing release RBAC markers (around line 140) add:

  ```go
  // +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications,verbs=get;update;patch
  // +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
  // +kubebuilder:rbac:groups=core,resources=secrets,verbs=get
  ```

- [ ] **Step 2: Regenerate manifests**

  ```bash
  make manifests
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add internal/controller/pipelines/release_controller.go config/rbac/role.yaml
  git commit -m "feat(approval-gates): add RBAC for application gate status updates"
  ```

---

## Chunk 4: API Server and Protocol Buffers

### Task 1: Extend the protobuf schema

**Files:**
- Modify: `proto/paprika/v1/api.proto`

- [ ] **Step 1: Extend `GateStatus`**

  Replace the existing `GateStatus` message (around line 114) with:

  ```protobuf
  message GateStatus {
    string name = 1;
    string stage = 2;
    string status = 3;
    string approved_by = 4;
    string type = 5;
    string message = 6;
  }
  ```

- [ ] **Step 2: Add new request/response messages**

  Insert after `ApproveGateResponse` (around line 395):

  ```protobuf
  message ListGateStatusRequest {
    string namespace = 1;
    string name = 2;
  }

  message ListGateStatusResponse {
    repeated GateStatus gates = 1;
  }

  message RejectGateRequest {
    string name = 1;
    string namespace = 2;
    string gate = 3;
  }

  message RejectGateResponse {
    Application application = 1;
  }
  ```

- [ ] **Step 3: Add RPCs to `PaprikaService`**

  Add to the service block after `ApproveGate`:

  ```protobuf
  rpc ListGateStatus(ListGateStatusRequest) returns (ListGateStatusResponse);
  rpc RejectGate(RejectGateRequest) returns (RejectGateResponse);
  ```

- [ ] **Step 4: Regenerate protobuf clients**

  ```bash
  make generate-proto
  ```

  Expected: `internal/api/paprika/v1/api.pb.go` and `ui/src/gen/paprika/v1/*` are updated with the new fields and RPCs.

- [ ] **Step 5: Commit**

  ```bash
  git add proto/paprika/v1/api.proto internal/api/paprika/v1/api.pb.go ui/src/gen/paprika/v1
  git commit -m "feat(approval-gates): add ListGateStatus and RejectGate RPCs"
  ```

### Task 2: Implement server handlers

**Files:**
- Modify: `internal/api/server.go`

- [ ] **Step 1: Add RBAC marker for application status**

  Above `ApproveGate` (around line 461) add:

  ```go
  // +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
  ```

- [ ] **Step 2: Add `convertGateStatuses` helper**

  Insert near other `convert*` helpers:

  ```go
  func convertGateStatuses(statuses []pipelinesv1alpha1.GateStatus) []*paprikav1.GateStatus {
      out := make([]*paprikav1.GateStatus, 0, len(statuses))
      for _, s := range statuses {
          out = append(out, &paprikav1.GateStatus{
              Name:       s.Name,
              Stage:      s.Stage,
              Type:       s.Type,
              Status:     s.Status,
              ApprovedBy: s.ApprovedBy,
              Message:    s.Message,
          })
      }
      return out
  }
  ```

- [ ] **Step 3: Surface gate statuses in `convertApplication`**

  In `convertApplication` (around line 867), add before the closing `}` of the returned struct:

  ```go
  Gates: convertGateStatuses(a.Status.Gates),
  ```

- [ ] **Step 4: Implement `ListGateStatus`**

  Add after `ApproveGate`:

  ```go
  func (s *PaprikaServer) ListGateStatus(
      ctx context.Context,
      req *connect.Request[paprikav1.ListGateStatusRequest],
  ) (*connect.Response[paprikav1.ListGateStatusResponse], error) {
      var app pipelinesv1alpha1.Application
      if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
          return nil, fmt.Errorf("getting application: %w", err)
      }
      if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
          return nil, connect.NewError(connect.CodePermissionDenied, err)
      }
      return connect.NewResponse(&paprikav1.ListGateStatusResponse{Gates: convertGateStatuses(app.Status.Gates)}), nil
  }
  ```

- [ ] **Step 5: Implement `RejectGate`**

  Add after `ListGateStatus`:

  ```go
  func (s *PaprikaServer) RejectGate(
      ctx context.Context,
      req *connect.Request[paprikav1.RejectGateRequest],
  ) (*connect.Response[paprikav1.RejectGateResponse], error) {
      var app pipelinesv1alpha1.Application
      if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &app); err != nil {
          return nil, fmt.Errorf("getting application: %w", err)
      }
      if err := s.authorizeApplication(ctx, auth.ActionWrite, &app); err != nil {
          return nil, connect.NewError(connect.CodePermissionDenied, err)
      }

      found := false
      for i, g := range app.Status.Gates {
          if g.Name == req.Msg.Gate {
              app.Status.Gates[i].Status = pipelinesv1alpha1.GateStatusRejected
              app.Status.Gates[i].ApprovedBy = ""
              found = true
              break
          }
      }
      if !found {
          return nil, fmt.Errorf("gate %s not found", req.Msg.Gate)
      }

      if err := s.client.Status().Update(ctx, &app); err != nil {
          return nil, fmt.Errorf("updating gate status: %w", err)
      }

      var refreshed pipelinesv1alpha1.Application
      if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.Namespace, Name: req.Msg.Name}, &refreshed); err != nil {
          return nil, fmt.Errorf("getting refreshed application: %w", err)
      }

      return connect.NewResponse(&paprikav1.RejectGateResponse{Application: convertApplication(&refreshed)}), nil
  }
  ```

- [ ] **Step 6: Update `ApproveGate` to use typed constants**

  In the existing `ApproveGate` handler, change the status assignment to:

  ```go
  app.Status.Gates[i].Status = pipelinesv1alpha1.GateStatusApproved
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add internal/api/server.go
  git commit -m "feat(approval-gates): implement ListGateStatus and RejectGate handlers"
  ```

---

## Chunk 5: CLI Commands

### Task 1: Extend `paprika gates`

**Files:**
- Modify: `cmd/paprika/gates.go`

- [ ] **Step 1: Add helper to render gate statuses**

  Insert at the top of `cmd/paprika/gates.go` after imports:

  ```go
  import (
      ...existing imports...
      "io"
      "text/tabwriter"
  )

  func writeGateStatuses(w io.Writer, output string, gates []*paprikav1.GateStatus) error {
      switch output {
      case outputJSON, outputYAML:
          return writeProtoOutput(w, output, &paprikav1.ListGateStatusResponse{Gates: gates})
      case outputTable:
          tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
          if _, err := fmt.Fprintln(tw, "NAME\tSTAGE\tTYPE\tSTATUS\tAPPROVED BY\tMESSAGE"); err != nil {
              return fmt.Errorf("write header: %w", err)
          }
          for _, g := range gates {
              if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", g.Name, g.Stage, g.Type, g.Status, g.ApprovedBy, g.Message); err != nil {
                  return fmt.Errorf("write row: %w", err)
              }
          }
          return tw.Flush()
      default:
          return fmt.Errorf("unknown output format %q", output)
      }
  }
  ```

- [ ] **Step 2: Add `list` subcommand**

  Add to `newGatesCmd` before returning `cmd`:

  ```go
  cmd.AddCommand(&cobra.Command{
      Use:   "list APP",
      Short: "List approval gates for an application",
      Args:  cobra.ExactArgs(1),
      RunE: func(cmd *cobra.Command, args []string) error {
          client, err := clientFn()
          if err != nil {
              return fmt.Errorf("create client: %w", err)
          }
          res, err := client.ListGateStatus(ctx, connect.NewRequest(&paprikav1.ListGateStatusRequest{
              Name:      args[0],
              Namespace: nsFn(),
          }))
          if err != nil {
              return fmt.Errorf("list gate status: %w", err)
          }
          return writeGateStatuses(cmd.OutOrStdout(), *output, res.Msg.Gates)
      },
  })
  ```

- [ ] **Step 3: Add `reject` subcommand**

  Add after the `approve` command block:

  ```go
  cmd.AddCommand(&cobra.Command{
      Use:   "reject APP GATE",
      Short: "Reject a gate for an application",
      Args:  cobra.ExactArgs(2),
      RunE: func(cmd *cobra.Command, args []string) error {
          client, err := clientFn()
          if err != nil {
              return fmt.Errorf("create client: %w", err)
          }
          res, err := client.RejectGate(ctx, connect.NewRequest(&paprikav1.RejectGateRequest{
              Name:      args[0],
              Namespace: nsFn(),
              Gate:      args[1],
          }))
          if err != nil {
              return fmt.Errorf("reject gate: %w", err)
          }
          return writeApplication(cmd.OutOrStdout(), *output, res.Msg.Application)
      },
  })
  ```

- [ ] **Step 4: Build and test the CLI**

  ```bash
  go build ./cmd/paprika
  ./paprika gates --help
  ```

  Expected: `list`, `approve`, and `reject` subcommands are shown.

- [ ] **Step 5: Commit**

  ```bash
  git add cmd/paprika/gates.go
  git commit -m "feat(approval-gates): add gates list/reject CLI commands"
  ```

---

## Chunk 6: UI Updates

### Task 1: Display `AwaitingApproval` in the status badge

**Files:**
- Modify: `ui/src/components/ui/status-badge.tsx`

- [ ] **Step 1: Add the mapping**

  Insert into `statusConfig`:

  ```ts
  AwaitingApproval: {
    icon: PauseCircle,
    className: "bg-warning/10 text-warning border-warning/20",
  },
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add ui/src/components/ui/status-badge.tsx
  git commit -m "feat(approval-gates): add AwaitingApproval status badge"
  ```

### Task 2: Show pending gates and approve/reject buttons

**Files:**
- Modify: `ui/src/app/dashboard/application/page.tsx`

- [ ] **Step 1: Import `ShieldAlert` and add state**

  Add to imports (already imported `ShieldAlert`, confirm it is present). Add state inside `ApplicationDetail`:

  ```ts
  const [actingGate, setActingGate] = useState<string | null>(null);
  ```

- [ ] **Step 2: Add approve/reject handlers**

  After `handleRollback`:

  ```ts
  const handleGateAction = useCallback(
    async (gateName: string, action: "approve" | "reject") => {
      if (!application) return;
      setActingGate(gateName);
      try {
        if (action === "approve") {
          await client.approveGate({ namespace, name, gate: gateName });
        } else {
          await client.rejectGate({ namespace, name, gate: gateName });
        }
        await fetchData();
      } catch (err) {
        setError(`${action === "approve" ? "Approval" : "Rejection"} failed for ${gateName}`);
        console.error(err);
      } finally {
        setActingGate(null);
      }
    },
    [application, namespace, name, fetchData],
  );
  ```

- [ ] **Step 3: Render the gates card**

  Insert after the top metrics grid (after the closing `</div>` of the grid around line 273):

  ```tsx
  {application.gates && application.gates.length > 0 && (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5" />
          Approval Gates
        </CardTitle>
        <CardDescription>Gates that must pass before promotion continues.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {application.gates.map((gate) => (
              <TableRow key={gate.name}>
                <TableCell className="font-medium">{gate.name}</TableCell>
                <TableCell>{gate.stage || "—"}</TableCell>
                <TableCell>{gate.type || "—"}</TableCell>
                <TableCell>
                  <StatusBadge status={gate.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">{gate.message || "—"}</TableCell>
                <TableCell className="text-right">
                  {gate.status === "Pending" && (
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleGateAction(gate.name, "approve")}
                        disabled={actingGate === gate.name}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleGateAction(gate.name, "reject")}
                        disabled={actingGate === gate.name}
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )}
  ```

- [ ] **Step 4: Run the UI type check**

  ```bash
  cd ui && npm run typecheck
  ```

  Expected: no new type errors.

- [ ] **Step 5: Commit**

  ```bash
  git add ui/src/app/dashboard/application/page.tsx ui/src/components/ui/status-badge.tsx
  git commit -m "feat(approval-gates): show gates and approve/reject in UI"
  ```

---

## Chunk 7: Tests and Verification

### Task 1: Unit-test the release controller gate flow

**Files:**
- Modify: `internal/controller/pipelines/release_controller_unit_test.go`

- [ ] **Step 1: Add a fake approval evaluator**

  Insert after `fakeGateExecutor`:

  ```go
  type fakeApprovalEvaluator struct {
      results map[string]gates.ApprovalGateResult
  }

  func (f *fakeApprovalEvaluator) Evaluate(_ context.Context, gate gates.ApprovalGate, _ gates.ApprovalGatePayload, _ string) gates.ApprovalGateResult {
      if r, ok := f.results[gate.Name]; ok {
          return r
      }
      return gates.ApprovalGateResult{Status: gates.ApprovalGateStatusPending}
  }
  ```

- [ ] **Step 2: Add tests for pending, approved, and rejected gates**

  Append to the test file:

  ```go
  func TestReleaseReconciler_handlePromotingPhase_awaitsApproval(t *testing.T) {
      ctx := context.Background()
      scheme := runtime.NewScheme()
      _ = pipelinesv1alpha1.AddToScheme(scheme)
      _ = corev1.AddToScheme(scheme)

      app := &pipelinesv1alpha1.Application{
          ObjectMeta: metav1.ObjectMeta{Name: "gate-app", Namespace: "default", UID: types.UID("uid")},
          Spec: pipelinesv1alpha1.ApplicationSpec{
              ApprovalGates: []pipelinesv1alpha1.ApprovalGate{
                  {Name: "manual-gate", Type: pipelinesv1alpha1.ApprovalGateTypeManual, Required: true},
              },
          },
      }
      stage := &pipelinesv1alpha1.Stage{
          ObjectMeta: metav1.ObjectMeta{Name: "gate-stage", Namespace: "default"},
          Spec: pipelinesv1alpha1.StageSpec{Name: "dev", Ring: 1, Templates: []string{}},
      }
      release := &pipelinesv1alpha1.Release{
          ObjectMeta: metav1.ObjectMeta{
              Name:      "gate-release",
              Namespace: "default",
              OwnerReferences: []metav1.OwnerReference{{
                  APIVersion: pipelinesv1alpha1.GroupVersion.String(),
                  Kind:       "Application",
                  Name:       app.Name,
                  UID:        app.UID,
              }},
          },
          Spec: pipelinesv1alpha1.ReleaseSpec{Target: stage.Name},
          Status: pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleasePromoting},
      }

      c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, stage, release).WithStatusSubresource(&pipelinesv1alpha1.Release{}, &pipelinesv1alpha1.Application{}).Build()
      r := &ReleaseReconciler{
          client:                c,
          Scheme:                scheme,
          ApprovalGateEvaluator: &fakeApprovalEvaluator{},
      }

      _, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: release.Name, Namespace: release.Namespace}})
      if err != nil {
          t.Fatalf("reconcile error: %v", err)
      }

      var updated pipelinesv1alpha1.Release
      if err := c.Get(ctx, client.ObjectKeyFromObject(release), &updated); err != nil {
          t.Fatalf("get release: %v", err)
      }
      if updated.Status.Phase != pipelinesv1alpha1.ReleaseAwaitingApproval {
          t.Errorf("phase = %s, want AwaitingApproval", updated.Status.Phase)
      }

      var updatedApp pipelinesv1alpha1.Application
      if err := c.Get(ctx, client.ObjectKeyFromObject(app), &updatedApp); err != nil {
          t.Fatalf("get app: %v", err)
      }
      if len(updatedApp.Status.Gates) != 1 || updatedApp.Status.Gates[0].Status != pipelinesv1alpha1.GateStatusPending {
          t.Errorf("gate status = %+v, want one Pending", updatedApp.Status.Gates)
      }
  }

  func TestReleaseReconciler_handleAwaitingApprovalPhase_promotesWhenApproved(t *testing.T) {
      ctx := context.Background()
      scheme := runtime.NewScheme()
      _ = pipelinesv1alpha1.AddToScheme(scheme)
      _ = corev1.AddToScheme(scheme)

      app := &pipelinesv1alpha1.Application{
          ObjectMeta: metav1.ObjectMeta{Name: "gate-app", Namespace: "default", UID: types.UID("uid")},
          Spec: pipelinesv1alpha1.ApplicationSpec{
              ApprovalGates: []pipelinesv1alpha1.ApprovalGate{
                  {Name: "manual-gate", Type: pipelinesv1alpha1.ApprovalGateTypeManual, Required: true},
              },
          },
          Status: pipelinesv1alpha1.ApplicationStatus{
              Gates: []pipelinesv1alpha1.GateStatus{
                  {Name: "manual-gate", Status: pipelinesv1alpha1.GateStatusApproved, ApprovedBy: "test"},
              },
          },
      }
      stage := &pipelinesv1alpha1.Stage{
          ObjectMeta: metav1.ObjectMeta{Name: "gate-stage", Namespace: "default"},
          Spec: pipelinesv1alpha1.StageSpec{Name: "dev", Ring: 1, Templates: []string{}},
      }
      release := &pipelinesv1alpha1.Release{
          ObjectMeta: metav1.ObjectMeta{
              Name:      "gate-release",
              Namespace: "default",
              OwnerReferences: []metav1.OwnerReference{{
                  APIVersion: pipelinesv1alpha1.GroupVersion.String(),
                  Kind:       "Application",
                  Name:       app.Name,
                  UID:        app.UID,
              }},
          },
          Spec: pipelinesv1alpha1.ReleaseSpec{Target: stage.Name},
          Status: pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleaseAwaitingApproval},
      }

      c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, stage, release).WithStatusSubresource(&pipelinesv1alpha1.Release{}, &pipelinesv1alpha1.Application{}).Build()
      r := &ReleaseReconciler{
          client:                c,
          Scheme:                scheme,
          ApprovalGateEvaluator: &fakeApprovalEvaluator{},
      }

      _, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: release.Name, Namespace: release.Namespace}})
      if err != nil {
          t.Fatalf("reconcile error: %v", err)
      }

      var updated pipelinesv1alpha1.Release
      if err := c.Get(ctx, client.ObjectKeyFromObject(release), &updated); err != nil {
          t.Fatalf("get release: %v", err)
      }
      if updated.Status.Phase != pipelinesv1alpha1.ReleasePromoting {
          t.Errorf("phase = %s, want Promoting", updated.Status.Phase)
      }
  }
  ```

- [ ] **Step 3: Run the new unit tests**

  ```bash
  go test ./internal/controller/pipelines/... -run TestReleaseReconciler_handlePromotingPhase_awaitsApproval -v
  go test ./internal/controller/pipelines/... -run TestReleaseReconciler_handleAwaitingApprovalPhase_promotesWhenApproved -v
  ```

  Expected: PASS.

- [ ] **Step 4: Commit**

  ```bash
  git add internal/controller/pipelines/release_controller_unit_test.go
  git commit -m "test(approval-gates): add release controller gate unit tests"
  ```

### Task 2: Add an E2E test for a manual gate

**Files:**
- Modify: `internal/controller/pipelines/release_controller_test.go`

- [ ] **Step 1: Add a new Ginkgo context**

  Append inside `Describe("Release Controller", func() { ... })`:

  ```go
  Context("when a manual approval gate is configured", func() {
      const (
          appName     = "manual-gate-app"
          stageName   = "manual-gate-stage"
          releaseName = "manual-gate-release"
      )

      ctx := context.Background()
      appKey := types.NamespacedName{Name: appName, Namespace: "default"}
      stageKey := types.NamespacedName{Name: stageName, Namespace: "default"}
      releaseKey := types.NamespacedName{Name: releaseName, Namespace: "default"}

      BeforeEach(func() {
          app := &pipelinesv1alpha1.Application{
              ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
              Spec: pipelinesv1alpha1.ApplicationSpec{
                  Source: pipelinesv1alpha1.ApplicationSource{Type: "inline"},
                  ApprovalGates: []pipelinesv1alpha1.ApprovalGate{
                      {Name: "prod-approval", Type: pipelinesv1alpha1.ApprovalGateTypeManual, Required: true},
                  },
                  Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
                      {Name: stageName, Ring: 1},
                  },
              },
          }
          Expect(k8sClient.Create(ctx, app)).To(Succeed())

          stage := &pipelinesv1alpha1.Stage{
              ObjectMeta: metav1.ObjectMeta{Name: stageName, Namespace: "default"},
              Spec: pipelinesv1alpha1.StageSpec{Name: stageName, Ring: 1, Templates: []string{}},
          }
          Expect(k8sClient.Create(ctx, stage)).To(Succeed())
      })

      AfterEach(func() {
          By("cleaning up the release")
          release := &pipelinesv1alpha1.Release{ObjectMeta: metav1.ObjectMeta{Name: releaseName, Namespace: "default"}}
          Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, release))).To(Succeed())
          By("cleaning up the stage")
          stage := &pipelinesv1alpha1.Stage{ObjectMeta: metav1.ObjectMeta{Name: stageName, Namespace: "default"}}
          Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, stage))).To(Succeed())
          By("cleaning up the application")
          app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"}}
          Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, app))).To(Succeed())
      })

      It("should pause promotion until the gate is approved", func() {
          release := &pipelinesv1alpha1.Release{
              ObjectMeta: metav1.ObjectMeta{
                  Name:      releaseName,
                  Namespace: "default",
                  OwnerReferences: []metav1.OwnerReference{{
                      APIVersion: pipelinesv1alpha1.GroupVersion.String(),
                      Kind:       "Application",
                      Name:       appName,
                  }},
              },
              Spec: pipelinesv1alpha1.ReleaseSpec{
                  Target: stageName,
                  ManifestSource: &pipelinesv1alpha1.ManifestSource{
                      ConfigMapRef: "",
                  },
              },
          }
          Expect(k8sClient.Create(ctx, release)).To(Succeed())

          controller := &ReleaseReconciler{
              client:                k8sClient,
              Scheme:                k8sClient.Scheme(),
              Namespace:             "default",
              ApprovalGateEvaluator: gates.NewApprovalGateEvaluator(http.DefaultClient),
              Clock:                 clock.NewFake(time.Now()),
          }

          By("reconciling the release while the gate is pending")
          _, err := controller.Reconcile(ctx, reconcile.Request{NamespacedName: releaseKey})
          Expect(err).NotTo(HaveOccurred())

          var updated pipelinesv1alpha1.Release
          Eventually(func() pipelinesv1alpha1.ReleasePhase {
              Expect(k8sClient.Get(ctx, releaseKey, &updated)).To(Succeed())
              return updated.Status.Phase
          }, 5*time.Second, 200*time.Millisecond).Should(Equal(pipelinesv1alpha1.ReleaseAwaitingApproval))

          var app pipelinesv1alpha1.Application
          Expect(k8sClient.Get(ctx, appKey, &app)).To(Succeed())
          Expect(app.Status.Gates).To(HaveLen(1))
          Expect(app.Status.Gates[0].Status).To(Equal(pipelinesv1alpha1.GateStatusPending))

          By("approving the gate")
          app.Status.Gates[0].Status = pipelinesv1alpha1.GateStatusApproved
          app.Status.Gates[0].ApprovedBy = "e2e"
          Expect(k8sClient.Status().Update(ctx, &app)).To(Succeed())

          By("reconciling the release after approval")
          _, err = controller.Reconcile(ctx, reconcile.Request{NamespacedName: releaseKey})
          Expect(err).NotTo(HaveOccurred())

          Eventually(func() pipelinesv1alpha1.ReleasePhase {
              Expect(k8sClient.Get(ctx, releaseKey, &updated)).To(Succeed())
              return updated.Status.Phase
          }, 5*time.Second, 200*time.Millisecond).Should(Equal(pipelinesv1alpha1.ReleasePromoting))
      })
  })
  ```

  Note: adjust the test if `ManifestSource` is not needed; the important behavior is the phase transition.

- [ ] **Step 2: Run the E2E test**

  ```bash
  make test-e2e
  ```

  Expected: the new manual-gate test passes along with the existing suite.

- [ ] **Step 3: Commit**

  ```bash
  git add internal/controller/pipelines/release_controller_test.go
  git commit -m "test(approval-gates): add E2E test for manual gate"
  ```

### Task 3: Final verification

- [ ] **Step 1: Run the full Go test suite**

  ```bash
  make test
  ```

  Expected: all unit and envtest tests pass.

- [ ] **Step 2: Run lint**

  ```bash
  make lint
  ```

  Expected: no lint errors.

- [ ] **Step 3: Type-check the UI**

  ```bash
  cd ui && npm run typecheck
  ```

  Expected: no type errors.

- [ ] **Step 4: Verify no unrelated changes**

  ```bash
  git diff --stat
  ```

  Expected: only the planned files are modified.

- [ ] **Step 5: Final review checkpoint**

  Use @superpowers:verification-before-completion before declaring the feature done. Confirm:
  - `make test` passes
  - `make lint` passes
  - `make test-e2e` passes (manual gate test included)
  - UI typecheck passes

---

## Notes for Implementers

- **Slack gates:** The type/schema and Slack webhook URL fields are added, but actual Slack interaction handling is intentionally Phase 2. The evaluator returns `Pending` with the message `"Slack interaction is Phase 2"`.
- **Webhook gate secrets:** `SecretRef` is defined in the CRD but reading the Secret and injecting headers is also left as a follow-up unless trivial; the evaluator currently uses only `URL`, `Method`, `Headers`, `Body`, and `SuccessStatus`.
- **Approval precedence:** If a gate status already exists on the Application as `Approved` or `Rejected`, the evaluator preserves that state. This is what makes manual/UI approval durable across reconciles.
- **No breaking changes:** Existing `ApprovalGate` and `GateStatus` JSON fields are preserved; only new optional fields are added.
