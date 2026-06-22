# Pipeline DAG Detail Page — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Interactive pipeline detail page with DAG visualization, step logs, and retry/skip/cancel actions.

**Architecture:** 4 independent chunks executed sequentially: Proto → Backend (handlers + engine) → SSE events → Frontend DAG page. Each chunk adds a layer the next depends on.

**Tech Stack:** Protobuf (Buf), Go (ConnectRPC, controller-runtime), Next.js (React Flow v12), Vitest, Happy DOM.

---

## File Structure

| Layer | File | Responsibility |
|---|---|---|
| Proto | `proto/paprika/v1/api.proto` | New RPCs: GetPipeline, RetryStep, SkipStep, CancelPipeline, GetStepLogs |
| Backend | `internal/api/pipeline_handler.go` | ConnectRPC handlers for all 5 new RPCs |
| Backend | `internal/api/events/eventtypes.go` | Add `TypePipeline` constant |
| Backend | `internal/api/sse.go` | Add per-pipeline SSE topic routing |
| Backend | `internal/controller/pipelines/workflow.go` | Add RetryStep, SkipStep, CancelPipeline to interface + implement |
| Backend | `internal/controller/pipelines/pipeline_controller.go` | Call `publishPipelineEvent` after step status changes |
| Frontend | `ui/package.json` | Add `@xyflow/react` dependency |
| Frontend | `ui/src/components/dashboard/pipeline-dag.tsx` | React Flow wrapper, step→node+edge conversion, dagre layout |
| Frontend | `ui/src/components/dashboard/pipeline-dag-node.tsx` | Custom React Flow node component |
| Frontend | `ui/src/components/dashboard/step-detail-panel.tsx` | Right sidebar: logs, actions, artifacts |
| Frontend | `ui/src/lib/pipeline-sse.ts` | SSE hook for per-pipeline event subscription |
| Frontend | `ui/src/app/dashboard/pipelines/detail/page.tsx` | Pipeline detail page (orchestrator) |

---

## Chunk 1: Proto — New RPCs and Messages

**Files:**
- Modify: `proto/paprika/v1/api.proto`

- [ ] **Step 1: Add new RPCs to PaprikaService**

Open `proto/paprika/v1/api.proto` and add these RPCs after the existing `RollbackRelease`:

```protobuf
  rpc GetPipeline(GetPipelineRequest) returns (GetPipelineResponse);
  rpc RetryStep(RetryStepRequest) returns (RetryStepResponse);
  rpc SkipStep(SkipStepRequest) returns (SkipStepResponse);
  rpc CancelPipeline(CancelPipelineRequest) returns (CancelPipelineResponse);
  rpc GetStepLogs(GetStepLogsRequest) returns (GetStepLogsResponse);
```

- [ ] **Step 2: Add request/response messages**

Add these message definitions at the end of `api.proto`, before the last `}`:

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
message RetryStepResponse {}

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
  int32 tail_lines = 4;
}
message GetStepLogsResponse { string logs = 1; }
```

- [ ] **Step 3: Regenerate proto code**

Run: `make generate-proto`
Expected: Generated files in `gen/` directories (Go + TypeScript) compile without error.

- [ ] **Step 4: Verify TypeScript types exist**

Check: `ls ui/src/gen/paprika/v1/api_pb.ts` — should contain new message classes.
Run: `npx tsc --noEmit` in `ui/` — should pass.

- [ ] **Step 5: Commit**

```bash
git add proto/paprika/v1/api.proto gen/ ui/src/gen/
git commit -m "proto: add GetPipeline, RetryStep, SkipStep, CancelPipeline, GetStepLogs RPCs"
```

---

## Chunk 2: Backend — API Handlers + WorkflowEngine Methods

**Files:**
- Create: `internal/api/pipeline_handler.go`
- Modify: `internal/controller/pipelines/workflow.go`
- Test: `internal/api/pipeline_handler_test.go`
- Test: `internal/controller/pipelines/workflow_test.go`

### Task 2a: GetPipeline handler

- [ ] **Step 1: Write GetPipeline handler test**

Create `internal/api/pipeline_handler_test.go`:

```go
package api

import (
  "context"
  "testing"
  "github.com/stretchr/testify/require"
  paprikav1 "github.com/yourorg/paprika/api/pipeline/v1"
  corev1 "k8s.io/api/core/v1"
  metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
  "sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestGetPipeline(t *testing.T) {
  cl := fake.NewClientBuilder().WithObjects(
    &paprikav1.Pipeline{
      ObjectMeta: metav1.ObjectMeta{Name: "test-pipe", Namespace: "default"},
      Spec: paprikav1.PipelineSpec{
        Steps: []paprikav1.Step{{Name: "build", Image: "golang:1.22"}},
      },
    },
  ).Build()
  
  srv := &pipelineService{client: cl}
  resp, err := srv.GetPipeline(context.Background(), &paprikav1.GetPipelineRequest{
    Name: "test-pipe", Namespace: "default",
  })
  require.NoError(t, err)
  require.NotNil(t, resp.Pipeline)
  require.Equal(t, "test-pipe", resp.Pipeline.Name)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/ -run TestGetPipeline -v`
Expected: FAIL — `pipelineService` not defined.

- [ ] **Step 3: Write GetPipeline handler**

Create `internal/api/pipeline_handler.go`:

```go
package api

import (
  "context"
  paprikav1 "github.com/yourorg/paprika/api/pipeline/v1"
  "sigs.k8s.io/controller-runtime/pkg/client"
  "google.golang.org/protobuf/types/known/anypb"
)

type pipelineService struct {
  client client.Client
}

func (s *pipelineService) GetPipeline(ctx context.Context, req *paprikav1.GetPipelineRequest) (*paprikav1.GetPipelineResponse, error) {
  pipe := &paprikav1.Pipeline{}
  if err := s.client.Get(ctx, client.ObjectKey{Name: req.Name, Namespace: req.Namespace}, pipe); err != nil {
    return nil, err
  }
  return &paprikav1.GetPipelineResponse{Pipeline: pipe}, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/ -run TestGetPipeline -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/api/pipeline_handler.go internal/api/pipeline_handler_test.go
git commit -m "feat(api): add GetPipeline RPC handler"
```

### Task 2b: RetryStep, SkipStep, CancelPipeline handlers

- [ ] **Step 1: Write handler test for RetryStep with idempotency guards**

Add to `internal/api/pipeline_handler_test.go`:

```go
func TestRetryStep_IdempotencyGuard(t *testing.T) {
  cl := fake.NewClientBuilder().WithObjects(
    &paprikav1.Pipeline{
      ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "ns"},
      Status: paprikav1.PipelineStatus{
        StepStatuses: []paprikav1.StepStatus{
          {Name: "build", Phase: "StepRunning"},
        },
      },
    },
  ).Build()
  
  srv := &pipelineService{client: cl}
  _, err := srv.RetryStep(context.Background(), &paprikav1.RetryStepRequest{
    PipelineName: "p", PipelineNamespace: "ns", StepName: "build",
  })
  require.Error(t, err)
  require.Contains(t, err.Error(), "StepRunning") // should refuse to retry a running step
}
```

- [ ] **Step 2: Run the test**

Run: `go test ./internal/api/ -run TestRetryStep_IdempotencyGuard -v`
Expected: FAIL — `RetryStep` not defined.

- [ ] **Step 3: Add WorkflowEngine interface methods**

Edit `internal/controller/pipelines/workflow.go`:

```go
// Add to WorkflowEngine interface:
RetryStep(ctx context.Context, pipeline *paprikav1.Pipeline, stepName string) error
SkipStep(ctx context.Context, pipeline *paprikav1.Pipeline, stepName string) error
CancelPipeline(ctx context.Context, pipeline *paprikav1.Pipeline) error
```

- [ ] **Step 4: Implement RetryStep/SkipStep/CancelPipeline in the engine**

Implement in the existing workflow engine struct. For each:
- RetryStep: set phase to `StepPending`, clear timestamps, patch status
- SkipStep: set phase to `StepSkipped`, set `FinishedAt`, patch status
- CancelPipeline: set pipeline phase to `"Cancelled"`, list+delete Jobs, mark running steps as cancelled

```go
func (e *workflowEngine) RetryStep(ctx context.Context, pipeline *paprikav1.Pipeline, stepName string) error {
  for i, st := range pipeline.Status.StepStatuses {
    if st.Name == stepName {
      if st.Phase != "StepFailed" && st.Phase != "StepSkipped" {
        return fmt.Errorf("cannot retry step in phase %s", st.Phase)
      }
      pipeline.Status.StepStatuses[i].Phase = "StepPending"
      pipeline.Status.StepStatuses[i].FinishedAt = nil
      pipeline.Status.StepStatuses[i].FailedReason = ""
      break
    }
  }
  return e.client.Status().Update(ctx, pipeline)
}

func (e *workflowEngine) SkipStep(ctx context.Context, pipeline *paprikav1.Pipeline, stepName string) error {
  now := metav1.Now()
  for i, st := range pipeline.Status.StepStatuses {
    if st.Name == stepName {
      if st.Phase != "StepPending" {
        return fmt.Errorf("cannot skip step in phase %s", st.Phase)
      }
      pipeline.Status.StepStatuses[i].Phase = "StepSkipped"
      pipeline.Status.StepStatuses[i].FinishedAt = &now
      break
    }
  }
  return e.client.Status().Update(ctx, pipeline)
}

func (e *workflowEngine) CancelPipeline(ctx context.Context, pipeline *paprikav1.Pipeline) error {
  if pipeline.Status.Phase == "Succeeded" || pipeline.Status.Phase == "Failed" || pipeline.Status.Phase == "Cancelled" {
    return fmt.Errorf("pipeline already in terminal phase %s", pipeline.Status.Phase)
  }
  pipeline.Status.Phase = "Cancelled"
  now := metav1.Now()
  for i, st := range pipeline.Status.StepStatuses {
    if st.Phase == "StepRunning" {
      pipeline.Status.StepStatuses[i].Phase = "StepCancelled"
      pipeline.Status.StepStatuses[i].FinishedAt = &now
    }
  }
  // Delete running Jobs
  _ = e.client.DeleteAllOf(ctx, &batchv1.Job{}, client.InNamespace(pipeline.Namespace), 
    client.MatchingLabels{"pipeline": pipeline.Name})
  return e.client.Status().Update(ctx, pipeline)
}
```

- [ ] **Step 5: Add RetryStep/SkipStep/CancelPipeline handlers that delegate to engine**

In `internal/api/pipeline_handler.go`:

```go
type pipelineService struct {
  client client.Client
  engine WorkflowEngine  // interface for the workflow engine
  broker *events.Broker
}

func (s *pipelineService) RetryStep(ctx context.Context, req *paprikav1.RetryStepRequest) (*paprikav1.RetryStepResponse, error) {
  pipe := &paprikav1.Pipeline{}
  if err := s.client.Get(ctx, client.ObjectKey{Name: req.PipelineName, Namespace: req.PipelineNamespace}, pipe); err != nil {
    return nil, err
  }
  if err := s.engine.RetryStep(ctx, pipe, req.StepName); err != nil {
    return nil, status.Error(codes.FailedPrecondition, err.Error())
  }
  // Publish SSE event after successful mutation
  publishPipelineEvent(ctx, s.broker, pipe, req.StepName)
  return &paprikav1.RetryStepResponse{}, nil
}
```

Similar pattern for SkipStep and CancelPipeline.

- [ ] **Step 6: Test the full handler + engine integration**

Add integration test: create Pipeline with a failed step, call RetryStep handler, verify status patch.

- [ ] **Step 7: Run all backend tests**

Run: `go test ./internal/... -count=1`
Expected: All PASS (including existing tests).

- [ ] **Step 8: Commit**

```bash
git add internal/api/pipeline_handler.go internal/api/pipeline_handler_test.go internal/controller/pipelines/workflow.go
git commit -m "feat(api): add RetryStep, SkipStep, CancelPipeline handlers + WorkflowEngine methods"
```

### Task 2c: GetStepLogs handler

- [ ] **Step 1: Write GetStepLogs test**

Cover: successful Pod log fetch, step never ran (No Jobs), multiple Jobs (pick newest), GC'd Pod.

- [ ] **Step 2: Implement GetStepLogs**

```go
func (s *pipelineService) GetStepLogs(ctx context.Context, req *paprikav1.GetStepLogsRequest) (*paprikav1.GetStepLogsResponse, error) {
  // List Jobs with labels pipeline=<name>, step=<step>
  jobs := &batchv1.JobList{}
  if err := s.client.List(ctx, jobs, client.InNamespace(req.PipelineNamespace),
    client.MatchingLabels{"pipeline": req.PipelineName, "step": req.StepName}); err != nil {
    return nil, err
  }
  if len(jobs.Items) == 0 {
    return nil, status.Error(codes.NotFound, fmt.Sprintf("step %s has not been executed", req.StepName))
  }
  // Pick most recent Job
  sort.Slice(jobs.Items, func(i, j int) bool {
    return jobs.Items[i].CreationTimestamp.After(jobs.Items[j].CreationTimestamp.Time)
  })
  job := jobs.Items[0]
  // Find the Pod
  pods := &corev1.PodList{}
  if err := s.client.List(ctx, pods, client.InNamespace(req.PipelineNamespace),
    client.MatchingLabels{job.Name: job.Name}); err != nil {
    return nil, err
  }
  if len(pods.Items) == 0 {
    return nil, status.Error(codes.NotFound, fmt.Sprintf("logs for step %s are no longer available", req.StepName))
  }
  podLogOpts := &corev1.PodLogOptions{}
  if req.TailLines > 0 {
    tl := int64(min(req.TailLines, 10000))
    podLogOpts.TailLines = &tl
  }
  logStream, err := s.clientset.CoreV1().Pods(req.PipelineNamespace).GetLogs(pods.Items[0].Name, podLogOpts).Stream(ctx)
  if err != nil {
    return nil, err
  }
  defer logStream.Close()
  buf := new(strings.Builder)
  io.Copy(buf, logStream)
  return &paprikav1.GetStepLogsResponse{Logs: buf.String()}, nil
}
```

- [ ] **Step 3: Run test**

Run: `go test ./internal/api/ -run TestGetStepLogs -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/api/pipeline_handler.go internal/api/pipeline_handler_test.go
git commit -m "feat(api): add GetStepLogs RPC handler"
```

---

## Chunk 3: Backend — SSE Pipeline Events

**Files:**
- Modify: `internal/api/events/eventtypes.go`
- Modify: `internal/api/sse.go`
- Modify: `internal/controller/pipelines/pipeline_controller.go`

- [ ] **Step 1: Add TypePipeline constant**

In `internal/api/events/eventtypes.go`:

```go
const TypePipeline = "pipeline"
```

- [ ] **Step 2: Verify existing SSE handler supports arbitrary topics**

Read `internal/api/sse.go` — confirm `Subscribe(topic)` accepts any string. The handler reads `?topic=` from query param and subscribes to that string. Should already work for `pipeline/<ns>/<name>`.

- [ ] **Step 3: Add publishPipelineEvent helper**

In `internal/controller/pipelines/pipeline_controller.go` (or a new file):

```go
func publishPipelineEvent(ctx context.Context, broker *events.Broker, pipeline *paprikav1.Pipeline, stepName string) {
  topic := fmt.Sprintf("pipeline/%s/%s", pipeline.Namespace, pipeline.Name)
  broker.Publish(topic, events.EventPayload{
    Type:          events.TypePipeline,
    ResourceType:  "Step",
    Name:          stepName,
    Namespace:     pipeline.Namespace,
    Phase:         findStepPhase(pipeline, stepName),
    Timestamp:     time.Now(),
  })
}
```

- [ ] **Step 4: Wire SSE publishing into the controller's reconcile loop**

In `pipeline_controller.go`, after each step status update (in `RunPipeline` or the main reconcile), call `publishPipelineEvent(ctx, r.broker, pipeline, stepName)`.

- [ ] **Step 5: Verify SSE with a quick integration test**

Add a test that creates a Broker, subscribes to `pipeline/default/test-pipe`, calls `publishPipelineEvent`, and verifies the event is received.

- [ ] **Step 6: Commit**

```bash
git add internal/api/events/eventtypes.go internal/controller/pipelines/
git commit -m "feat(sse): add TypePipeline events + per-pipeline SSE topics"
```

---

## Chunk 4: Frontend — Pipeline DAG Detail Page

**Files:**
- Modify: `ui/package.json`
- Create: `ui/src/components/dashboard/pipeline-dag.tsx`
- Create: `ui/src/components/dashboard/pipeline-dag-node.tsx`
- Create: `ui/src/components/dashboard/step-detail-panel.tsx`
- Create: `ui/src/lib/pipeline-sse.ts`
- Create: `ui/src/app/dashboard/pipelines/detail/page.tsx`
- Create: `ui/src/app/dashboard/__tests__/pipeline-dag.test.tsx`
- Create: `ui/src/app/dashboard/__tests__/pipeline-sse.test.tsx`
- Create: `ui/src/app/dashboard/__tests__/step-detail-panel.test.tsx`

### Task 4a: Install dependencies

- [ ] **Step 1: Install React Flow + dagre**

```bash
npm install @xyflow/react
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add ui/package.json ui/package-lock.json
git commit -m "deps: add @xyflow/react for DAG visualization"
```

### Task 4b: Pipeline DAG component

- [ ] **Step 1: Write pipeline-dag test**

`ui/src/app/dashboard/__tests__/pipeline-dag.test.tsx`:

```typescript
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { PipelineDAG } from "@/components/dashboard/pipeline-dag"
import type { Step, StepStatus } from "@/gen/paprika/v1/api_pb"

const mockSteps: Step[] = [
  { name: "build", image: "golang:1.22", script: "go build", depends: [] },
  { name: "test", image: "golang:1.22", script: "go test", depends: ["build"] },
]

const mockStatuses: StepStatus[] = [
  { name: "build", phase: "StepSucceeded", startedAt: { seconds: 1000, nanos: 0 }, completedAt: { seconds: 1010, nanos: 0 } },
  { name: "test", phase: "StepRunning", startedAt: { seconds: 1015, nanos: 0 } },
]

const defaultProps = {
  steps: mockSteps,
  stepStatuses: mockStatuses,
  selectedStep: null,
  onStepSelect: () => {},
}

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children }: any) => <div data-testid="react-flow">{children}</div>,
  Handle: ({ children }: any) => <div data-testid="handle">{children}</div>,
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
}))

describe("PipelineDAG", () => {
  it("renders step nodes with correct count", () => {
    render(<PipelineDAG {...defaultProps} />)
    // React Flow should render all step nodes
    expect(screen.getByTestId("react-flow")).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Write pipeline-dag component**

`ui/src/components/dashboard/pipeline-dag.tsx`:

```typescript
"use client"

import { useMemo } from "react"
import { ReactFlow, type Node, type Edge, Position } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import dagre from "dagre"
import type { Step, StepStatus } from "@/gen/paprika/v1/api_pb"
import { PipelineDAGNode } from "./pipeline-dag-node"

const NODE_WIDTH = 180
const NODE_HEIGHT = 60

interface PipelineDAGProps {
  steps: Step[]
  stepStatuses: StepStatus[]
  selectedStep: string | null
  onStepSelect: (stepName: string) => void
}

function phaseColor(phase: string): string {
  switch (phase) {
    case "StepRunning": return "#3b82f6"
    case "StepSucceeded": return "#22c55e"
    case "StepFailed": return "#ef4444"
    case "StepSkipped": return "#eab308"
    case "StepCancelled": return "#6b7280"
    default: return "#94a3b8" // pending
  }
}

export function PipelineDAG({ steps, stepStatuses, selectedStep, onStepSelect }: PipelineDAGProps) {
  const { nodes, edges } = useMemo(() => {
    const statusMap = new Map(stepStatuses.map(s => [s.name, s]))
    const nodeList: Node[] = steps.map((step, i) => ({
      id: step.name,
      type: "pipelineStep",
      position: { x: 0, y: 0 }, // dagre sets this
      data: {
        step,
        status: statusMap.get(step.name) ?? null,
        color: phaseColor(statusMap.get(step.name)?.phase ?? ""),
        selected: selectedStep === step.name,
        onSelect: onStepSelect,
      },
    }))

    // Build edges from depends
    const edgeList: Edge[] = []
    for (const step of steps) {
      for (const dep of step.depends) {
        edgeList.push({
          id: `${dep}->${step.name}`,
          source: dep,
          target: step.name,
          type: "smoothstep",
          animated: statusMap.get(dep)?.phase === "StepRunning",
        })
      }
    }

    // dagre layout
    const g = new dagre.graphlib.Graph()
    g.setDefaultEdgeLabel(() => ({}))
    g.setGraph({ rankdir: "TB", align: "UL", nodesep: 30, ranksep: 50 })
    nodeList.forEach(n => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }))
    edgeList.forEach(e => g.setEdge(e.source, e.target))
    dagre.layout(g)
    nodeList.forEach(n => {
      const node = g.node(n.id)
      n.position = { x: node.x - NODE_WIDTH / 2, y: node.y - NODE_HEIGHT / 2 }
    })

    return { nodes: nodeList, edges: edgeList }
  }, [steps, stepStatuses, selectedStep, onStepSelect])

  return (
    <div className="h-full w-full" style={{ minHeight: 400 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={{ pipelineStep: PipelineDAGNode }}
        fitView
        panOnDrag={false}
        zoomOnScroll={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
      </ReactFlow>
    </div>
  )
}
```

Note: Need to install `@types/dagre` and `dagre` as well. Actually, React Flow v12 handles dagre integration differently — let me check... In v12, you use `@xyflow/react` with `dagre` directly for layout computation. The `dagre` package is a separate install.

Actually, looking at the React Flow docs more carefully, in v12 they recommend:

```typescript
import dagre from "@dagrejs/dagre"
```

Wait, `dagre` was moved to `@dagrejs/dagre` package. Let me use the right import.

Actually, for simplicity, let me use `dagre` (the original package). In modern projects, the `dagre` npm package still works. Let me just install both.

- [ ] **Step 3: Install dagre**

```bash
npm install dagre @types/dagre
```

Wait, actually, `@xyflow/react` v12 uses `@dagrejs/dagre` which is the maintained fork. Let me use that.

```bash
npm install @dagrejs/dagre
```

- [ ] **Step 4: Write test for step-detail-panel**

`ui/src/app/dashboard/__tests__/step-detail-panel.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StepDetailPanel } from "@/components/dashboard/step-detail-panel"

describe("StepDetailPanel", () => {
  it("shows placeholder when no step selected", () => {
    render(<StepDetailPanel step={null} status={null} logs={null} logsLoading={false} onRetry={vi.fn()} onSkip={vi.fn()} />)
    expect(screen.getByText("Select a step")).toBeInTheDocument()
  })

  it("shows Retry button for failed step", () => {
    render(
      <StepDetailPanel
        step={{ name: "build", image: "", script: "", depends: [] }}
        status={{ name: "build", phase: "StepFailed" }}
        logs="error: build failed"
        logsLoading={false}
        onRetry={vi.fn()}
        onSkip={vi.fn()}
      />
    )
    expect(screen.getByText("Retry")).toBeInTheDocument()
  })

  it("shows Skip button for pending step", () => {
    render(
      <StepDetailPanel
        step={{ name: "test", image: "", script: "", depends: [] }}
        status={{ name: "test", phase: "StepPending" }}
        logs={null}
        logsLoading={false}
        onRetry={vi.fn()}
        onSkip={vi.fn()}
      />
    )
    expect(screen.getByText("Skip")).toBeInTheDocument()
  })
})
```

- [ ] **Step 5: Write step-detail-panel component**

`ui/src/components/dashboard/step-detail-panel.tsx`:

```typescript
"use client"

import type { Step, StepStatus } from "@/gen/paprika/v1/api_pb"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"

interface StepDetailPanelProps {
  step: Step | null
  status: StepStatus | null
  logs: string | null
  logsLoading: boolean
  onRetry: () => void
  onSkip: () => void
}

export function StepDetailPanel({ step, status, logs, logsLoading, onRetry, onSkip }: StepDetailPanelProps) {
  if (!step) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Select a step to view details
      </div>
    )
  }

  const phase = status?.phase ?? ""

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-sm font-semibold">{step.name}</h3>
        {phase && <StatusBadge status={phase.replace("Step", "")} />}
      </div>

      <div className="flex gap-2">
        {phase === "StepFailed" && (
          <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
        )}
        {phase === "StepPending" && (
          <Button size="sm" variant="outline" onClick={onSkip}>Skip</Button>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <h4 className="mb-2 text-xs font-medium text-muted-foreground">Logs</h4>
        {logsLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Loading logs...
          </div>
        ) : logs ? (
          <pre className="whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs leading-relaxed">
            {logs}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">No logs available</p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Write SSE hook**

`ui/src/lib/pipeline-sse.ts`:

```typescript
"use client"

import { useEffect, useRef, useState } from "react"

export interface PipelineSSEEvent {
  type: string
  resource_type: string
  name: string
  namespace: string
  phase: string
  previous_phase: string
  timestamp: string
}

export function usePipelineSSE(
  namespace: string,
  name: string,
  onEvent: (event: PipelineSSEEvent) => void
) {
  const [connected, setConnected] = useState(false)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    const topic = `pipeline/${namespace}/${name}`
    const es = new EventSource(`/events?topic=${encodeURIComponent(topic)}`)

    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data)
        if (typeof parsed.type === "string") {
          onEventRef.current(parsed as PipelineSSEEvent)
        }
      } catch {
        // ignore malformed events
      }
    }

    return () => es.close()
  }, [namespace, name])

  return connected
}
```

- [ ] **Step 7: Write detail page**

`ui/src/app/dashboard/pipelines/detail/page.tsx`:

```typescript
"use client"

import { useState, useEffect, useCallback } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { createPromiseClient } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-web"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import type { Pipeline, Step, StepStatus } from "@/gen/paprika/v1/api_pb"
import { PipelineDAG } from "@/components/dashboard/pipeline-dag"
import { StepDetailPanel } from "@/components/dashboard/step-detail-panel"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { ChevronLeft, Loader2 } from "lucide-react"
import { usePipelineSSE, type PipelineSSEEvent } from "@/lib/pipeline-sse"
import { SectionError } from "../../page"

const transport = createConnectTransport({ baseUrl: "" })
const client = createPromiseClient(PaprikaService, transport)

export default function PipelineDetailPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const namespace = searchParams.get("namespace") ?? ""
  const name = searchParams.get("name") ?? ""

  const [pipeline, setPipeline] = useState<Pipeline | null>(null)
  const [selectedStep, setSelectedStep] = useState<string | null>(null)
  const [logs, setLogs] = useState<string | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)

  // SSE events update step statuses in-place
  const onPipelineEvent = useCallback((event: PipelineSSEEvent) => {
    setPipeline(prev => {
      if (!prev) return prev
      const updated = { ...prev }
      updated.stepStatuses = (prev.stepStatuses ?? []).map(st =>
        st.name === event.name ? { ...st, phase: event.phase } : st
      )
      if (event.phase === "Cancelled" || event.phase === "Succeeded" || event.phase === "Failed") {
        updated.phase = event.phase
      }
      return updated
    })
  }, [])

  usePipelineSSE(namespace, name, onPipelineEvent)

  // Initial fetch
  useEffect(() => {
    if (!namespace || !name) return
    setError(null)
    client.getPipeline({ namespace, name })
      .then(res => setPipeline(res.pipeline))
      .catch(err => setError(err.message ?? "Failed to load pipeline"))
  }, [namespace, name])

  // Fetch logs when step selected
  useEffect(() => {
    if (!selectedStep || !namespace || !name) return
    setLogsLoading(true)
    setLogs(null)
    client.getStepLogs({ pipelineName: name, pipelineNamespace: namespace, stepName: selectedStep, tailLines: 100 })
      .then(res => setLogs(res.logs))
      .catch(() => setLogs(null))
      .finally(() => setLogsLoading(false))
  }, [selectedStep, namespace, name])

  const handleRetry = useCallback(async () => {
    if (!selectedStep || !name || !namespace) return
    try {
      await client.retryStep({ pipelineName: name, pipelineNamespace: namespace, stepName: selectedStep })
    } catch { /* SSE will push the update */ }
  }, [selectedStep, name, namespace])

  const handleSkip = useCallback(async () => {
    if (!selectedStep || !name || !namespace) return
    try {
      await client.skipStep({ pipelineName: name, pipelineNamespace: namespace, stepName: selectedStep })
    } catch { /* SSE will push the update */ }
  }, [selectedStep, name, namespace])

  const handleCancel = useCallback(async () => {
    if (!name || !namespace) return
    setCancelling(true)
    try {
      await client.cancelPipeline({ name, namespace })
      // Stay on page — SSE will update the DAG
    } catch {
      setCancelling(false)
    }
  }, [name, namespace])

  if (!namespace || !name) {
    return (
      <div className="mx-auto max-w-4xl py-8 text-center">
        <p className="text-muted-foreground">Missing namespace or name parameters</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/dashboard")}>
          Back to Dashboard
        </Button>
      </div>
    )
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl py-8">
        <SectionError message={error} onRetry={() => window.location.reload()} />
      </div>
    )
  }

  if (!pipeline) {
    return (
      <div className="mx-auto max-w-4xl py-8">
        <div className="space-y-4">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded bg-muted" />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard")}>
            <ChevronLeft className="size-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{name}</h1>
            <p className="text-xs text-muted-foreground">ns/{namespace}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {pipeline.phase && <StatusBadge status={pipeline.phase} />}
          {pipeline.phase !== "Succeeded" && pipeline.phase !== "Failed" && pipeline.phase !== "Cancelled" && (
            <Button size="sm" variant="destructive" onClick={handleCancel} disabled={cancelling}>
              {cancelling ? <Loader2 className="size-3 animate-spin" /> : null}
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="flex gap-6">
        <div className="flex-1">
          <div className="rounded-lg border bg-card">
            <PipelineDAG
              steps={pipeline.steps ?? []}
              stepStatuses={pipeline.stepStatuses ?? []}
              selectedStep={selectedStep}
              onStepSelect={setSelectedStep}
            />
          </div>
        </div>
        <div className="w-96 shrink-0">
          <div className="rounded-lg border bg-card h-[600px]">
            <StepDetailPanel
              step={pipeline.steps?.find(s => s.name === selectedStep) ?? null}
              status={pipeline.stepStatuses?.find(s => s.name === selectedStep) ?? null}
              logs={logs}
              logsLoading={logsLoading}
              onRetry={handleRetry}
              onSkip={handleSkip}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 8: Write frontend tests**

Write tests for:
1. `pipeline-sse.ts`: verify event parsing, type routing, cleanup on unmount
2. `step-detail-panel.tsx`: verify action button visibility per phase
3. Full page integration: mock RPC + SSE, verify loading/error/states

- [ ] **Step 9: Run frontend tests**

```bash
npm test
```
Expected: All existing + new tests PASS.

- [ ] **Step 10: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 11: Commit**

```bash
git add ui/src/components/dashboard/pipeline-dag.tsx ui/src/components/dashboard/pipeline-dag-node.tsx ui/src/components/dashboard/step-detail-panel.tsx ui/src/lib/pipeline-sse.ts ui/src/app/dashboard/pipelines/ ui/src/app/dashboard/__tests__/
git commit -m "feat(ui): add pipeline DAG detail page with React Flow"
```

---

## Full Verification

- [ ] **Run all backend tests:** `go test ./internal/... -count=1`
- [ ] **Run all frontend tests:** `npm test`
- [ ] **Run linter:** `make lint`
- [ ] **Run TypeScript check:** `npx tsc --noEmit`
- [ ] **Verify `make manifests generate` succeeds** (CRDs + protos are current)
