# Pipeline DAG Live Execution Streaming — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream per-step pipeline execution progress (start/running/completed with timestamps) to the DAG detail page in real time via the existing SSE channel.

**Architecture:** Add a step-progress callback to the workflow engine so the controller can patch `Pipeline.Status.StepStatuses` and emit a `pipeline/<ns>/<name>` SSE event on every step transition. Extend the SSE payload with optional `startedAt`/`completedAt` seconds and consume those timestamps on the frontend.

**Tech Stack:** Go (controller-runtime, client-go), Protobuf (no schema changes), Next.js + React Flow, Vitest.

---

## File Structure

| Layer | File | Responsibility |
|---|---|---|
| Backend | `internal/engine/workflow.go` | Add `StepProgressCallback` type; invoke it when a step starts and finishes inside `runStepJob` |
| Backend | `internal/controller/pipelines/pipeline_controller.go` | Provide a callback that patches status + publishes SSE after each step transition |
| Backend | `internal/api/events/eventtypes.go` | Add `StartedAt`/`CompletedAt` to `EventPayload` |
| Backend | `internal/controller/pipelines/pipeline_controller.go` | Update `publishPipelineEvent` to include timestamps from step status |
| Frontend | `ui/src/lib/pipeline-sse.ts` | Extend `PipelineSSEEvent` type with `startedAt`/`completedAt` |
| Frontend | `ui/src/app/dashboard/pipelines/detail/page.tsx` | Merge timestamps from SSE events into step statuses |
| Frontend | `ui/src/components/dashboard/step-detail-panel.tsx` | Show elapsed time while a step is Running |
| Tests | `internal/engine/workflow_test.go` | Verify callback is invoked on step start and finish |
| Tests | `internal/controller/pipelines/pipeline_events_test.go` | Verify per-step SSE events include timestamps |
| Tests | `ui/src/app/dashboard/__tests__/pipeline-sse.test.tsx` | Verify timestamp fields are parsed and passed through |

---

## Chunk 1: Backend — Workflow Engine Progress Callback

**Files:**
- Modify: `internal/engine/workflow.go`
- Modify: `internal/controller/pipelines/workflow.go`
- Test: `internal/engine/workflow_test.go`

### Task 1a: Define StepProgressCallback type

- [ ] **Step 1: Add callback type to engine package**

Open `internal/engine/workflow.go` and add after the existing types:

```go
// StepProgress reports a step transition during pipeline execution.
type StepProgress struct {
	Name        string
	Phase       paprika.StepPhase
	StartedAt   *metav1.Time
	CompletedAt *metav1.Time
}

// StepProgressCallback is invoked synchronously when a step changes phase.
type StepProgressCallback func(ctx context.Context, pipeline *paprika.Pipeline, progress StepProgress)
```

- [ ] **Step 2: Wire callback into WorkflowEngine and RunPipeline**

Change `WorkflowEngine` struct and `RunPipeline` signature:

```go
type WorkflowEngine struct {
	Client    kubernetes.Interface
	Namespace string
}

func (e *WorkflowEngine) RunPipeline(ctx context.Context, pipeline *paprika.Pipeline, onProgress StepProgressCallback) ([]paprika.StepStatus, error) {
```

Update `executeSubBatch` and `runStepJob` signatures to accept and call `onProgress`.

```go
func (e *WorkflowEngine) executeSubBatch(ctx context.Context, batch []paprika.PipelineStep, pipelineName string, maxParallel int, completed map[string]bool, stepStatuses *[]paprika.StepStatus, mu *sync.Mutex, onProgress StepProgressCallback) error {
```

```go
func (e *WorkflowEngine) runStepJob(ctx context.Context, pipeline *paprika.Pipeline, s *paprika.PipelineStep, completed map[string]bool, stepStatuses *[]paprika.StepStatus, mu *sync.Mutex, onProgress StepProgressCallback) error {
```

Inside `runStepJob`, after setting `status.Phase = paprika.StepRunning` and `status.StartedAt`, call:

```go
if onProgress != nil {
    onProgress(ctx, pipeline, StepProgress{Name: s.Name, Phase: status.Phase, StartedAt: status.StartedAt})
}
```

After `watchJob` returns and the final `status.Phase`/`status.CompletedAt` are set, before appending to `stepStatuses`, call:

```go
if onProgress != nil {
    onProgress(ctx, pipeline, StepProgress{Name: s.Name, Phase: status.Phase, StartedAt: status.StartedAt, CompletedAt: status.CompletedAt})
}
```

- [ ] **Step 3: Update PipelineRunner interface**

In `internal/controller/pipelines/workflow.go`, change the interface to accept the callback:

```go
type PipelineRunner interface {
	RunPipeline(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, onProgress pipelines.StepProgressCallback) ([]pipelinesv1alpha1.StepStatus, error)
}
```

Wait — the callback type lives in `internal/engine`, which would create an import cycle if `internal/controller/pipelines` imports it. Define a local callback type in `internal/controller/pipelines/workflow.go` instead:

```go
// StepProgressCallback is invoked by the workflow engine when a step changes phase.
type StepProgressCallback func(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, step pipelinesv1alpha1.StepStatus)

type PipelineRunner interface {
	RunPipeline(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, onProgress StepProgressCallback) ([]pipelinesv1alpha1.StepStatus, error)
}
```

Then in `internal/engine/workflow.go` convert/adapt: the engine callback takes `(ctx, pipeline, progress)` and the controller callback takes `(ctx, pipeline, stepStatus)`. Keep them separate to avoid cycles.

- [ ] **Step 4: Write test for callback invocation**

Add to `internal/engine/workflow_test.go`:

```go
func TestRunPipeline_InvokesProgressCallback(t *testing.T) {
	fakeClient := fake.NewSimpleClientset()
	engine := NewWorkflowEngine(fakeClient, "default")

	pipeline := &paprika.Pipeline{
		ObjectMeta: metav1.ObjectMeta{Name: "pipe"},
		Spec: paprika.PipelineSpec{
			Steps: []paprika.PipelineStep{{Name: "build", Image: "busybox", Script: "echo ok"}},
		},
	}

	var progress []StepProgress
	onProgress := func(_ context.Context, _ *paprika.Pipeline, p StepProgress) {
		progress = append(progress, p)
	}

	_, err := engine.RunPipeline(context.Background(), pipeline, onProgress)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(progress), 2, "expected at least start + finish callbacks")
	require.Equal(t, "build", progress[0].Name)
	require.Equal(t, paprika.StepRunning, progress[0].Phase)
	require.NotNil(t, progress[0].StartedAt)
	require.Equal(t, "build", progress[len(progress)-1].Name)
	require.Equal(t, paprika.StepSucceeded, progress[len(progress)-1].Phase)
	require.NotNil(t, progress[len(progress)-1].CompletedAt)
}
```

- [ ] **Step 5: Run the new test and fix failures**

Run: `go test ./internal/engine/ -run TestRunPipeline_InvokesProgressCallback -v`
Expected: PASS

- [ ] **Step 6: Update existing engine tests**

Find all existing `engine.RunPipeline(...)` calls in `internal/engine/workflow_test.go` and change them to pass `nil` for the callback, or update the test helper if one exists.

Run: `go test ./internal/engine/ -count=1`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add internal/engine/workflow.go internal/controller/pipelines/workflow.go internal/engine/workflow_test.go
git commit -m "feat(engine): add StepProgressCallback to pipeline execution"
```

---

## Chunk 2: Backend — Controller Per-Step SSE Publishing

**Files:**
- Modify: `internal/controller/pipelines/pipeline_controller.go`
- Modify: `internal/api/events/eventtypes.go`
- Test: `internal/controller/pipelines/pipeline_events_test.go`

### Task 2a: Extend EventPayload with timestamps

- [ ] **Step 1: Add timestamp fields to EventPayload**

In `internal/api/events/eventtypes.go`:

```go
type EventPayload struct {
	ResourceType  string `json:"resourceType"`
	Name          string `json:"name"`
	Namespace     string `json:"namespace"`
	Phase         string `json:"phase"`
	PreviousPhase string `json:"previousPhase,omitempty"`
	Reason        string `json:"reason,omitempty"`
	Message       string `json:"message,omitempty"`
	Timestamp     string `json:"timestamp"`
	StartedAt     *int64 `json:"startedAt,omitempty"`
	CompletedAt   *int64 `json:"completedAt,omitempty"`
}
```

- [ ] **Step 2: Update controller publish helpers**

In `internal/controller/pipelines/pipeline_controller.go`, change `publishPipelineEvent` to optionally accept step timestamps. Add a helper that finds the step status by name:

```go
func stepStatusFor(pipeline *pipelinesv1alpha1.Pipeline, name string) *pipelinesv1alpha1.StepStatus {
	for i := range pipeline.Status.StepStatuses {
		if pipeline.Status.StepStatuses[i].Name == name {
			return &pipeline.Status.StepStatuses[i]
		}
	}
	return nil
}
```

Update `publishPipelineEvent`:

```go
func (r *PipelineReconciler) publishPipelineEvent(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, stepName string) {
	if r.EventBroker == nil {
		return
	}
	payload := events.EventPayload{
		ResourceType: events.TypePipeline,
		Namespace:    pipeline.Namespace,
		Timestamp:    time.Now().UTC().Format(time.RFC3339),
	}
	if stepName == "" {
		payload.Name = pipeline.Name
		payload.Phase = string(pipeline.Status.Phase)
	} else {
		payload.Name = stepName
		st := stepStatusFor(pipeline, stepName)
		if st != nil {
			payload.Phase = string(st.Phase)
			if st.StartedAt != nil {
				payload.StartedAt = ptr(st.StartedAt.Unix())
			}
			if st.CompletedAt != nil {
				payload.CompletedAt = ptr(st.CompletedAt.Unix())
			}
		}
	}
	...
}
```

`ptr` helper already exists in `internal/api/server.go` but is in a different package. Define a small local helper in `pipeline_controller.go` or use a local variable.

- [ ] **Step 3: Patch status on each step progress callback**

In `reconcilePipeline`, before calling `RunPipeline`, build a progress callback:

```go
pipelineCopy := pipeline.DeepCopy()
onProgress := func(ctx context.Context, p *pipelinesv1alpha1.Pipeline, st pipelinesv1alpha1.StepStatus) {
    r.updateStepStatus(ctx, pipelineCopy, st)
    r.publishPipelineEvent(ctx, pipelineCopy, st.Name)
}
stepStatuses, err := r.WorkflowEngine.RunPipeline(ctx, pipelineCopy, onProgress)
```

Implement `updateStepStatus`:

```go
func (r *PipelineReconciler) updateStepStatus(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, st pipelinesv1alpha1.StepStatus) {
	found := false
	for i := range pipeline.Status.StepStatuses {
		if pipeline.Status.StepStatuses[i].Name == st.Name {
			pipeline.Status.StepStatuses[i] = st
			found = true
			break
		}
	}
	if !found {
		pipeline.Status.StepStatuses = append(pipeline.Status.StepStatuses, st)
	}
	if err := r.patchPipelineStatus(ctx, pipeline); err != nil {
		logf.FromContext(ctx).Error(err, "Failed to patch step status", "pipeline", pipeline.Name, "step", st.Name)
	}
}
```

Important: use `pipelineCopy` for the running workflow and copy the final status back to the original `pipeline` before `handlePipelineResult`. Or pass `pipeline` directly if the engine does not mutate it. Verify the engine only reads `pipeline.Spec` and `pipeline.Name`.

- [ ] **Step 4: Write controller SSE timestamp test**

Extend `internal/controller/pipelines/pipeline_events_test.go`:

```go
func TestPublishPipelineEvent_IncludesTimestamps(t *testing.T) {
	broker := events.NewBroker(logr.Discard())
	r := &PipelineReconciler{EventBroker: broker, Clock: clock.Real{}}
	pipeline := &pipelinesv1alpha1.Pipeline{
		ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "ns"},
		Status: pipelinesv1alpha1.PipelineStatus{
			Phase: pipelinesv1alpha1.PipelineRunning,
			StepStatuses: []pipelinesv1alpha1.StepStatus{
				{
					Name:        "build",
					Phase:       pipelinesv1alpha1.StepSucceeded,
					StartedAt:   &metav1.Time{Time: time.Unix(1000, 0)},
					CompletedAt: &metav1.Time{Time: time.Unix(1010, 0)},
				},
			},
		},
	}

	ctx := context.Background()
	ch := broker.Subscribe(ctx, "pipeline/ns/p")
	r.publishPipelineEvent(ctx, pipeline, "build")

	select {
	case evt := <-ch:
		require.Equal(t, events.TypePipeline, evt.Type)
		var payload events.EventPayload
		require.NoError(t, json.Unmarshal(evt.Payload, &payload))
		require.Equal(t, "build", payload.Name)
		require.Equal(t, "Succeeded", payload.Phase)
		require.NotNil(t, payload.StartedAt)
		require.Equal(t, int64(1000), *payload.StartedAt)
		require.NotNil(t, payload.CompletedAt)
		require.Equal(t, int64(1010), *payload.CompletedAt)
	case <-time.After(2 * time.Second):
		t.Fatal("expected pipeline event")
	}
}
```

Add required imports (`encoding/json`).

- [ ] **Step 5: Run tests**

Run: `go test ./internal/controller/pipelines/ -count=1`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add internal/api/events/eventtypes.go internal/controller/pipelines/pipeline_controller.go internal/controller/pipelines/pipeline_events_test.go
git commit -m "feat(controller): publish per-step SSE events with timestamps"
```

---

## Chunk 3: Frontend — Consume Timestamps and Show Elapsed Time

**Files:**
- Modify: `ui/src/lib/pipeline-sse.ts`
- Modify: `ui/src/app/dashboard/pipelines/detail/page.tsx`
- Modify: `ui/src/components/dashboard/step-detail-panel.tsx`
- Test: `ui/src/app/dashboard/__tests__/pipeline-sse.test.tsx`

### Task 3a: Extend SSE event type

- [ ] **Step 1: Add timestamp fields to PipelineSSEEvent**

In `ui/src/lib/pipeline-sse.ts`:

```ts
export interface PipelineSSEEvent {
  type: string
  resourceType: string
  name: string
  namespace: string
  phase: string
  previousPhase?: string
  reason?: string
  message?: string
  timestamp: string
  startedAt?: number
  completedAt?: number
}
```

### Task 3b: Merge timestamps into pipeline state

- [ ] **Step 2: Update onPipelineEvent in detail page**

In `ui/src/app/dashboard/pipelines/detail/page.tsx`, change the SSE handler:

```ts
const onPipelineEvent = useCallback((event: PipelineSSEEvent) => {
  setPipeline((prev) => {
    if (!prev) return prev
    const plain = toPlainMessage(prev)
    plain.stepStatuses = (plain.stepStatuses ?? []).map((st) =>
      st.name === event.name
        ? {
            ...st,
            phase: event.phase,
            startedAt: event.startedAt !== undefined ? BigInt(event.startedAt) : st.startedAt,
            completedAt: event.completedAt !== undefined ? BigInt(event.completedAt) : st.completedAt,
          }
        : st
    )
    if (event.name === "" && event.phase) {
      plain.phase = event.phase
    }
    return new Pipeline(plain)
  })
}, [])
```

### Task 3c: Show elapsed time in step detail panel

- [ ] **Step 3: Render running duration**

In `ui/src/components/dashboard/step-detail-panel.tsx`, add a small hook or inline interval to show elapsed time when phase is Running:

```tsx
import { useEffect, useState } from "react"

function useElapsedMs(startedAt?: bigint) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!startedAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  if (!startedAt) return null
  const startMs = Number(startedAt) * 1000
  if (now < startMs) return null
  const elapsed = Math.floor((now - startMs) / 1000)
  return `${elapsed}s`
}
```

Use it in the panel:

```tsx
const elapsed = useElapsedMs(status?.startedAt)

// near the status badge
{phase === "Running" && elapsed && (
  <span className="text-xs text-muted-foreground">({elapsed})</span>
)}
```

### Task 3d: Frontend tests

- [ ] **Step 4: Add SSE timestamp parsing test**

In `ui/src/app/dashboard/__tests__/pipeline-sse.test.tsx`, add:

```ts
it("parses events with timestamps", () => {
  const onEvent = vi.fn()
  renderHook(() => usePipelineSSE("ns", "pipe", onEvent))

  mockEventSource.onmessage?.({
    data: JSON.stringify({
      type: "pipeline",
      name: "build",
      phase: "Running",
      startedAt: 1000,
      completedAt: 1010,
    }),
  })

  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "pipeline",
      name: "build",
      phase: "Running",
      startedAt: 1000,
      completedAt: 1010,
    })
  )
})
```

- [ ] **Step 5: Add step panel elapsed time test**

In `ui/src/app/dashboard/__tests__/step-detail-panel.test.tsx`, add a test that renders a Running step with `startedAt` and verifies the elapsed text appears:

```ts
it("shows elapsed time for running step", () => {
  vi.useFakeTimers()
  const status = new StepStatus({ name: "build", phase: "Running", startedAt: BigInt(Math.floor(Date.now() / 1000) - 5) })
  render(
    <StepDetailPanel
      step={baseStep}
      status={status}
      logs={null}
      logsLoading={false}
      onRetry={vi.fn()}
      onSkip={vi.fn()}
    />
  )
  expect(screen.getByText(/Running/)).toBeInTheDocument()
  vi.useRealTimers()
})
```

- [ ] **Step 6: Run frontend checks**

Run:
```bash
npm test
npx tsc --noEmit
npx eslint src/lib/pipeline-sse.ts src/app/dashboard/pipelines/detail/page.tsx src/components/dashboard/step-detail-panel.tsx src/app/dashboard/__tests__/pipeline-sse.test.tsx src/app/dashboard/__tests__/step-detail-panel.test.tsx
```

Expected: all PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/pipeline-sse.ts ui/src/app/dashboard/pipelines/detail/page.tsx ui/src/components/dashboard/step-detail-panel.tsx ui/src/app/dashboard/__tests__/
git commit -m "feat(ui): consume per-step SSE timestamps and show running elapsed time"
```

---

## Full Verification

- [ ] **Run all backend tests:** `go test ./internal/... -count=1`
- [ ] **Run all frontend tests:** `npm test`
- [ ] **Run linter:** `make lint`
- [ ] **Run TypeScript check:** `npx tsc --noEmit`
- [ ] **Verify `make manifests generate` succeeds** (no CRD/proto schema changes, but ensure generated code is current)

---

## Notes

- The protobuf `StepStatus` already has `started_at` and `completed_at` as optional `int64`. No proto regeneration is required.
- Avoid import cycles: the controller defines its own `StepProgressCallback` type; the engine defines `StepProgress` and converts.
- The engine callback is invoked synchronously while the workflow is running. The controller patches status and publishes SSE synchronously in that callback; if patching fails, log and continue so the workflow is not aborted.
- If the frontend receives an event without timestamps, it keeps the existing values (`?? st.startedAt`).

(End of file)
