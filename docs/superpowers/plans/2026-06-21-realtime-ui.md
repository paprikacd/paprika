# Real-Time UI — Extended Event Coverage

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard feel truly live by publishing broker events from all controllers and user actions, not just application/release phase changes.

**Architecture:** The codebase already has a mature SSE pipeline (event broker → SSE handler → UI EventSource → dashboard re-fetch). The gap is incomplete event sources — only application and release controllers publish. We need rollout events, user action events (from the audit interceptor), and gate approval/rejection events. The UI notification system already generically parses payload fields, so new event types work automatically.

**Tech Stack:** Go (event broker, controllers), TypeScript/React (UI), Helm (chart wiring)

---

## Files

### Create
- `internal/api/events/eventtypes.go` — shared event payload struct and helpers (extracted pattern from notification_controller.go)

### Modify
- `internal/api/events/broker.go` — add TypeRollout, TypeAudit, TypeGate event constants
- `internal/controller/rollouts/rollout_controller.go` — add EventBroker field, publish rollout phase events
- `internal/controller/pipelines/application_controller.go` — remove inline eventPayload, use shared type
- `internal/controller/pipelines/release_controller.go` — remove inline eventPayload, use shared type
- `internal/controller/pipelines/notification_controller.go` — remove eventPayload, import shared type
- `internal/api/audit_middleware.go` — accept EventBroker, publish audit events on mutating RPCs
- `internal/api/audit_middleware_test.go` — update constructor calls
- `internal/api/server.go` — pass broker to audit interceptor
- `cmd/main.go` — wire broker to audit interceptor creation
- `cmd/main_controllers.go` — wire broker to RolloutReconciler
- `internal/controller/rollouts/rollout_suite_test.go` — adapt for EventBroker if needed
- `ui/src/components/notifications/notification-center.tsx` — handle new event types with richer display

---

## Implementation

### Task 1: Shared event types

**Files:**
- Create: `internal/api/events/eventtypes.go`
- Modify: `internal/api/events/broker.go`

- [ ] **Step 1: Create event payload type and helper**

```go
// eventtypes.go
package events

import "time"

// EventPayload is the standard shape for resource phase-change events
// published by controllers and consumed by the UI / notification system.
type EventPayload struct {
	ResourceType  string `json:"resourceType"`
	Name          string `json:"name"`
	Namespace     string `json:"namespace"`
	Phase         string `json:"phase"`
	PreviousPhase string `json:"previousPhase,omitempty"`
	Reason        string `json:"reason,omitempty"`
	Message       string `json:"message,omitempty"`
	Timestamp     string `json:"timestamp"`
}

// AuditPayload is the payload for user action events from the audit interceptor.
type AuditPayload struct {
	Action    string `json:"action"`
	Resource  string `json:"resource"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Principal string `json:"principal"`
	Success   bool   `json:"success"`
	Error     string `json:"error,omitempty"`
	Timestamp string `json:"timestamp"`
}
```

- [ ] **Step 2: Add new event type constants to broker.go**

```go
const (
	TopicDashboard = "dashboard"
	TypeApplication = "application"
	TypeRelease     = "release"
	TypeRollout     = "rollout"
	TypeAudit       = "audit"
	TypeGate        = "gate"
)
```

- [ ] **Step 3: Run existing tests to confirm no regression**

Run: `cd /Users/benebsworth/projects/paprika && go test ./internal/api/events/ -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/api/events/eventtypes.go internal/api/events/broker.go
git commit -m "feat(events): add shared payload types and rollout/audit/gate event constants"
```

### Task 2: Wire RolloutReconciler with EventBroker

**Files:**
- Modify: `internal/controller/rollouts/rollout_controller.go`
- Modify: `cmd/main_controllers.go`

- [ ] **Step 1: Add EventBroker to RolloutReconciler struct**

Add field after `EventRecorder`:
```go
EventBroker *events.Broker
```

Add import for events package.

- [ ] **Step 2: Add publishRolloutEvent method**

After `patchStatusOrLog`, add:
```go
func (r *RolloutReconciler) publishRolloutEvent(ctx context.Context, ro *rolloutsv1alpha1.Rollout, previousPhase rolloutsv1alpha1.RolloutPhase) {
	if r.EventBroker == nil {
		return
	}
	evt, err := events.NewEvent(events.TypeRollout, events.EventPayload{
		ResourceType:  events.TypeRollout,
		Name:          ro.Name,
		Namespace:     ro.Namespace,
		Phase:         string(ro.Status.Phase),
		PreviousPhase: string(previousPhase),
		Reason:        "",
		Message:       ro.Status.Message,
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
	}, nil)
	if err != nil {
		logf.FromContext(ctx).Error(err, "Failed to create rollout event", "rollout", ro.Name)
		return
	}
	r.EventBroker.Publish(ctx, events.TopicDashboard, evt)
}
```

Add `"time"` to imports.

- [ ] **Step 3: Call publishRolloutEvent in Reconcile after phase changes**

In `Reconcile`, after `r.patchStatus(ctx, &ro)` at line 191-193, add:
```go
oldPhase := rolloutsv1alpha1.RolloutPhase("")
r.publishRolloutEvent(ctx, &ro, oldPhase)
```

To properly track old phase, capture before status update. Restructure to read `oldPhase` before `updateStatusFromResult`:
```go
oldPhase := ro.Status.Phase
// ... existing code ...
r.updateStatusFromResult(&ro, result)
// ... after patchStatus call ...
r.publishRolloutEvent(ctx, &ro, oldPhase)
```

- [ ] **Step 4: Wire EventBroker in cmd/main_controllers.go**

Find where RolloutReconciler is created (search for `RolloutReconciler{`), add:
```go
EventBroker: broker,
```

- [ ] **Step 5: Build to verify compilation**

Run: `cd /Users/benebsworth/projects/paprika && go build ./...`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add internal/controller/rollouts/rollout_controller.go cmd/main_controllers.go
git commit -m "feat(rollouts): publish rollout phase-change events via broker"
```

### Task 3: Publish audit events to broker (user action feedback)

**Files:**
- Modify: `internal/api/audit_middleware.go`
- Modify: `internal/api/audit_middleware_test.go`
- Modify: `internal/api/server.go`
- Modify: `cmd/main.go`

- [ ] **Step 1: Extend audit interceptor to accept broker**

Change `NewAuditInterceptor` signature:
```go
func NewAuditInterceptor(a audit.Auditor, broker *events.Broker) connect.UnaryInterceptorFunc {
```

Update the closure to publish to the broker after successful audit recording:
```go
// After a.Record(ctx, event) at line 63:
if broker != nil {
    auditEvt, err := events.NewEvent(events.TypeAudit, events.AuditPayload{
        Action:    action,
        Resource:  resource,
        Name:      event.Name,
        Namespace: event.Namespace,
        Principal: event.Principal,
        Success:   event.Success,
        Error:     event.Error,
        Timestamp: event.Timestamp,
    }, nil)
    if err == nil {
        broker.Publish(ctx, events.TopicDashboard, auditEvt)
    }
}
```

Add `"github.com/benebsworth/paprika/internal/api/events"` import.

- [ ] **Step 2: Update test calls to NewAuditInterceptor**

In `audit_middleware_test.go`, update test helper to pass nil broker:
```go
interceptor := NewAuditInterceptor(auditor, nil)
```

- [ ] **Step 3: Update server.go constructor**

Find where `NewAuditInterceptor` is called, pass `s.broker`:
```go
func (s *PaprikaServer) AuditInterceptor() connect.UnaryInterceptorFunc {
    return NewAuditInterceptor(s.auditor, s.broker)
}
```

- [ ] **Step 4: Build to verify compilation**

Run: `cd /Users/benebsworth/projects/paprika && go build ./...`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add internal/api/audit_middleware.go internal/api/audit_middleware_test.go internal/api/server.go cmd/main.go
git commit -m "feat(audit): publish broker events for user actions (sync, approve, reject, promote, abort)"
```

### Task 4: Migration to shared event types

**Files:**
- Modify: `internal/controller/pipelines/application_controller.go`
- Modify: `internal/controller/pipelines/release_controller.go`
- Modify: `internal/controller/pipelines/notification_controller.go`

- [ ] **Step 1: Remove eventPayload from notification_controller.go**

Delete the `eventPayload` struct and `decodeEventPayload` function, replace with:
```go
import "github.com/benebsworth/paprika/internal/api/events"

// decodeEventPayload unmarshals the shared EventPayload from an event.
func decodeEventPayload(evt *events.Event) (*events.EventPayload, error) {
	var payload events.EventPayload
	if err := json.Unmarshal(evt.Payload, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal event payload: %w", err)
	}
	return &payload, nil
}
```

- [ ] **Step 2: Update application_controller.go**

Change `eventPayload{` in `publishApplicationEvent` to `events.EventPayload{`.

- [ ] **Step 3: Update release_controller.go**

Change `eventPayload{` in `publishReleaseEvent` to `events.EventPayload{`.

- [ ] **Step 4: Build to verify compilation**

Run: `cd /Users/benebsworth/projects/paprika && go build ./...`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add internal/controller/pipelines/application_controller.go internal/controller/pipelines/release_controller.go internal/controller/pipelines/notification_controller.go
git commit -m "refactor(events): use shared EventPayload type across controllers"
```

### Task 5: UI — Richer notification display for new event types

**Files:**
- Modify: `ui/src/components/notifications/notification-center.tsx`

- [ ] **Step 1: Add rollup/audit/gate type labels and icons**

Update the notification parsing in `notification-center.tsx` to add display logic for new types. The notification body should:
- For `rollout` events: "Rollout {ns}/{name} is now {phase}"
- For `audit` events: "{principal} {action} {resource}"
- For `gate` events: "Gate {name} {action} ({phase})"

```typescript
const typeLabels: Record<string, string> = {
  application: "Application",
  release: "Release",
  rollout: "Rollout",
  audit: "Audit",
  gate: "Gate",
}
```

Update the `title` and `body` construction:
```typescript
const eventType = data.type || ""
const label = typeLabels[eventType] || eventType
const title = payload.principal
  ? `${payload.namespace || ""}/${payload.name || ""}`
  : `${payload.namespace || ""}/${payload.name || ""}`
let body = ""
if (eventType === "audit") {
  body = `${payload.principal || "unknown"} ${payload.action} ${payload.resource}${payload.success ? "" : ` (failed: ${payload.error})`}`
} else if (eventType === "gate") {
  body = `Gate ${payload.name || ""} ${payload.reason || payload.phase || ""}`
} else {
  body = `${label} is now ${payload.phase}${payload.reason ? ` (${payload.reason})` : ""}`
}
```

- [ ] **Step 2: Build UI to verify**

Run: `cd /Users/benebsworth/projects/paprika/ui && npx next build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/notifications/notification-center.tsx
git commit -m "feat(ui): richer notification display for rollout, audit, and gate events"
```

### Task 6: Run tests

- [ ] **Step 1: Run go tests**

Run: `cd /Users/benebsworth/projects/paprika && make test 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 2: Run linter**

Run: `cd /Users/benebsworth/projects/paprika && make lint 2>&1 | tail -20`
Expected: No lint errors
