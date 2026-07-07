# Live SSE Streaming for Pod Logs — Design

## Goal

Replace the 5-second polling in the resource detail panel's Logs tab with real-time streaming. When a user opens the Logs tab, the client opens a streaming RPC to the paprika server, which in turn tails a kubelet log stream and forwards each line as a chunked protobuf message. The user sees lines the moment they hit stdout/stderr, not 5 seconds later.

## Architecture

### New proto additions (`proto/paprika/v1/api.proto`)

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

rpc StreamResourceLogs(StreamResourceLogsRequest) returns (stream LogChunk);
```

### Backend (`internal/api/stream_resource_logs_handler.go`)

- Authorize application via `authorizeApplication` (consistent with the rest of the API)
- Resolve to pod via existing `resolveLogsPod` (Pod kind = direct, parent kinds = label selector)
- Open `s.k8sClient.CoreV1().Pods(ns).GetLogs(name, &corev1.PodLogOptions{Follow: req.Msg.Follow, Container: req.Msg.ContainerName}).Stream(ctx)`
- Forward each `Read` line as a `LogChunk` with `timestamp_ms = time.Now().UnixMilli()`
- Server-side batching: flush every 200ms or 64 lines, whichever comes first, to avoid one-frame-per-line overhead
- Cancellation: when the client's `ctx` is done (client disconnects), `defer logStream.Close()`
- One-shot path: `Follow == false` reuses the existing `streamPodLogs` and yields a single `LogChunk` with `Logs` payload — backward compatible with `GetResourceLogs`

### Stubs

`internal/agent/server/server.go` and `internal/reposerver/server.go` get `Connect CodeUnimplemented` returns — same pattern as the existing `GetResourceLogs` stubs.

### Frontend (`ui/src/components/dashboard/resource-detail-panel.tsx`)

`LogsTab`:
- On mount: `for await (const chunk of client.streamResourceLogs({..., follow: true}))` — append each line to a bounded ring buffer (last 5000 lines, drop oldest)
- Auto-scroll to bottom unless the user has scrolled away (track with a debounced `userScrolled` state)
- Pause/resume button (still streams but doesn't auto-scroll; clears buffer)
- Filter input: case-insensitive substring match, debounced 150ms (only renders matching lines)
- Cancel: `for await` loop breaks when the component unmounts / tab switches / panel closes
- Reconnect: on transient stream error, retry with exponential backoff (1s, 2s, 4s … max 30s); surface a "reconnecting…" indicator
- Error: if non-recoverable (e.g. unsupported kind), show the server's `error` field if returned
- Loading / empty / error states preserved with the same shapes as today

### Tests

- Go (`internal/api/stream_resource_logs_handler_test.go`):
  - Fake `httptest` server that emits log lines incrementally
  - Verify: chunks arrive in order, cancellation closes the underlying stream, error kind surfaces error field
- UI (`resource-detail-panel.test.tsx`): replace the 5s polling tests with stream-based equivalents
  - Subscription on tab open
  - Lines stream in as chunks arrive
  - Filter narrows the visible buffer
  - Cleanup on tab switch

## Files Touched

### New
- `proto/paprika/v1/api.proto` — messages + RPC
- `internal/api/stream_resource_logs_handler.go`
- `internal/api/stream_resource_logs_handler_test.go`

### Modified
- `internal/agent/server/server.go` — stub
- `internal/reposerver/server.go` — stub
- `ui/src/components/dashboard/resource-detail-panel.tsx` — `LogsTab` rewrite
- `ui/src/components/dashboard/resource-detail-panel.test.tsx` — new tests

### Generated (will update via `go tool buf generate`)
- `internal/api/paprika/v1/api.pb.go`
- `internal/api/paprika/v1/v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/api_pb.{ts,d.ts,js}`
- `ui/src/gen/paprika/v1/api_connect.{ts,d.ts,js}`

## Done When

- Open Logs tab on a Deployment or Pod → see lines appear as kubelet generates them, sub-second latency
- Switching tabs cancels the stream (no half-open kubelet connections)
- Page reload after an error → exponential backoff reconnect with visible indicator
- Manual pause stops auto-scroll while still receiving
- Filter narrows what's displayed but doesn't pause the stream
