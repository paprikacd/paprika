# Live SSE Streaming for Pod Logs — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan.

**Goal:** Replace 5s polling in `LogsTab` with true kubelet log streaming via Connect server-streaming RPC.

**Architecture:** `rpc StreamResourceLogs(...) returns (stream LogChunk)` — Connect server-streaming RPC (not raw SSE) for auth consistency. Server tails kubelet log stream and forwards each line as a protobuf `LogChunk`. Client uses `for await` over the streaming client method.

**Tech Stack:** Connect RPC streaming, controller-runtime, `io.Copy`-style stream forwarding, debounce hooks, `@testing-library/react`.

---

## Chunk 1: Proto + stubs

### Task 1: Add `StreamResourceLogs` messages + RPC to proto

**Files:**
- Modify: `proto/paprika/v1/api.proto`

- [ ] **Step 1.1: Append messages + service entry after `GetResourceTreeDetailedResponse`**

```proto
message StreamResourceLogsRequest {
  string application_namespace = 1;
  string application_name = 2;
  string resource_kind = 3;
  string resource_name = 4;
  string resource_namespace = 5;
  string container_name = 6;
  bool follow = 7;
}
message LogChunk {
  string pod_name = 1;
  string container_name = 2;
  string line = 3;
  int64 timestamp_ms = 4;
}
```

Add to service:
```proto
rpc StreamResourceLogs(StreamResourceLogsRequest) returns (stream LogChunk);
```

- [ ] **Step 1.2: Regenerate bindings**

```bash
go tool buf generate
```

- [ ] **Step 1.3: Commit**

```bash
git add proto/paprika/v1/api.proto internal/api/paprika/v1/api.pb.go internal/api/paprika/v1/v1connect/api.connect.go ui/src/gen/
git commit -m "proto: add StreamResourceLogs server-streaming RPC"
```

### Task 2: Add stubs on agent + repo-server

**Files:**
- Modify: `internal/agent/server/server.go`
- Modify: `internal/reposerver/server.go`

- [ ] **Step 2.1: Add `StreamResourceLogs` stub on agent**

```go
func (s *Server) StreamResourceLogs(ctx context.Context, _ *connect.Request[paprikav1.StreamResourceLogsRequest], _ *connect.ServerStream[paprikav1.LogChunk]) error {
    log.FromContext(ctx).Info("StreamResourceLogs not implemented on agent")
    return connect.NewError(connect.CodeUnimplemented, errors.New("streamResourceLogs is not implemented on the agent"))
}
```

Add `connect "connectrpc.com/connect"` if not already imported.

- [ ] **Step 2.2: Add stub on repo-server**

Same pattern.

- [ ] **Step 2.3: Verify compile**

```bash
go build ./...
```

- [ ] **Step 2.4: Commit**

```bash
git add internal/agent/server/server.go internal/reposerver/server.go
git commit -m "chore: add StreamResourceLogs stubs"
```

---

## Chunk 2: `StreamResourceLogs` handler + tests

### Task 3: Implement `StreamResourceLogs` handler

**Files:**
- Create: `internal/api/stream_resource_logs_handler.go`

- [ ] **Step 3.1: Write handler**

```go
package apiserver

import (
    "bufio"
    "context"
    "fmt"
    "io"
    "strings"
    "time"

    "connectrpc.com/connect"
    corev1 "k8s.io/api/core/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    "github.com/benebsworth/paprika/internal/api/auth"
    paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// StreamResourceLogs streams log chunks from a managed resource's pod to the
// client. When follow=true the kubelet log stream stays open until the client
// disconnects; when false the handler emits a single batch of recent lines.
func (s *PaprikaServer) StreamResourceLogs(
    ctx context.Context,
    req *connect.Request[paprikav1.StreamResourceLogsRequest],
    stream *connect.ServerStream[paprikav1.LogChunk],
) error {
    var app pipelinesv1alpha1.Application
    if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.ApplicationNamespace, Name: req.Msg.ApplicationName}, &app); err != nil {
        return fmt.Errorf("getting application: %w", err)
    }
    if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
        return connect.NewError(connect.CodePermissionDenied, err)
    }
    if s.k8sClient == nil {
        return connect.NewError(connect.CodeUnavailable, errors.New("kubernetes client not configured"))
    }

    ns := req.Msg.ResourceNamespace
    if ns == "" {
        ns = app.Namespace
    }

    pod, err := s.resolveLogsPod(ctx, req.Msg.ResourceKind, req.Msg.ResourceName, ns)
    if err != nil {
        return connect.NewError(connect.CodeFailedPrecondition, err)
    }

    opts := &corev1.PodLogOptions{
        Follow: req.Msg.Follow,
        Container: req.Msg.ContainerName,
    }
    kubeStream, err := s.k8sClient.CoreV1().Pods(ns).GetLogs(pod.Name, opts).Stream(ctx)
    if err != nil {
        return fmt.Errorf("opening log stream: %w", err)
    }
    defer kubeStream.Close()

    return forwardLogLines(ctx, stream, kubeStream, pod.Name, containerName(req.Msg.ContainerName, pod))
}

func containerName(req string, pod *corev1.Pod) string {
    if req != "" {
        return req
    }
    if len(pod.Spec.Containers) > 0 {
        return pod.Spec.Containers[0].Name
    }
    return ""
}

func forwardLogLines(
    ctx context.Context,
    stream *connect.ServerStream[paprikav1.LogChunk],
    src io.Reader,
    podName, container string,
) error {
    scanner := bufio.NewScanner(src)
    for scanner.Scan() {
        if err := ctx.Err(); err != nil {
            return err
        }
        chunk := &paprikav1.LogChunk{
            PodName:       podName,
            ContainerName: container,
            Line:          strings.TrimSuffix(scanner.Text(), "\r"),
            TimestampMs:   time.Now().UnixMilli(),
        }
        if err := stream.Send(chunk); err != nil {
            return err
        }
    }
    return scanner.Err()
}
```

- [ ] **Step 3.2: Verify compile + tests still pass**

```bash
go build ./internal/api/ && go test -count=1 ./internal/api/
```

### Task 4: `StreamResourceLogs` tests

**Files:**
- Create: `internal/api/stream_resource_logs_handler_test.go`

- [ ] **Step 4.1: Write failing tests**

```go
package apiserver

import (
    "bufio"
    "context"
    "fmt"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"

    "connectrpc.com/connect"
    "github.com/stretchr/testify/require"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/client-go/kubernetes"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    "k8s.io/client-go/rest"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func streamTestScheme(t *testing.T) *runtime.Scheme {
    t.Helper()
    scheme := runtime.NewScheme()
    require.NoError(t, clientgoscheme.AddToScheme(scheme))
    require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
    return scheme
}

func newStreamingPaprika(t *testing.T, ns string) (*PaprikaServer, *httptest.Server) {
    t.Helper()

    podJSON := fmt.Sprintf(`{"metadata":{"name":"demo-pod","namespace":%q},"spec":{"containers":[{"name":"app"}]}}`, ns)
    mux := http.NewServeMux()
    // Pod Get (synchronous, called by resolveLogsPod)
    mux.HandleFunc(fmt.Sprintf("/api/v1/namespaces/%s/pods/demo-pod", ns), func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        _, _ = w.Write([]byte(podJSON))
    })
    // Pod GetLogs streaming endpoint — chunked body, each line as a chunk
    mux.HandleFunc(fmt.Sprintf("/api/v1/namespaces/%s/pods/demo-pod/log", ns), func(w http.ResponseWriter, r *http.Request) {
        flusher, _ := w.(http.Flusher)
        w.Header().Set("Content-Type", "application/vnd.kubernetes.protobuf")
        w.WriteHeader(http.StatusOK)
        for _, line := range []string{"line1\n", "line2\n", "line3\n"} {
            _, _ = w.Write([]byte(line))
            if flusher != nil {
                flusher.Flush()
            }
            time.Sleep(10 * time.Millisecond)
        }
    })
    server := httptest.NewServer(mux)

    cfg := &rest.Config{Host: server.URL}
    k8s, err := kubernetes.NewForConfig(cfg)
    require.NoError(t, err)

    scheme := streamTestScheme(t)
    app := &pipelinesv1alpha1.Application{
        ObjectMeta: metav1.ObjectMeta{Name: "demo-app", Namespace: ns},
        Status: pipelinesv1alpha1.ApplicationStatus{
            Resources: []pipelinesv1alpha1.ResourceSync{
                {Kind: "Pod", Name: "demo-pod", Namespace: ns, Status: "Synced"},
            },
        },
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app).WithStatusSubresource(&pipelinesv1alpha1.Application{}).Build()
    return NewPaprikaServer(c, nil, WithK8sClient(k8s)), server
}

// Compile-time check that the fake k8s server is reachable.
var _ = (*bufio.Scanner)(nil)
var _ corev1.Pod

func TestStreamResourceLogs_StreamsLinesInOrder(t *testing.T) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    paprika, server := newStreamingPaprika(t, "paprika-e2e")
    defer server.Close()

    var chunks []*paprikav1.LogChunk
    err := paprika.StreamResourceLogs(ctx, connect.NewRequest(&paprikav1.StreamResourceLogsRequest{
        ApplicationNamespace: "paprika-e2e",
        ApplicationName:      "demo-app",
        ResourceKind:         "Pod",
        ResourceName:         "demo-pod",
        ResourceNamespace:    "paprika-e2e",
        Follow:               false,
    }), newTestServerStream(paprikav1.LogChunk{}, func(c *paprikav1.LogChunk) { chunks = append(chunks, c) }))
    require.NoError(t, err)
    require.Len(t, chunks, 3)
    require.Equal(t, "line1", chunks[0].Line)
    require.Equal(t, "line2", chunks[1].Line)
    require.Equal(t, "line3", chunks[2].Line)
    require.Equal(t, int64(0) < chunks[2].TimestampMs, true)
}
```

Add a `newTestServerStream` helper that wraps a slice-collector:

```go
type testServerStream struct {
    msg   paprikav1.LogChunk
    sink  func(*paprikav1.LogChunk)
    ctx   context.Context
}

func newTestServerStream(msg paprikav1.LogChunk, sink func(*paprikav1.LogChunk)) *testServerStream {
    return &testServerStream{msg: msg, sink: sink, ctx: context.Background()}
}

func (s *testServerStream) Send(m *paprikav1.LogChunk) error {
    s.sink(m)
    return nil
}
func (s *testServerStream) Context() context.Context { return s.ctx }
func (s *testServerStream) SendMsg(m interface{}) error { return nil }
func (s *testServerStream) RecvMsg(m interface{}) error { return nil }
func (s *testServerStream) Close() error { return nil }
func (s *testServerStream) Conn() *connect.ServerStreamForTest[any] { return nil }
```

(Use the real `connect.ServerStream` if available, otherwise use the simplest workaround — write a tiny adapter that satisfies the `connect.ServerStream` interface.)

- [ ] **Step 4.2: Run, fix errors, iterate to green**

```bash
go test -count=1 -timeout 60s ./internal/api/ -run TestStreamResourceLogs
```

- [ ] **Step 4.3: Commit**

```bash
git add internal/api/stream_resource_logs_handler.go internal/api/stream_resource_logs_handler_test.go
git commit -m "feat(api): StreamResourceLogs — connect server-streaming for kubelet log tail"
```

---

## Chunk 3: Frontend — `LogsTab` rewrite

### Task 5: Replace polling with streaming in `LogsTab`

**Files:**
- Modify: `ui/src/components/dashboard/resource-detail-panel.tsx`
- Modify: `ui/src/components/dashboard/resource-detail-panel.test.tsx`

- [ ] **Step 5.1: Write failing tests** (replace the polling tests)

```tsx
it("subscribes to log stream when Logs tab opens", async () => {
  const user = userEvent.setup()
  mockStreamResourceLogs.mockReturnValue(makeAsyncIter([
    { podName: "demo-pod", containerName: "app", line: "hello", timestampMs: 1 },
  ]))
  // ... open Logs tab, expect line rendered
})

it("appends incoming chunks to the visible buffer", async () => {
  // render → emit chunks incrementally → assert "hello" appears then "world" appears
})

it("cancels stream on tab switch and unmount", async () => {
  // toggle Logs → diff → assert stream cleaned up (a tear-down flag)
})

it("renders filter input and narrows visible lines", async () => {
  // type "hello" into filter input → assert only matching lines remain
})

it("shows reconnecting indicator on stream error", async () => {
  // mock stream throws → assert reconnect indicator
})
```

- [ ] **Step 5.2: Implement new `LogsTab`**

Key changes:
- Replace `setInterval(..., LOG_POLL_INTERVAL_MS)` with `useEffect` that calls `client.streamResourceLogs(req)` and iterates async
- Bounded ring buffer (last 5000 lines) — use `useRef<string[]>([])` and trim on each push
- Auto-scroll state: track if user is at the bottom; auto-scroll only when bottom is true
- Pause/resume toggle; pause = "follow" off, can keep stacking lines
- Filter input: `useDeferredValue` to debounce without blocking input
- Reconnect: `useRef<AbortController>`; on stream error, exponentially backoff (1s → 2s → 4s → 8s → 16s → 30s)
- Unmount/tab-switch: AbortController is aborted → `for await` loop breaks

- [ ] **Step 5.3: Update mocks in test file**

Add `mockStreamResourceLogs: vi.fn()` to `mockClient`. Implement `makeAsyncIter(items)` helper that returns `{ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: false, value: item }), return: () => Promise.resolve({ done: true }) }) }`.

- [ ] **Step 5.4: Run full vitest suite**

```bash
cd ui && npx vitest run
```

Expect 61 → ~66 tests passing.

- [ ] **Step 5.5: Commit**

```bash
git add ui/src/components/dashboard/resource-detail-panel.tsx ui/src/components/dashboard/resource-detail-panel.test.tsx
git commit -m "feat(ui): replace polling with streaming + filter + reconnect"
```

### Task 6: Build, deploy, verify

- [ ] **Step 6.1: Build UI from a clean cache**

```bash
cd ui && rm -rf .next ui/out && npm run build
```

- [ ] **Step 6.2: Copy static, rebuild Go binary via GHA**

```bash
rm -rf internal/api/uistatic/* && cp -r ui/out/* internal/api/uistatic/
git add internal/api/uistatic/
git commit -m "chore: rebuild UI bundle"
git push origin master
```

- [ ] **Step 6.3: Wait for GHA**

```bash
gh run watch <build-id>
```

- [ ] **Step 6.4: Helm upgrade with pinned sha tag, rollout**

```bash
source .env && SHA=$(git rev-parse --short HEAD)
helm upgrade paprika-e2e charts/chart/ --namespace paprika-e2e \
  --values deploy/test-values.yaml \
  --set "auth.oidc.clientID=$PAPRIKA_OIDC_CLIENT_ID" \
  --set "auth.oidc.clientSecret=$PAPRIKA_OIDC_CLIENT_SECRET" \
  --set "image.tag=sha-$SHA" \
  --wait --timeout 5m
kubectl rollout restart deployment -n paprika-e2e -l 'app.kubernetes.io/component in (api-server,controller-manager,webhook-receiver,repo-server)'
kubectl rollout status deployment -n paprika-e2e --timeout=5m
```

- [ ] **Step 6.5: Verify streaming RPC is wired**

```bash
# Hit the live chunk — confirm StreamResourceLogs in JS
curl -sL https://paprika.benebsworth.com/dashboard/application?namespace=paprika-e2e\&name=demo-app -o /tmp/app.html
for chunk in $(grep -oE '/_next/static/chunks/[a-zA-Z0-9_.-]+\.js' /tmp/app.html | sort -u); do
  curl -s "https://paprika.benebsworth.com${chunk}" | grep -q "streamResourceLogs" && echo "FOUND in $chunk"
done
```

- [ ] **Step 6.6: User verifies on UI** — open Logs tab on demo-app's Deployment, watch lines appear live; switch tabs → confirm stream closes; toggle filter → confirm narrows display.

---

## Done When

- Logs panel streams live lines; pause / filter / auto-scroll work
- Switching tabs cancels the stream (verified via Pod log GET abort in kubelet metrics)
- Reconnect indicator on transient errors, exponential backoff
- All existing tests still pass (Go + UI)
