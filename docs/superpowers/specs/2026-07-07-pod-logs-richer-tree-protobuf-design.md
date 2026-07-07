# Application Detail — Pod Logs, Richer Tree, Protobuf Performance Pass

## Goal

Three coupled improvements to the application detail page on `paprika.benebsworth.com`:

1. **Logs tab** — show recent pod/container logs in the resource detail slide-over with auto-refresh.
2. **Tree-structured list view** — replace the flat list with a TanStack Table that has expanders showing discovered child resources (pods, ReplicaSets, etc.) under their parent resource.
3. **Protobuf content-type for client-go** — switch every client-go call site from JSON to `application/vnd.kubernetes.protobuf` (with `application/json` fallback for CRDs that lack protobuf schemas). One-line-per-call-site perf win across the entire controller.

## Architecture

### Backend (`internal/api/`)

Two new RPCs:

```
rpc GetResourceLogs(GetResourceLogsRequest) returns (GetResourceLogsResponse);
rpc GetResourceTreeDetailed(GetResourceTreeDetailedRequest) returns (GetResourceTreeDetailedResponse);
```

**`GetResourceLogs`** resolves the resource to a Pod (single hop via owner references / label selector) and streams the pod's last `tail_lines` (default 100, hard-capped at 10000). Supports `Pod | Deployment | ReplicaSet | StatefulSet | DaemonSet | Job`. For multi-container pods, returns the first container by default; the response includes a `containers` array so the client can switch later. Returns `error` field for unsupported kinds (`"logs only available for Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, or Job"`).

**`GetResourceTreeDetailed`** extends `GetResourceTree`'s tree building with per-node status:
- Pods: phase, ready containers / total containers, containers list
- Deployment/StatefulSet/DaemonSet: replicas-ready/desired, status-condition message
- All others: leave detail fields empty

Existing `GetResourceTree` is **kept** (graph view continues using it; it stays lean without populating the extra fields).

Wire format: `ResourceTreeNode` reuses the `ResourceNode` field 1–10 and adds 11–15 for the detail block.

### Protobuf content type for client-go

In `cmd/main.go` and `cmd/cloud-run/main.go` (the two existing kubeconfig loaders), add after `kubeConfig.ClientConfig()`:

```go
config.ContentConfig.ContentType = runtime.ContentTypeProtobuf
config.ContentConfig.AcceptContentTypes = runtime.ContentTypeProtobuf + "," + runtime.ContentTypeJSON
```

Same change applies to `cmd/main_controllers.go`'s per-controller clientsets. CRDs (Application, Release, Pipeline, Template, ApplicationSet) do not have protobuf schemas registered in their CRD OpenAPI; the API server responds with JSON automatically because `AcceptContentTypes` includes JSON. Verifies inside the integration tests.

This affects:
- `streamPodLogs` (already 50%+ of the bytes in pod log streaming are the JSON envelope; protobuf halts it)
- `getResourceEvents`
- `findLatestStepJob`, `findJobPod`
- All controller-manager reconciler list/get
- Everything served by `s.k8sClient` in `internal/api`

### Frontend (`ui/src/components/dashboard/`)

**`ResourceDetailPanel` — Logs tab**
- Add `Tab = "logs"`
- Lucide icon `Terminal`
- On tab open: `client.getResourceLogs(...)` with `tailLines: 100`
- 5-second polling interval via `useEffect` + `setInterval`, **only** while tab is active and panel is open
- Manual refresh button (skips next interval)
- Empty state: returns `error` field if non-Pod-root kind or no child pods
- Live red dot + `Last updated: <relative time>` indicator

**`ResourceListTable` — TanStack Table**
- New component replacing `ResourceTable` (delete the old one — it's behind a feature toggle and not exported anywhere else)
- `@tanstack/react-table` (need to add — not currently in deps)
- `getSubRows: (row) => row.children` built from `parentKind` field on the flat RPC response
- Columns: kind (icon), name (mono font), sync status (badge), health, ready/total (tabular numerals), containers (chip)
- Expand chevron in the leftmost column
- Each row opens the detail panel with `kind`/`name`/`namespace`
- Empty state if no nodes
- Tested with a flat→tree build + render + click + expand

**Toggle behaviour on detail page** is unchanged — `ResourceGraph` uses `GetResourceTree`, `ResourceListTable` uses `GetResourceTreeDetailed`.

## Components / Files

### New
- `proto/paprika/v1/api.proto` — 2 messages + 2 RPCs added
- `internal/api/resource_logs_handler.go` — `GetResourceLogs` handler
- `internal/api/resource_logs_handler_test.go` — Go tests
- `ui/src/components/dashboard/resource-list-table.tsx`
- `ui/src/components/dashboard/resource-list-table.test.tsx`

### Modified
- `internal/api/resource_tree_handler.go` — `GetResourceTreeDetailed` + helpers
- `internal/api/resource_tree_handler_test.go` — extended with detailed assertions
- `internal/agent/server/server.go` — stub `GetResourceLogs` + `GetResourceTreeDetailed`
- `internal/reposerver/server.go` — stub same
- `cmd/main.go`, `cmd/cloud-run/main.go`, `cmd/main_controllers.go` — content type negotiation
- `ui/src/components/dashboard/resource-detail-panel.tsx` — Logs tab + polling
- `ui/src/app/dashboard/application/page.tsx` — swap `ResourceTable` → `ResourceListTable`, add `GetResourceTreeDetailed` fetch
- `ui/package.json` — add `@tanstack/react-table`

### Deleted
- `ui/src/components/dashboard/resource-table.tsx`, `.test.tsx` — replaced

## Data Flow

```
[User clicks Pod row in graph OR list]
    │
    ▼
[ResourceDetailPanel opens]
    │
    ├──[Diff/Live/Desired/Events tabs] → GetResource
    │
    └──[Logs tab] → GetResourceLogs (5s polling)
                       │
                       ├─ Pod kind → streamPodLogs()
                       ├─ Parent kind → resolve child Pod via labelSelector → streamPodLogs()
                       └─ Other → return error message in response

[User toggles "List" view on resource section]
    │
    ▼
[ResourceListTable mounts]
    │
    ├── Fetches GetResourceTreeDetailed → flat list w/ ready/total
    ├── Builds parent→children index client-side via parentKind
    ├── Renders TanStack Table rows with expanders
    └── Row click → setSelectedResource → opens ResourceDetailPanel
```

Protobuf: every `kubectl logs`-equivalent flight is ~40–60% smaller bytes with the protobuf envelope.

## Error Handling

- `GetResourceLogs` returns `error` field, NOT an RPC error. Client renders error message inline.
- Unsupported kind → returns `error = "logs only available for ..."`.
- Pod not found by selector → returns empty `logs` + `pod_name = ""`.
- Polymorphic DecodeError (some CRD with protobuf request) → falls back to JSON via AcceptContentTypes. We test with a fake CRD in the integration test to confirm.

## Testing

- `internal/api/resource_logs_handler_test.go` — fake clientset, Pod with two containers, verify logs fetched + container names returned + non-supported kind returns error
- `internal/api/resource_tree_handler_test.go` — extend with Deployment + Pod statuses, verify `ready`/`total`/`phase`/`containers`
- Add a Go test that confirms `ContentConfig.ContentType` and `AcceptContentTypes` are set correctly (or an integration assertion in the existing test setup)
- `ui/src/components/dashboard/resource-list-table.test.tsx` — flat→tree build, render, expand, click, empty state
- Extend `ui/src/components/dashboard/resource-detail-panel.test.tsx` — add Logs tab tests: loading, success, empty, error, refresh button

All existing tests pass without modification.

## Open Questions

None outstanding at this time.
