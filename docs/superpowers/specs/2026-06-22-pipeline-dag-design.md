# Pipeline DAG Detail Page — Design Spec

## Overview

A dedicated pipeline detail page with an interactive DAG visualization of step
execution, per-step actions (retry, skip, cancel), and live log streaming via
SSE. Spans proto definitions, backend API handlers, SSE events, and the React
frontend.

## Proto Changes (`proto/paprika/v1/api.proto`)

### New RPCs

```protobuf
service PaprikaService {
  // Existing RPCs omitted.

  rpc GetPipeline(GetPipelineRequest) returns (GetPipelineResponse);
  rpc RetryStep(RetryStepRequest) returns (RetryStepResponse);
  rpc SkipStep(SkipStepRequest) returns (SkipStepResponse);
  rpc CancelPipeline(CancelPipelineRequest) returns (CancelPipelineResponse);
  rpc GetStepLogs(GetStepLogsRequest) returns (GetStepLogsResponse);
}
```

### New Messages

```protobuf
message GetPipelineRequest {
  string name = 1;
  string namespace = 2;
}
message GetPipelineResponse { Pipeline pipeline = 1; }

message RetryStepRequest {
  string pipeline_name = 1;
  string pipeline_namespace = 2;
  string step_name = 3;
}
message RetryStepResponse {}  // Empty — SSE will push the updated state.

message SkipStepRequest {
  string pipeline_name = 1;
  string pipeline_namespace = 2;
  string step_name = 3;
}
message SkipStepResponse {}

message CancelPipelineRequest {
  string name = 1;
  string namespace = 2;
}
message CancelPipelineResponse {}

message GetStepLogsRequest {
  string pipeline_name = 1;
  string pipeline_namespace = 2;
  string step_name = 3;
  int32 tail_lines = 4;  // Optional. 0 = all lines.
}
message GetStepLogsResponse { string logs = 1; }
```

### Rationale for separate RPCs per action

Separate RPCs produce typed connect-web stubs (`client.retryStep(...)`) that
are self-documenting and safe at compile time. A single `StepAction` enum
would require switch statements on every call site and allow invalid
action-step combinations (e.g., CANCEL on an already-finished step).

### Existing proto types referenced

The following types are already defined in `proto/paprika/v1/api.proto`:
- `Pipeline` — fields: `name`, `namespace`, `created_at`, `steps`
  (`repeated Step`), `max_parallel`, `phase` (string), `step_statuses`
  (`repeated StepStatus`), `artifacts` (`repeated ArtifactRef`).
- `Step` — fields: `name`, `image`, `script`, `depends` (`repeated string`).
- `StepStatus` — fields: `name`, `phase` (string), `started_at`, `completed_at`,
  `failed_reason`.
- `ArtifactRef` — fields: `name`, `url`, `digest`.
- Step phases (strings): `StepPending`, `StepRunning`, `StepSucceeded`,
  `StepFailed`, `StepSkipped`. A new phase `StepCancelled` will be added.
- Pipeline phases (strings): `""` (new), `Running`, `Succeeded`, `Failed`.
  A new phase `Cancelled` will be added.

## Backend: API Handlers (`internal/api/`)

All mutation handlers (RetryStep, SkipStep, CancelPipeline) **delegate to
WorkflowEngine methods** rather than duplicating state-machine logic. The
handler's job is: parse request → validate state machine → call engine →
publish SSE event → return response.

### GetPipeline

Read the `Pipeline` CRD from the informer cache (preferred) or live get.
Return the full object protobuf-serialized (steps, step statuses, phase,
timestamps).

### RetryStep

1. Re-fetch the Pipeline CRD.
2. **Idempotency guard**: if `StepStatus.phase` is not `StepFailed` or
   `StepSkipped`, return a clear error (e.g., `FailedPrecondition` with
   message "Step is in phase %s, cannot retry").
3. Delegate to `WorkflowEngine.RetryStep(ctx, pipeline, stepName)`.
4. Publish a `"pipeline"` SSE event with the updated step status.
5. Return empty response (the SSE event carries the update to all listeners).

### SkipStep

1. Re-fetch the Pipeline CRD.
2. **Idempotency guard**: if `StepStatus.phase` is not `StepPending`,
   return `FailedPrecondition` ("Step is in phase %s, cannot skip").
3. Delegate to `WorkflowEngine.SkipStep(ctx, pipeline, stepName)`.
4. Publish a `"pipeline"` SSE event.
5. Return empty response.

### CancelPipeline

1. Re-fetch the Pipeline CRD.
2. **Idempotency guard**: if `Pipeline.Status.Phase` is `Succeeded`,
   `Failed`, or `Cancelled`, return `FailedPrecondition` ("Pipeline
   already in terminal phase %s").
3. Delegate to `WorkflowEngine.CancelPipeline(ctx, pipeline)`.
4. Publish a `"pipeline"` SSE event.
5. Return empty response.

### GetStepLogs

1. List K8s Jobs with label `pipeline={pipeline-name}` and
   `step={step-name}` in the pipeline's namespace.
2. If no Jobs exist (step never ran), return `NotFound` with message
   "Step %s has not been executed."
3. If multiple Jobs exist (step was retried), pick the most recently
   created Job (last execution attempt).
4. Find the Pod owned by that Job. If the Pod has been garbage-collected,
   return `NotFound` with message "Logs for step %s are no longer
   available."
5. Read logs via the K8s PodLogs API (`corev1.PodLogOptions`).
   - If `tail_lines > 0`, use `TailLines = int64(tail_lines)`.
   - If `tail_lines > 0`, clamp it to `max_lines = 10000` to prevent OOM.
     `tail_lines = 0` means unlimited (all lines).
6. Return log text as a single string.

## Backend: SSE Events (`internal/api/events/`)

### New constants

```go
const TypePipeline = "pipeline"
```

### Per-pipeline topics

The `Broker.Subscribe()` method already accepts arbitrary topic strings.
The detail page subscribes to `pipeline/<namespace>/<name>`.

### Publishing

When a step phase changes (via controller reconciliation or RetryStep/SkipStep
handler):

```go
broker.Publish("pipeline/<ns>/<name>", EventPayload{
  Type:          TypePipeline,
  ResourceType:  "Step",
  Name:          stepName,
  Namespace:     pipelineNamespace,
  Phase:         newPhase,
  PreviousPhase: oldPhase,
  Timestamp:     time.Now(),
})
```

The controller already calls helper methods (`publishApplicationEvent()`,
`publishReleaseEvent()`, `publishRolloutEvent()`). A new helper
`publishPipelineEvent(ctx, broker, pipeline, stepStatus)` publishes to the
per-pipeline topic.

### Dashboard topic integration

The existing dashboard topic continues to publish `"pipeline"` events for the
dashboard's `refetchByEvent` to trigger a `listPipelines` re-fetch. The
detail page uses the per-pipeline topic for targeted step-level updates.

## Frontend: Route

```
/dashboard/pipelines/detail?namespace=<ns>&name=<name>
```

Add to Next.js router. No existing `pipelines/` directory — create:

```
src/app/dashboard/pipelines/
  detail/
    page.tsx    — pipeline detail page, SSE subscription, state
```

## Frontend: Page Structure

```
┌──────────────────────────────────────────────────────────────┐
│  ← Back to Dashboard    Pipeline: my-pipeline  ns/default    │
│  Status: ● Running  Duration: 2m34s            [Cancel]      │
├────────────────────────────────────┬─────────────────────────┤
│                                    │  Step: build-backend    │
│  [build-lint]──►[build-backend]──►│  ● Succeeded  12.3s     │
│                    │              │  logs...                 │
│                    ▼              │  logs...                 │
│              [unit-tests]         │                          │
│                    │              │  [Retry]  [Skip]         │
│                    ▼              │                          │
│              [integration]──►[deploy]  Artifacts:            │
│                                    │  • image:v1.2.3         │
│                                    │  • report.xml           │
└────────────────────────────────────┴─────────────────────────┘
```

### States

| State | Handling |
|---|---|
| Loading | Full-page skeleton: pulsing blocks for header, DAG canvas area, side panel placeholder |
| Empty / Not found | "Pipeline not found" with link back to dashboard |
| Error (fetch) | Error banner with retry button, same pattern as `SectionError` on dashboard |
| Error (action) | Toast notification for failed retry/skip/cancel |
| SSE disconnected | Banner: "Live updates paused — reconnecting..." (reuse `useConnection` pattern) |
| Step selected | Right panel open, shows step details |
| No step selected | Right panel shows "Select a step to view details" |
| Cancelling | Disable Cancel button, show spinner |

## Frontend: Components

### `pipeline-dag.tsx`

Wrapper around `@xyflow/react` (React Flow v12).

**Props:**
```typescript
interface PipelineDAGProps {
  steps: Step[]
  stepStatuses: StepStatus[]
  selectedStep: string | null
  onStepSelect: (stepName: string) => void
}
```

**Logic:**
1. Convert `steps` + `stepStatuses` to React Flow nodes and edges.
   - Each `Step` → one `ReactFlowNode` (type: `pipelineStep`).
   - Each `Step.depends` entry → one `ReactFlowEdge`.
2. Run `dagre` layout algorithm (rank direction: TB, align: UL).
3. Color nodes by step status phase:
   - `Pending` / empty → gray `#94a3b8`
   - `Running` → blue `#3b82f6` + pulsing border animation
   - `Succeeded` → green `#22c55e`
   - `Failed` → red `#ef4444`
   - `Skipped` → yellow `#eab308` (desaturated)
4. Handle node click → `onStepSelect(stepName)`.
5. Disable pan/zoom on the canvas (the DAG is a fixed layout).
6. When `stepStatuses` change (from SSE), update only the changed nodes
   via React Flow's `setNodes` API — no full re-layout.

### `pipeline-dag-node.tsx`

Custom React Flow node component.

**Render:**
```
┌─────────────────────┐
│  ○ build-backend    │  ○ = phase icon (CheckCircle/XCircle/Spinner/Circle)
│  Succeeded  12.3s   │
└─────────────────────┘
```

- Left border color = phase color
- Step name (mono font, truncate)
- Phase badge
- Duration (from started_at → completed_at, or "running..." for active)
- Selected state: highlighted border

### `step-detail-panel.tsx`

Right side panel.

**Props:**
```typescript
interface StepDetailPanelProps {
  step: Step | null
  status: StepStatus | null
  logs: string | null
  logsLoading: boolean
  onRetry: () => void
  onSkip: () => void
}
```

**Sections:**
1. **Header**: step name, phase badge, duration
2. **Actions** (conditionally shown):
   - Retry: shown when status.phase === "Failed" or "Skipped"
   - Skip: shown when status.phase === "Pending"
   - Retry and Skip are hidden for terminal states (Succeeded)
3. **Logs**: scrollable `<pre>` with monospace font, dark background.
   Shows loading spinner while fetching. Empty state: "No logs available."
4. **Artifacts**: list of `ArtifactRef` for this step (if any).

### `pipeline-detail-page.tsx` (`detail/page.tsx`)

Orchestrator component.

**State:**
```typescript
const [pipeline, setPipeline] = useState<Pipeline | null>(null)
const [selectedStep, setSelectedStep] = useState<string | null>(null)
const [logs, setLogs] = useState<string | null>(null)
const [logsLoading, setLogsLoading] = useState(false)
const [error, setError] = useState<string | null>(null)
```

**Data flow:**
1. Parse `namespace` and `name` from `useSearchParams()`.
2. `useEffect`: fetch pipeline via `client.getPipeline({name, namespace})`.
3. `useEffect`: open `EventSource("/events?topic=pipeline/<ns>/<name>")`.
   - On message: parse JSON, update matching step status in pipeline state.
   - On error: show reconnection banner.
4. On step select: call `client.getStepLogs({...})`, set logs state.
5. On retry: call `client.retryStep({...})`, show spinner on button, SSE will
   push the update.
6. On skip: call `client.skipStep({...})`, same pattern.
7. On cancel: call `client.cancelPipeline({...})`. Stay on the detail page so
   the user sees the SSE-pushed `Cancelled` phase transition (nodes gray out,
   status badge updates). Show a toast with "View in dashboard" link.

**Error handling:**
- Fetch failure: set error state, show `SectionError` with retry.
- Action failure: catch in `.catch()`, show toast via `ToastStack`.
- SSE parse failure: log warning, ignore malformed event (same pattern as
  dashboard).

## Frontend: SSE Pipeline Hook

Extracted into `src/lib/pipeline-sse.ts` for testability:

```typescript
function usePipelineSSE(namespace: string, name: string, onEvent: (event: PipelineSSEEvent) => void) {
  // Subscribe to /events?topic=pipeline/<ns>/<name>
  // Parse JSON, handle errors, cleanup on unmount
  // Return { connected: boolean }
}
```

This mirrors the dashboard's SSE pattern but is isolated for the detail page.

## Frontend: React Flow Dependency

Install `@xyflow/react` (v12, the current major).

The DAG uses a small subset of React Flow features:
- Static graph (no drag-to-reorder)
- Custom node types
- Smoothstep or Bezier edges
- dagre auto-layout
- Fit-view on initial render

No minimap, no controls panel, no selection box. Keep it minimal.

## Pipeline Controller Changes (`internal/controller/pipelines/`)

### WorkflowEngine interface

Add three new methods:
```go
type WorkflowEngine interface {
  RunPipeline(ctx context.Context, pipeline *v1.Pipeline) error
  RetryStep(ctx context.Context, pipeline *v1.Pipeline, stepName string) error
  SkipStep(ctx context.Context, pipeline *v1.Pipeline, stepName string) error
  CancelPipeline(ctx context.Context, pipeline *v1.Pipeline) error
}
```

### RetryStep implementation

1. Find the `StepStatus` matching `stepName`.
2. Set `Phase: StepPending`, clear `FinishedAt`, clear `FailedReason`.
3. Patch the Pipeline status. The informer watch on Pipeline CRDs will
   trigger a new reconcile for this Pipeline automatically — no explicit
   `RequeueAfter` is needed.
4. On the next reconcile, `RunPipeline` sees a pending step whose
   dependencies are satisfied and (re-)creates the K8s Job for it.

### SkipStep implementation

1. Find the `StepStatus` matching `stepName`.
2. Set `Phase: StepSkipped`, set `FinishedAt: now`.
3. Patch the Pipeline status (informer watch triggers reconcile).
4. On reconcile, the WorkflowEngine checks if all steps are terminal
   (Succeeded or Skipped). If so, set Pipeline phase to Succeeded.
   If any step is Failed and no pending steps remain, set to Failed.

### CancelPipeline implementation

1. Set `Pipeline.Status.Phase: "Cancelled"`. The informer watch triggers
   reconcile.
2. On reconcile (`RunPipeline`), check for `Cancelled` phase at the
   top — skip all step processing and mark any running step statuses as
   `StepCancelled`.
3. List all K8s Jobs owned by this Pipeline. Delete them.
4. Patch the Pipeline status (informers notify again, but the Cancelled
   phase guard prevents re-processing).

### SSE publishing from controller

After each step status change in the reconcile loop, call
`publishPipelineEvent(ctx, broker, pipeline, stepStatus)`.

## Implementation Order

1. **Proto**: Add new RPCs and messages. Run `make generate-proto`.
2. **WorkflowEngine**: Add RetryStep, SkipStep, CancelPipeline methods.
3. **Controller**: Wire SSE publishing into reconcile loop.
4. **API handlers**: GetPipeline, RetryStep, SkipStep, CancelPipeline, GetStepLogs.
5. **SSE**: Add TypePipeline constant, per-pipeline topics, dashboard topic
   integration.
6. **Frontend deps**: Install `@xyflow/react`.
7. **Frontend components**: pipeline-dag, pipeline-dag-node, step-detail-panel,
   pipeline-sse hook.
8. **Frontend page**: detail/page.tsx with full state management.
9. **Tests**: Unit + component tests for each layer.

## Testing

### Backend unit tests
- API handlers: mock CRD client, verify patches and responses.
- WorkflowEngine: mock K8s client, verify step status transitions.
- SSE: verify event payload structure and topic names.

### Frontend tests (vitest)
- `pipeline-dag`: verify steps → nodes/edges conversion for linear,
  parallel, and mixed DAG topologies.
- `pipeline-sse`: verify event parsing, type routing, cleanup.
- Step detail panel: render with mock data, verify action button visibility
  per phase.
- Full page: mock RPC + SSE, verify loading/error/data states.

### E2E (future)
New Ginkgo test: create a Pipeline, navigate to detail page, verify DAG
renders, retry a failed step, verify phase transition.

## Open Questions

1. Pipeline status phase enum: add `"Cancelled"` to the existing phases
   (or use `"Failed"` with a specific reason)? **Decision: add `Cancelled`
   as a distinct phase.**
2. Step retry count field: add `retryCount` to `StepStatus` proto?
   **Decision: yes, for observability.**
3. K8s Job naming for step logs: confirm convention `{pipeline}-{step}`?
   **Decision: verified in controller code — Jobs are named
   `{pipeline.Name}-{step.Name}`.**
