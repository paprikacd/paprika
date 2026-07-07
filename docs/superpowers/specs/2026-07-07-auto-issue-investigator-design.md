# Auto-Issue Investigator — Pluggable Architecture

## Goal

A user-triggered "Investigate" action on any resource in the application detail panel that processes the live manifest, Kubernetes events, and recent pod logs and produces a structured report of issues. v1 ships deterministic rule-based detectors. The **plugin architecture** (Sources → Detectors → Narrators) makes future LLMs, MCPs, or external observability adapters drop-in additions without touching the engine or UI.

## Three-Layer Plugin Model

All three interfaces are plain Go interfaces in `internal/investigator/registry.go`. Plugins self-register via `init()` in their own subdirectory:

```go
package investigator

// DataSource contributes structured evidence (manifests, events, logs, metrics…).
type DataSource interface {
    Name() string                                                            // "manifest", "events", "logs", "prom:container_cpu", "mcp:k8s_audit"
    Collect(ctx context.Context, ref ResourceRef) ([]Evidence, error)
}

// Detector inspects the combined evidence and emits zero-or-more findings.
type Detector interface {
    ID() string                                                              // stable: "crash_loop", "image_pull", ...
    Severity() Severity                                                      // Critical, Warning, Info
    Detect(ctx context.Context, in Input) ([]Finding, error)
}

// Narrator synthesizes findings + evidence into a human-readable report.
type Narrator interface {
    Name() string                                                            // "deterministic", "anthropic", "mcp:incident_summary"
    Narrate(ctx context.Context, findings []Finding, evidence []Evidence) (Report, error)
}

// Registry holds the active plugin set and runs them in fan-out order.
type Registry struct{ /* unexported slices */ }
func NewRegistry() *Registry
func (r *Registry) RegisterSource(s DataSource)
func (r *Registry) RegisterDetector(d Detector)
func (r *Registry) RegisterNarrator(n Narrator)
func (r *Registry) Investigate(ctx context.Context, ref ResourceRef) (*Response, error)
```

**Default registry** is wired in `internal/investigator/registry_default.go` and registers:
- **Sources**: `ManifestSource` (dynamic client), `EventsSource` (clientset field-selector), `LogsSource` (clientset GetLogs)
- **Detectors**: 8 built-in rule-based detectors (CrashLoop, OOMKilled, ImagePull, PendingScheduling, DeploymentReplicasDrift, ConfigDrift, ForbiddenRbac, EndpointMismatch)
- **Narrators**: `DeterministicNarrator` (string composition; always-on, never errors out)

**Conditional plugins** live in subdirectories and self-register when an env-var gate is set at startup:
- `internal/investigator/plugins/narrators/anthropic/` — `init()` checks `INVESTIGATOR_ANTHROPIC_API_KEY`; if set, registers `AnthropicNarrator`
- `internal/investigator/plugins/sources/mcp/` — `init()` checks `INVESTIGATOR_MCP_CONFIG`; registers `MCPSource`
- `internal/investigator/plugins/sources/prometheus/` — gates on `INVESTIGATOR_PROMETHEUS_URL`

v1 ships the gates but no implementations.

## Built-in Detectors (8)

| ID | Severity | Trigger |
|---|---|---|
| `crash_loop` | Critical | Pod `ContainerStatuses[i].RestartCount ≥ 3` OR `Waiting.Reason == "CrashLoopBackOff"` |
| `oom_killed` | Critical | Container `LastTerminationState.Terminated.Reason == "OOMKilled"` |
| `image_pull` | Critical | Events `reason ∈ {Failed, BackOff, ErrImagePull, Pulling}` AND `involvedObject.kind == Pod` |
| `pending_scheduling` | Warning | Pod `Phase == "Pending"` AND ≥1 `FailedScheduling` event |
| `deployment_replicas_drift` | Warning | Deployment `ReadyReplicas < Replicas` (escalates to Critical if ready=0) |
| `config_drift` | Warning | Existing diff is non-empty (after server-field stripping) |
| `forbidden_rbac` | Warning | Events with `reason == "Forbidden"` referencing this resource |
| `endpoint_mismatch` | Info | Service selector matches zero Pods |

Each detector returns 0..N `Finding` entries with: `ID`, `Severity`, `Title`, `Description`, `[]Evidence` (pointers to source data), `Playbook []string` (actionable suggestions).

## RPC

```proto
message InvestigateRequest {
  string application_namespace = 1;
  string application_name = 2;
  string resource_kind = 3;
  string resource_name = 4;
  string resource_namespace = 5;
}
message FindingEvidence {
  string source = 1;      // "events", "logs", "manifest", "diff"
  string timestamp = 2;
  string summary = 3;
}
message InvestigationFinding {
  string id = 1;
  Severity severity = 2;  // enum: SEVERITY_UNSPECIFIED, CRITICAL, WARNING, INFO
  string title = 3;
  string description = 4;
  repeated FindingEvidence evidence = 5;
  repeated string playbook = 6;
  string narrator = 7;    // which narrator produced the title/description
}
message InvestigateResponse {
  repeated InvestigationFinding findings = 1;
  string summary = 2;
  string narrator = 3;
  uint64 generated_at_ms = 4;
}

rpc Investigate(InvestigateRequest) returns (InvestigateResponse);
```

Plus a metadata endpoint to surface the plugin set to UIs:
```proto
message ListPluginsRequest {}
message PluginInfo { string name = 1; string type = 2; }   // type ∈ {source, detector, narrator}
message ListPluginsResponse { repeated PluginInfo plugins = 1; }

rpc ListInvestigatorPlugins(ListPluginsRequest) returns (ListPluginsResponse);
```

## Handler (PaprikaServer.Investigate)

1. Authorize application via existing `authorizeApplication`
2. Resolve the target resource → manifest
3. Run all registered `DataSource`s **in parallel** (errgroup), collect evidence
4. Build `Input` from sources' Evidence (indexed by source name + structured getters for `Events`, `Logs`, `LiveManifest`, `Diff`)
5. Run all registered `Detector`s in parallel
6. Sort findings: critical → warning → info, then by ID for stability
7. Run `Narrator`s **in registration order** — first non-error wins
8. Return response

## UI

`InvestigationPanel` opens from an "Investigate" sparkles-button in the resource detail header. Renders:
- Header with summary text + generation timestamp + narrator name
- Per-finding card: severity pill, title, description, "Show evidence (n)" toggle, playbook list
- Empty state: green check + "All clear at <time>"
- Loading state: skeleton + "Analyzing logs · events · manifest…"

Footer: "Detectors: 8" / "Sources: 3" — pulled from `ListInvestigatorPlugins`.

## Files Touched

### New
- `proto/paprika/v1/api.proto` — messages + RPCs
- `internal/investigator/registry.go` — interfaces + `Registry` + `Investigate`
- `internal/investigator/registry_default.go` — `init()` for default Sources/Detectors
- `internal/investigator/sources/{manifest,events,logs}.go`
- `internal/investigator/detectors/{crash_loop,oom_killed,image_pull,pending,replicas_drift,config_drift,forbidden_rbac,endpoint_mismatch}.go`
- `internal/investigator/narrators/deterministic.go`
- `internal/investigator/plugins/{narrators/anthropic,sources/mcp,sources/prometheus}/` — empty stubs + gates
- `internal/api/investigator_handler.go`
- `internal/api/investigator_handler_test.go`
- `ui/src/components/dashboard/investigation-panel.tsx`
- `ui/src/components/dashboard/investigation-panel.test.tsx`

### Modified
- `internal/agent/server/server.go`, `internal/reposerver/server.go` — stubs
- `ui/src/components/dashboard/resource-detail-panel.tsx` — "Investigate" button + drawer
- `ui/src/app/dashboard/application/page.tsx` — wire investigation state

### Generated
- `internal/api/paprika/v1/api.pb.go`, `v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/api_pb.{ts,d.ts,js}`, `api_connect.{ts,d.ts,js}`

## Tests

- Per-detector unit test (hand-crafted `Input` fixtures — all 8 detectors)
- `Registry.Investigate` runs the fan-out with one mock `DataSource` + one detector that returns a finding; assert response shape
- `DeterministicNarrator` produces expected strings for empty + populated finding sets
- UI: `InvestigationPanel` renders findings, empty state, loading state

## Done When

- "Investigate" button on resource detail opens drawer in <2s with deterministic findings
- 8 detectors run, list shows count + narrator name
- Adding a new `Detector` requires only creating a struct that implements the interface — no engine changes
- v2 LLM-narrator: a future PR adds `internal/investigator/plugins/narrators/anthropic/` with `init()` that gates on `INVESTIGATOR_ANTHROPIC_API_KEY` — no other changes needed
