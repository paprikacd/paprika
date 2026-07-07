# Pod Logs + Richer Resource Tree + Protobuf Pass — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan.

**Goal:** Add Pod Logs tab to ResourceDetailPanel, replace the flat `ResourceTable` with a TanStack Table expandable tree, and switch every client-go call site to protobuf content-type negotiation with JSON fallback.

**Architecture:** Two new Connect RPCs (`GetResourceLogs`, `GetResourceTreeDetailed`) on the backend with their handlers in `internal/api/`. UI swaps `ResourceTable` for `ResourceListTable` using `@tanstack/react-table` with `getSubRows` populated from the parent_kind field. A one-block-per-cmd entry-point changes client-go `ContentConfig` from JSON to protobuf (with `AcceptContentTypes` set to both protobuf and JSON so CRDs keep working).

**Tech Stack:** Connect RPC, controller-runtime, dynamic + clientset clients, `runtime.ContentTypeProtobuf`, TanStack Table v8, @connectrpc/connect-web, vitest.

---

## Chunk 1: Proto + protobuf content-type

### Task 1: Add new RPCs to proto

**Files:**
- Modify: `proto/paprika/v1/api.proto` (lines 631-665)

- [ ] **Step 1.1: Add `GetResourceLogs` messages and RPC**

Add after `GetResourceTreeResponse`:
```proto
message GetResourceLogsRequest {
  string application_namespace = 1;
  string application_name = 2;
  string resource_kind = 3;
  string resource_name = 4;
  string resource_namespace = 5;
  int32 tail_lines = 6;
}
message GetResourceLogsResponse {
  string pod_name = 1;
  string container_name = 2;
  repeated string containers = 3;
  string logs = 4;
  string error = 5;
}

message GetResourceTreeDetailedRequest {
  string application_namespace = 1;
  string application_name = 2;
}
message ResourceTreeNode {
  string kind = 1;
  string name = 2;
  string namespace = 3;
  string sync_status = 4;
  string health = 5;
  string health_message = 6;
  string parent_kind = 7;
  string parent_name = 8;
  string uid = 9;
  bool managed = 10;
  string phase = 11;
  int32 ready = 12;
  int32 total = 13;
  string message = 14;
  repeated string containers = 15;
}
message GetResourceTreeDetailedResponse {
  repeated ResourceTreeNode nodes = 1;
}
```

Add RPCs to the service:
```proto
rpc GetResourceLogs(GetResourceLogsRequest) returns (GetResourceLogsResponse);
rpc GetResourceTreeDetailed(GetResourceTreeDetailedRequest) returns (GetResourceTreeDetailedResponse);
```

- [ ] **Step 1.2: Regenerate Go bindings**

Run: `cd /Users/benebsworth/projects/paprika && buf generate proto/paprika/v1` (or whichever command the repo uses — check Buf config or Makefile)
Expected: New types in `internal/api/paprika/v1/api.pb.go`

- [ ] **Step 1.3: Regenerate TS bindings**

Run: `cd /Users/benebsworth/projects/paprika/ui && (script in package.json for proto)` — find the proto-gen script
Expected: Updated `ui/src/gen/paprika/v1/api_pb.{ts,d.ts,js}` and `api_connect.{ts,d.ts,js}`

- [ ] **Step 1.4: Commit**

```bash
git add proto/paprika/v1/api.proto internal/api/paprika/v1/api.pb.go ui/src/gen/
git commit -m "proto: add GetResourceLogs and GetResourceTreeDetailed RPCs"
```

### Task 2: Add stubs on agent and repo-server

**Files:**
- Modify: `internal/agent/server/server.go`
- Modify: `internal/reposerver/server.go`

- [ ] **Step 2.1: Add `GetResourceLogs` and `GetResourceTreeDetailed` stubs to agent**

In `internal/agent/server/server.go`, after the existing `GetResourceTree` stub:
```go
func (s *Server) GetResourceLogs(ctx context.Context, _ *connect.Request[paprikav1.GetResourceLogsRequest]) (*connect.Response[paprikav1.GetResourceLogsResponse], error) {
    log.FromContext(ctx).Info("GetResourceLogs not implemented on agent")
    return nil, connect.NewError(connect.CodeUnimplemented, errors.New("getResourceLogs is not implemented on the agent"))
}

func (s *Server) GetResourceTreeDetailed(ctx context.Context, _ *connect.Request[paprikav1.GetResourceTreeDetailedRequest]) (*connect.Response[paprikav1.GetResourceTreeDetailedResponse], error) {
    log.FromContext(ctx).Info("GetResourceTreeDetailed not implemented on agent")
    return nil, connect.NewError(connect.CodeUnimplemented, errors.New("getResourceTreeDetailed is not implemented on the agent"))
}
```

- [ ] **Step 2.2: Same stubs to repo-server**

Same pattern, in `internal/reposerver/server.go`.

- [ ] **Step 2.3: Verify build compiles**

Run: `cd /Users/benebsworth/projects/paprika && go build ./...`
Expected: exit 0

- [ ] **Step 2.4: Commit**

```bash
git add internal/agent/server/server.go internal/reposerver/server.go
git commit -m "chore: add GetResourceLogs / GetResourceTreeDetailed stubs"
```

### Task 3: Protobuf content type for client-go

**Files:**
- Modify: `cmd/main.go`
- Modify: `cmd/cloud-run/main.go`
- Modify: `cmd/main_controllers.go`

- [ ] **Step 3.1: Update main.go client-go config**

In `cmd/main.go`, find the `kubeConfig.ClientConfig()` call. Add right after:
```go
config.ContentConfig.ContentType = runtime.ContentTypeProtobuf
config.ContentConfig.AcceptContentTypes = runtime.ContentTypeProtobuf + "," + runtime.ContentTypeJSON
```

Add import: `"k8s.io/apimachinery/pkg/runtime"` (likely already there).

- [ ] **Step 3.2: Same for cloud-run/main.go**

Same change after the corresponding `ClientConfig()` call.

- [ ] **Step 3.3: Same for main_controllers.go**

Find the clientset creation in `main_controllers.go`. There may be a helper `clientsetFromInterface`. The content type needs to be set on the config BEFORE `kubernetes.NewForConfig(config)`. Trace and apply.

- [ ] **Step 3.4: Build**

Run: `go build ./...`
Expected: exit 0

- [ ] **Step 3.5: Update AGENTS.md with build considerations**

Add a note that `ContentConfig.ContentType = application/vnd.kubernetes.protobuf` is required. CRDs use JSON fallback.

- [ ] **Step 3.6: Commit**

```bash
git add cmd/
git commit -m "perf: negotiate protobuf content-type in client-go (JSON fallback)"
```

---

## Chunk 2: Pod Logs RPC + handler + tests

### Task 4: `GetResourceLogs` handler

**Files:**
- Create: `internal/api/resource_logs_handler.go`
- Create: `internal/api/resource_logs_handler_test.go`

- [ ] **Step 4.1: Write failing tests first (TDD)**

In `resource_logs_handler_test.go`, cover:
1. Pod kind → returns logs from named pod
2. Deployment kind → discovers child pod via label selector `app=<deployment-name>` and returns its logs
3. Unsupported kind (e.g. ConfigMap) → returns `error` field set
4. Pod doesn't exist → returns `error = "pod not found"`
5. Multi-container pod → returns first container's logs + populates `containers` array

Use `k8sfake.NewSimpleClientset` with preloaded Pod objects. For the streams, use the fake's `Fake` field to register a reactor on `pods` for the logs subresource.

```go
package apiserver

import (
    "context"
    "strings"
    "testing"

    "connectrpc.com/connect"
    "github.com/stretchr/testify/require"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    k8sfake "k8s.io/client-go/kubernetes/fake"
    "k8s.io/client-go/kubernetes/scheme"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
    "k8s.io/apimachinery/pkg/runtime"
)

func setupLogsTest(t *testing.T, objects ...runtime.Object) *PaprikaServer {
    t.Helper()
    scheme := runtime.NewScheme()
    require.NoError(t, scheme.AddToScheme(scheme.Scheme))

    app := &pipelinesv1alpha1.Application{
        ObjectMeta: metav1.ObjectMeta{Name: "demo-app", Namespace: "paprika-e2e"},
        Status: pipelinesv1alpha1.ApplicationStatus{
            Resources: []pipelinesv1alpha1.ResourceSync{{Kind: "Pod", Name: "demo-pod", Namespace: "paprika-e2e", Status: "Synced"}},
        },
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app).WithStatusSubresource(&pipelinesv1alpha1.Application{}).Build()
    k8s := k8sfake.NewSimpleClientset(objects...)
    return NewPaprikaServer(c, nil, WithK8sClient(k8s))
}

// Plus a helper to register fake log reactor.
```

- [ ] **Step 4.2: Run tests to confirm they fail**

Run: `go test ./internal/api/ -run TestGetResourceLogs -v`
Expected: FAIL (handler doesn't exist)

- [ ] **Step 4.3: Implement `GetResourceLogs` handler**

In `resource_logs_handler.go`:
```go
package apiserver

import (
    "context"
    "fmt"
    "io"
    "strings"

    "connectrpc.com/connect"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    "github.com/benebsworth/paprika/internal/api/auth"
    paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func (s *PaprikaServer) GetResourceLogs(
    ctx context.Context,
    req *connect.Request[paprikav1.GetResourceLogsRequest],
) (*connect.Response[paprikav1.GetResourceLogsResponse], error) {
    var app pipelinesv1alpha1.Application
    if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.ApplicationNamespace, Name: req.Msg.ApplicationName}, &app); err != nil {
        return nil, fmt.Errorf("getting application: %w", err)
    }
    if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
        return nil, connect.NewError(connect.CodePermissionDenied, err)
    }

    resp := &paprikav1.GetResourceLogsResponse{}
    if s.k8sClient == nil {
        resp.Error = "kubernetes client not configured"
        return connect.NewResponse(resp), nil
    }

    ns := req.Msg.ResourceNamespace
    if ns == "" {
        ns = app.Namespace
    }

    pod, err := s.resolveLogsPod(ctx, req.Msg.ResourceKind, req.Msg.ResourceName, ns)
    if err != nil {
        resp.Error = err.Error()
        return connect.NewResponse(resp), nil
    }

    resp.PodName = pod.Name
    containerNames := []string{}
    for _, c := range pod.Spec.Containers {
        containerNames = append(containerNames, c.Name)
    }
    resp.Containers = containerNames
    if len(containerNames) > 0 {
        resp.ContainerName = containerNames[0]
    }

    logs, err := s.streamPodLogs(ctx, ns, pod.Name, req.Msg.TailLines)
    if err != nil {
        resp.Error = err.Error()
        return connect.NewResponse(resp), nil
    }
    resp.Logs = logs
    return connect.NewResponse(resp), nil
}

func (s *PaprikaServer) resolveLogsPod(ctx context.Context, kind, name, namespace string) (*corev1.Pod, error) {
    switch kind {
    case "Pod":
        pod, err := s.k8sClient.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
        if err != nil {
            return nil, fmt.Errorf("pod %s/%s not found", namespace, name)
        }
        return pod, nil
    case "Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Job":
        pods, err := s.k8sClient.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
            LabelSelector: fmt.Sprintf("app=%s", name),
            Limit:         1,
        })
        if err != nil || len(pods.Items) == 0 {
            return nil, fmt.Errorf("no pods found for %s/%s", kind, name)
        }
        return &pods.Items[0], nil
    default:
        return nil, fmt.Errorf("logs only available for Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, or Job")
    }
}
```

- [ ] **Step 4.4: Register fake log reactor helper in tests**

In the test file, add a helper:
```go
func fakePodLogs(t *testing.T, k8s *k8sfake.Clientset, namespace, podName, content string) {
    t.Helper()
    k8s.PrependReactor("get", "pods", func(action clientgotesting.Action) (bool, runtime.Object, error) {
        if getAction, ok := action.(clientgotesting.GetActionImpl); ok {
            if getAction.Name == podName {
                return true, &corev1.Pod{
                    ObjectMeta: metav1.ObjectMeta{Name: podName, Namespace: namespace},
                    Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
                }, nil
            }
        }
        return false, nil, nil
    })
    // Logs subresource — use ObjectReaction or open a TCP server
}
```

For the stream itself, use a simpler approach: create a test `httptest.Server` that responds to `/api/v1/namespaces/<ns>/pods/<name>/log?tailLines=...&container=...` and override the fake clientset's path. The simplest reliable path: use `k8s.io/client-go/kubernetes/fake.NewSimpleClientset` which has `FakeInvoker` (`k8s.SetPing...` doesn't help). Easiest: gate the test by giving `s.k8sClient.CoreV1().Pods(ns).GetLogs(...)` access to a real `httptest.Server` via `kubernetes.NewForConfig`. **Alternative**: just write the test against `streamPodLogs` directly (which is already tested via the pipeline handler).

Actually: streamPodLogs is exercised but the test plumbing is the annoyance. Use `httptest.NewServer` and a `kubernetes.NewForConfig` client:
```go
import (
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
    clientgotesting "k8s.io/client-go/testing"
)
```

Set up:
```go
mux := http.NewServeMux()
mux.HandleFunc("/api/v1/namespaces/paprika-e2e/pods/demo-pod/log", func(w http.ResponseWriter, r *http.Request) {
    fmt.Fprint(w, "line 1\nline 2\n")
})
ts := httptest.NewServer(mux)
defer ts.Close()

cfg := &rest.Config{Host: ts.URL}
clientset, err := kubernetes.NewForConfig(cfg)
require.NoError(t, err)
srv := NewPaprikaServer(c, nil, WithK8sClient(clientset))
```

- [ ] **Step 4.5: Run tests, fix until green**

Run: `go test ./internal/api/ -run TestGetResourceLogs -v`
Expected: All 5 tests PASS

- [ ] **Step 4.6: Commit**

```bash
git add internal/api/resource_logs_handler.go internal/api/resource_logs_handler_test.go
git commit -m "feat(api): GetResourceLogs RPC for pod/container log streaming"
```

---

## Chunk 3: `GetResourceTreeDetailed` handler + tests

### Task 5: Tree detailed handler

**Files:**
- Modify: `internal/api/resource_tree_handler.go`
- Modify: `internal/api/resource_tree_handler_test.go`

- [ ] **Step 5.1: Write failing tests**

Add to `resource_tree_handler_test.go`:
```go
func TestGetResourceTreeDetailed_DeploymentWithReplicas(t *testing.T) {
    // Set up App with Deployment status
    // Preload fake k8s clientset with Deployment object having 2/3 ready replicas
    // Preload fake k8s clientset with Pods
    // Call GetResourceTreeDetailed
    // Expect Deployment node to have ready=2, total=3
}

func TestGetResourceTreeDetailed_PodPhase(t *testing.T) {
    // Set up App with Pod status
    // Preload fake k8s clientset with Pod having Phase: Running
    // Expect Pod node to have phase="Running"
}

func TestGetResourceTreeDetailed_MultiContainerPod(t *testing.T) {
    // Pod with 2 containers, one ready, one waiting
    // Expect node has containers=["a", "b"], ready=1, total=2
}
```

- [ ] **Step 5.2: Run tests to confirm they fail**

Run: `go test ./internal/api/ -run TestGetResourceTreeDetailed -v`
Expected: FAIL

- [ ] **Step 5.3: Implement `GetResourceTreeDetailed`**

In `resource_tree_handler.go`, add:
```go
func (s *PaprikaServer) GetResourceTreeDetailed(
    ctx context.Context,
    req *connect.Request[paprikav1.GetResourceTreeDetailedRequest],
) (*connect.Response[paprikav1.GetResourceTreeDetailedResponse], error) {
    var app pipelinesv1alpha1.Application
    if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.ApplicationNamespace, Name: req.Msg.ApplicationName}, &app); err != nil {
        return nil, fmt.Errorf("getting application: %w", err)
    }
    if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
        return nil, connect.NewError(connect.CodePermissionDenied, err)
    }

    nodes := make([]*paprikav1.ResourceTreeNode, 0)
    healthMsg := make(map[string]string)
    for _, h := range app.Status.ResourceHealth {
        healthMsg[h.Kind+"/"+h.Name] = h.Message
    }

    for _, r := range app.Status.Resources {
        n := &paprikav1.ResourceTreeNode{
            Kind:       r.Kind,
            Name:       r.Name,
            Namespace:  r.Namespace,
            SyncStatus: r.Status,
            Health:     "",
            Managed:    true,
        }
        if h, ok := healthMsg[r.Kind+"/"+r.Name]; ok {
            n.HealthMessage = h
        }
        s.populateNodeDetail(ctx, n)
        nodes = append(nodes, n)
    }

    if s.dynamicClient != nil {
        discovered := s.discoverChildren(ctx, app.Namespace, nodes)
        for _, d := range discovered {
            s.populateNodeDetail(ctx, d)
            nodes = append(nodes, d)
        }
    }

    return connect.NewResponse(&paprikav1.GetResourceTreeDetailedResponse{Nodes: nodes}), nil
}

func (s *PaprikaServer) populateNodeDetail(ctx context.Context, n *paprikav1.ResourceTreeNode) {
    if s.k8sClient == nil || n.Name == "" {
        return
    }
    switch n.Kind {
    case "Pod":
        pod, err := s.k8sClient.CoreV1().Pods(n.Namespace).Get(ctx, n.Name, metav1.GetOptions{})
        if err != nil {
            return
        }
        n.Phase = string(pod.Status.Phase)
        containers := []string{}
        ready := int32(0)
        for _, c := range pod.Spec.Containers {
            containers = append(containers, c.Name)
        }
        n.Containers = containers
        n.Total = int32(len(pod.Spec.Containers))
        for _, cs := range pod.Status.ContainerStatuses {
            if cs.Ready {
                ready++
            }
        }
        n.Ready = ready
        if pod.Status.Message != "" {
            n.Message = pod.Status.Message
        }
    case "Deployment":
        d, err := s.k8sClient.AppsV1().Deployments(n.Namespace).Get(ctx, n.Name, metav1.GetOptions{})
        if err != nil {
            return
        }
        n.Ready = d.Status.ReadyReplicas
        n.Total = d.Status.Replicas
        for _, cond := range d.Status.Conditions {
            if cond.Type == appsv1.DeploymentAvailable && cond.Status == corev1.ConditionFalse {
                n.Message = cond.Message
            }
        }
    case "StatefulSet":
        ss, err := s.k8sClient.AppsV1().StatefulSets(n.Namespace).Get(ctx, n.Name, metav1.GetOptions{})
        if err != nil {
            return
        }
        n.Ready = ss.Status.ReadyReplicas
        n.Total = ss.Status.Replicas
    case "DaemonSet":
        ds, err := s.k8sClient.AppsV1().DaemonSets(n.Namespace).Get(ctx, n.Name, metav1.GetOptions{})
        if err != nil {
            return
        }
        n.Ready = ds.Status.NumberReady
        n.Total = ds.Status.DesiredNumberScheduled
    }
}
```

- [ ] **Step 5.4: Run tests, fix until green**

Run: `go test ./internal/api/ -run TestGetResourceTreeDetailed -v`
Expected: PASS

- [ ] **Step 5.5: Commit**

```bash
git add internal/api/resource_tree_handler.go internal/api/resource_tree_handler_test.go
git commit -m "feat(api): GetResourceTreeDetailed returns pod/replica status"
```

---

## Chunk 4: UI — Logs tab + TanStack Table list view

### Task 6: Install `@tanstack/react-table`

**Files:**
- Modify: `ui/package.json`

- [ ] **Step 6.1: Add dep**

Run: `cd /Users/benebsworth/projects/paprika/ui && npm install @tanstack/react-table@^8`
Expected: package.json + package-lock.json updated

- [ ] **Step 6.2: Commit**

```bash
git add ui/package.json ui/package-lock.json
git commit -m "chore: add @tanstack/react-table dep"
```

### Task 7: Add Logs tab to `ResourceDetailPanel`

**Files:**
- Modify: `ui/src/components/dashboard/resource-detail-panel.tsx`
- Modify: `ui/src/components/dashboard/resource-detail-panel.test.tsx`

- [ ] **Step 7.1: Write failing tests**

In `resource-detail-panel.test.tsx`, add:
```tsx
it("shows loading state on Logs tab", async () => {
  const user = userEvent.setup()
  render(<ResourceDetailPanel {...defaults} />)
  await user.click(screen.getByRole("button", { name: /logs/i }))
  expect(screen.getByTestId("loader")).toBeInTheDocument()
})

it("renders logs on success", async () => {
  // Mock getResourceLogs to return canned response
  // Click Logs tab
  // Assert logs are visible in monospace pre
})

it("renders error message when API returns error field", async () => {
  // Mock returns error="unsupported kind"
  // Assert the error is displayed
})

it("Refresh button re-fetches logs", async () => {
  // Click Logs tab
  // Mock returns successfully
  // Click Refresh
  // Spy asserts getResourceLogs was called twice
})
```

- [ ] **Step 7.2: Run tests to confirm they fail**

Run: `cd /Users/benebsworth/projects/paprika/ui && npx vitest run src/components/dashboard/resource-detail-panel.test.tsx`
Expected: FAIL (no Logs tab yet)

- [ ] **Step 7.3: Implement Logs tab**

Modify `resource-detail-panel.tsx`:
- Add `Terminal` icon to lucide-react imports (mock it in tests too)
- Add `Tab = "diff" | "live" | "desired" | "events" | "logs"`
- Add to `tabs` array: `{ id: "logs", label: "Logs", icon: Terminal }`
- Add `logs: GetResourceLogsResponse | null` state
- Add `logsLoading: boolean` state
- Add `useEffect` that:
  - Runs only when `tab === "logs"` and resource is set
  - Calls `client.getResourceLogs(...)` with tailLines: 100
  - Sets `setInterval(..., 5000)` for polling
  - Cleanup: clear interval + cancelled flag
- Manual refresh button: `onClick` clears interval, immediately refetches, restarts interval
- `LogsView` component: shows pre-formatted logs OR error banner OR empty state
- Last-updated indicator with relative time (e.g. "5s ago")

- [ ] **Step 7.4: Run tests, fix until green**

Run: `npx vitest run src/components/dashboard/resource-detail-panel.test.tsx`
Expected: PASS

- [ ] **Step 7.5: Commit**

```bash
git add ui/src/components/dashboard/resource-detail-panel.tsx ui/src/components/dashboard/resource-detail-panel.test.tsx
git commit -m "feat(ui): Logs tab in ResourceDetailPanel with 5s auto-refresh"
```

### Task 8: TanStack Table list view (`ResourceListTable`)

**Files:**
- Create: `ui/src/components/dashboard/resource-list-table.tsx`
- Create: `ui/src/components/dashboard/resource-list-table.test.tsx`
- Modify: `ui/src/app/dashboard/application/page.tsx`
- Delete: `ui/src/components/dashboard/resource-table.tsx`
- Delete: `ui/src/components/dashboard/resource-table.test.tsx`

- [ ] **Step 8.1: Write failing tests**

In `resource-list-table.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ResourceListTable, buildTree, type FlatTreeNode } from "@/components/dashboard/resource-list-table"

// Mock lucide-react icons

describe("buildTree", () => {
  it("builds parent → children index from flat list", () => {
    const flat: FlatTreeNode[] = [
      { kind: "Deployment", name: "demo-deploy", parentKind: "", parentName: "" },
      { kind: "ReplicaSet", name: "demo-deploy-abc12", parentKind: "Deployment", parentName: "demo-deploy" },
    ]
    const tree = buildTree(flat)
    expect(tree).toHaveLength(1)
    expect(tree[0].subRows).toHaveLength(1)
  })
  it("puts roots-first regardless of input order", () => { /* ... */ })
  it("handles orphans gracefully (parent not in list)", () => { /* ... */ })
})

describe("ResourceListTable", () => {
  it("renders rows for each root node", () => { /* ... */ })
  it("clicking a chevron expands children", async () => { /* ... */ })
  it("calls onSelect when a row is clicked", async () => { /* ... */ })
  it("renders empty state when no nodes", () => { /* ... */ })
})
```

- [ ] **Step 8.2: Run tests to confirm they fail**

Run: `npx vitest run src/components/dashboard/resource-list-table.test.tsx`
Expected: FAIL

- [ ] **Step 8.3: Implement `ResourceListTable`**

```tsx
"use client"

import { useMemo } from "react"
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type Row,
} from "@tanstack/react-table"
import { ChevronRight, Activity, Server, Box } from "lucide-react"

export interface FlatTreeNode {
  kind: string
  name: string
  namespace: string
  syncStatus?: string
  health?: string
  healthMessage?: string
  parentKind?: string
  parentName?: string
  managed?: boolean
  phase?: string
  ready?: number
  total?: number
  message?: string
  containers?: string[]
}

interface TreeNode extends FlatTreeNode {
  subRows?: TreeNode[]
}

export function buildTree(flat: FlatTreeNode[]): TreeNode[] {
  const byKindName = new Map<string, TreeNode>()
  flat.forEach(n => byKindName.set(`${n.kind}/${n.name}`, { ...n }))
  const roots: TreeNode[] = []
  flat.forEach(n => {
    const node = byKindName.get(`${n.kind}/${n.name}`)!
    if (n.parentKind && n.parentName && byKindName.has(`${n.parentKind}/${n.parentName}`)) {
      const parent = byKindName.get(`${n.parentKind}/${n.parentName}`)!
      parent.subRows = parent.subRows ?? []
      parent.subRows.push(node)
    } else {
      roots.push(node)
    }
  })
  return roots
}

const columnHelper = createColumnHelper<TreeNode>()

interface ResourceListTableProps {
  nodes: FlatTreeNode[]
  onSelect: (n: { kind: string; name: string; namespace: string; syncStatus?: string; health?: string; healthMessage?: string }) => void
}

export function ResourceListTable({ nodes, onSelect }: ResourceListTableProps) {
  const data = useMemo(() => buildTree(nodes), [nodes])
  const columns = useMemo(() => [
    columnHelper.display({
      id: "expander",
      header: () => null,
      cell: ({ row }) => (
        row.getCanExpand() ? (
          <button
            onClick={(e) => { e.stopPropagation(); row.toggleExpanded() }}
            className="..."
          >
            <ChevronRight className={row.getIsExpanded() ? "rotate-90 transition-transform" : "transition-transform"} />
          </button>
        ) : null
      ),
    }),
    columnHelper.accessor("kind", { header: "Kind", cell: ctx => <KindBadge kind={ctx.getValue()} /> }),
    columnHelper.accessor("name", { header: "Name", cell: ctx => <span className="font-mono text-xs">{ctx.getValue()}</span> }),
    columnHelper.accessor("syncStatus", { header: "Sync" }),
    columnHelper.accessor("health", { header: "Health" }),
    columnHelper.display({
      id: "ready",
      header: "Ready",
      cell: ({ row }) => {
        const { ready, total } = row.original
        if (total === undefined || total === 0) return null
        const good = ready === total
        const partial = ready > 0 && ready < total
        const cls = good ? "text-emerald-500" : partial ? "text-amber-500" : "text-destructive"
        return <span className={`tabular-nums ${cls}`}>{ready}/{total}</span>
      },
    }),
  ], [])

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getSubRows: (row) => row.subRows,
  })

  if (data.length === 0) {
    return <div className="...">No resources to display.</div>
  }

  return (
    <table className="w-full">
      {/* render header + rows; each row uses flexRender for cells, onClick triggers onSelect(row.original) */}
    </table>
  )
}
```

- [ ] **Step 8.4: Run tests, fix until green**

Run: `npx vitest run src/components/dashboard/resource-list-table.test.tsx`
Expected: PASS

- [ ] **Step 8.5: Update `application/page.tsx` to use new component**

Replace `ResourceTable` import with `ResourceListTable` and `MergedResource` with the `FlatTreeNode` shape from the `GetResourceTreeDetailed` response. Add a `useEffect` that fetches the detailed tree.

- [ ] **Step 8.6: Delete old `resource-table.tsx` and `.test.tsx`**

Remove files; if any other files import them, fix them.

- [ ] **Step 8.7: Run full vitest suite**

Run: `npx vitest run`
Expected: all PASS

- [ ] **Step 8.8: Commit**

```bash
git add ui/src/components/dashboard/resource-list-table.tsx ui/src/components/dashboard/resource-list-table.test.tsx ui/src/app/dashboard/application/page.tsx
git rm ui/src/components/dashboard/resource-table.tsx ui/src/components/dashboard/resource-table.test.tsx
git commit -m "feat(ui): TanStack Table list view with expandable children"
```

### Task 9: Build, deploy, verify

- [ ] **Step 9.1: Build UI**

Run: `cd /Users/benebsworth/projects/paprika/ui && rm -rf .next ui/out && npm run build`
Expected: exit 0

- [ ] **Step 9.2: Copy static assets**

Run: `rm -rf internal/api/uistatic/* && cp -r ui/out/* internal/api/uistatic/`

- [ ] **Step 9.3: Run Go test suite**

Run: `go test ./internal/api/ -v -count=1`
Expected: All PASS

- [ ] **Step 9.4: Commit + push**

```bash
git add internal/api/uistatic/
git commit -m "chore: rebuild UI bundle"
git push origin master
```

- [ ] **Step 9.5: Wait for GHA build + push**

Run: `gh run watch <build-id>`
Expected: ✓ success

- [ ] **Step 9.6: Helm upgrade with pinned image tag**

```bash
source .env && helm upgrade paprika-e2e charts/chart/ --namespace paprika-e2e \
  --values deploy/test-values.yaml \
  --set "auth.oidc.clientID=$PAPRIKA_OIDC_CLIENT_ID" \
  --set "auth.oidc.clientSecret=$PAPRIKA_OIDC_CLIENT_SECRET" \
  --set "image.tag=sha-${GIT_SHA}" \
  --wait --timeout 5m
kubectl set image deployment/paprika-e2e-api-server -n paprika-e2e api-server=ghcr.io/paprikacd/paprika:sha-${GIT_SHA}
kubectl set image deployment/paprika-e2e-webhook-receiver -n paprika-e2e webhook-receiver=ghcr.io/paprikacd/paprika:sha-${GIT_SHA}
kubectl set image deployment/paprika-e2e-repo-server -n paprika-e2e repo-server=ghcr.io/paprikacd/paprika:sha-${GIT_SHA}
kubectl set image deployment/paprika-e2e-controller-manager -n paprika-e2e manager=ghcr.io/paprikacd/paprika:sha-${GIT_SHA}
kubectl rollout status deployment -n paprika-e2e --timeout=5m
```

- [ ] **Step 9.7: Live verify**

Run: `curl -fsSL "https://paprika.benebsworth.com/_next/static/chunks/<page-chunk>.js" | grep -c "GetResourceLogs"`
Hard-refresh and click a row in the application detail page — should see Logs tab + expanders in list view.

---

## Done When

- Application detail page on `paprika.benebsworth.com` shows a Logs tab that streams pod logs with a 5s refresh.
- List view shows expandable rows (Deployment has ReplicaSets under it, etc.).
- Every client-go call now uses `ContentTypeProtobuf` with JSON fallback (visible by `Accept` header on any kubectl-style API call).
- Existing Application controller / pipeline manager continue to function — no regressions.
