# Auto-Issue Investigator — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan.

**Goal:** Pluggable investigator framework with 8 deterministic detectors, deterministic narrator, RPC + UI. Plugin slots ready for future LLMs, MCPs, Prometheus.

**Architecture:** `DataSource → Detector → Narrator` interfaces; `Registry.Investigate` orchestrates fan-out via errgroup. Default registry wired in `init()`.

**Tech Stack:** Go interfaces, controller-runtime (dynamic client), K8s typed clientset, Connect RPC, vitest, framer-motion, lucide-react.

---

## Chunk 1: Proto + plumbing

### Task 1: Add proto messages + RPCs

**Files:**
- Modify: `proto/paprika/v1/api.proto`

- [ ] **Step 1.1: Add proto messages + RPCs after `GetResourceTreeDetailed`**

```proto
enum Severity {
  SEVERITY_UNSPECIFIED = 0;
  CRITICAL = 1;
  WARNING = 2;
  INFO = 3;
}

message InvestigateRequest {
  string application_namespace = 1;
  string application_name = 2;
  string resource_kind = 3;
  string resource_name = 4;
  string resource_namespace = 5;
}
message FindingEvidence {
  string source = 1;
  string timestamp = 2;
  string summary = 3;
}
message InvestigationFinding {
  string id = 1;
  Severity severity = 2;
  string title = 3;
  string description = 4;
  repeated FindingEvidence evidence = 5;
  repeated string playbook = 6;
  string narrator = 7;
}
message InvestigateResponse {
  repeated InvestigationFinding findings = 1;
  string summary = 2;
  string narrator = 3;
  uint64 generated_at_ms = 4;
}
message ListInvestigatorPluginsRequest {}
message PluginInfo {
  string name = 1;
  string type = 2;  // "source", "detector", "narrator"
}
message ListInvestigatorPluginsResponse {
  repeated PluginInfo plugins = 1;
}

rpc Investigate(InvestigateRequest) returns (InvestigateResponse);
rpc ListInvestigatorPlugins(ListInvestigatorPluginsRequest) returns (ListInvestigatorPluginsResponse);
```

- [ ] **Step 1.2: Regenerate bindings**

```bash
go tool buf generate
```

- [ ] **Step 1.3: Commit**

```bash
git add proto/paprika/v1/api.proto internal/api/paprika/v1/api.pb.go internal/api/paprika/v1/v1connect/api.connect.go ui/src/gen/
git commit -m "proto: add Investigate + ListInvestigatorPlugins RPCs"
```

### Task 2: Add stubs on agent + repo-server

- [ ] **Step 2.1: Stub `Investigate` + `ListInvestigatorPlugins` on agent and repo-server**

Same pattern as `GetResourceLogs`: `connect.CodeUnimplemented`.

- [ ] **Step 2.2: Verify build**

```bash
go build ./...
```

- [ ] **Step 2.3: Commit**

```bash
git add internal/agent/server/server.go internal/reposerver/server.go
git commit -m "chore: add investigator stubs"
```

---

## Chunk 2: Investigator framework + built-in sources/detectors/narrator

### Task 3: Registry + interfaces

**Files:**
- Create: `internal/investigator/registry.go`

- [ ] **Step 3.1: Write interfaces + Registry + Investigate**

```go
package investigator

import (
    "context"
    "errors"
    "fmt"
    "sort"
    "sync"
    "golang.org/x/sync/errgroup"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// Severity ranks for sorting findings (Critical first).
type Severity int32

const (
    SeverityUnspecified Severity = 0
    SeverityCritical    Severity = 1
    SeverityWarning     Severity = 2
    SeverityInfo        Severity = 3
)

type ResourceRef struct {
    ApplicationNamespace string
    ApplicationName      string
    Kind                 string
    Name                 string
    Namespace            string
}

type Evidence struct {
    Source    string
    Timestamp string
    Summary   string
}

type Finding struct {
    ID          string
    Severity    Severity
    Title       string
    Description string
    Evidence    []Evidence
    Playbook    []string
}

type Input struct {
    Ref           ResourceRef
    App           *pipelinesv1alpha1.Application
    LiveManifest  *unstructured.Unstructured
    Diff          string
    Events        []KubernetesEvent
    Logs          []string
}

// Event is a slim representation of K8s events.
type KubernetesEvent struct {
    Type           string
    Reason         string
    Message        string
    LastTimestamp  string
    Count          int32
    ObjectKind     string
    ObjectName     string
    ObjectNamespace string
}

type DataSource interface {
    Name() string
    Collect(ctx context.Context, ref ResourceRef) ([]Evidence, error)
}

type Detector interface {
    ID() string
    Severity() Severity
    Detect(ctx context.Context, in Input) ([]Finding, error)
}

type Narrator interface {
    Name() string
    Narrate(ctx context.Context, findings []Finding, evidence []Evidence) (Report, error)
}

type Report struct {
    Summary string
    Narrator string
}

type Response struct {
    Findings     []Finding
    Summary      string
    Narrator     string
    GeneratedAtMS int64
}

type Registry struct {
    sources   []DataSource
    detectors []Detector
    narrators []Narrator
    appClient applicationGetter
    dynClient dynamicClient
    k8sClient k8sClient
    kube       *corev1.Pod // unused; remove
    // ...
}

// NewRegistry builds a Registry with optional dependencies. Sources and
// detectors are still registered explicitly via Register* methods.
func NewRegistry() *Registry { return &Registry{} }

func (r *Registry) RegisterSource(s DataSource)    { r.sources = append(r.sources, s) }
func (r *Registry) RegisterDetector(d Detector)    { r.detectors = append(r.detectors, d) }
func (r *Registry) RegisterNarrator(n Narrator)    { r.narrators = append(r.narrators, n) }

func (r *Registry) Sources() []DataSource   { return append([]DataSource(nil), r.sources...) }
func (r *Registry) Detectors() []Detector   { return append([]Detector(nil), r.detectors...) }
func (r *Registry) Narrators() []Narrator   { return append([]Narrator(nil), r.narrators...) }
```

Append to the file (we'll wire the actual data fetches in the handler rather than the registry to keep it testable).

- [ ] **Step 3.2: Verify compile**

```bash
go build ./internal/investigator/
```

### Task 4: Default registry wiring

**Files:**
- Create: `internal/investigator/registry_default.go`

- [ ] **Step 4.1: Wire built-in sources, detectors, narrator**

```go
package investigator

// NewDefaultRegistry returns a Registry with all built-in Sources, Detectors,
// and the Deterministic narrator wired up.
func NewDefaultRegistry(opts ...Option) *Registry {
    r := NewRegistry()
    r.RegisterSource(&ManifestSource{})
    r.RegisterSource(&EventsSource{})
    r.RegisterSource(&LogsSource{})
    r.RegisterDetector(&CrashLoopDetector{})
    r.RegisterDetector(&OOMKilledDetector{})
    r.RegisterDetector(&ImagePullDetector{})
    r.RegisterDetector(&PendingSchedulingDetector{})
    r.RegisterDetector(&DeploymentReplicasDriftDetector{})
    r.RegisterDetector(&ConfigDriftDetector{})
    r.RegisterDetector(&ForbiddenRbacDetector{})
    r.RegisterDetector(&EndpointMismatchDetector{})
    r.RegisterNarrator(&DeterministicNarrator{})
    return r
}
```

### Task 5: Built-in DataSources

**Files:**
- Create: `internal/investigator/sources/manifest.go`
- Create: `internal/investigator/sources/events.go`
- Create: `internal/investigator/sources/logs.go`

- [ ] **Step 5.1: `ManifestSource`** — uses dynamic client to fetch and return manifest as Evidence.

- [ ] **Step 5.2: `EventsSource`** — uses clientset to field-select events on involvedObject (kind/name/namespace). Limit to last 50.

- [ ] **Step 5.3: `LogsSource`** — uses k8sclient.CoreV1().Pods(ns).GetLogs(...).Stream() and reads up to 500 lines.

(Sources in v1 emit *evidence*; the handler is responsible for the heavy lifting because we already have the k8s/dynamic clients there.)

### Task 6: Built-in Detectors

**Files:**
- Create: `internal/investigator/detectors/crash_loop.go`
- Create: `internal/investigator/detectors/oom_killed.go`
- Create: `internal/investigator/detectors/image_pull.go`
- Create: `internal/investigator/detectors/pending.go`
- Create: `internal/investigator/detectors/replicas_drift.go`
- Create: `internal/investigator/detectors/config_drift.go`
- Create: `internal/investigator/detectors/forbidden_rbac.go`
- Create: `internal/investigator/detectors/endpoint_mismatch.go`

- [ ] **Step 6.1: Implement each detector.** Each lives in its own file, ~50-80 lines. Tests in the same package.

- [ ] **Step 6.2: Per-detector tests.** Drive each with hand-crafted `Input` fixtures — both triggering and non-triggering.

### Task 7: Deterministic narrator

**Files:**
- Create: `internal/investigator/narrators/deterministic.go`

- [ ] **Step 7.1: Implement summary composition**

```go
func (n *DeterministicNarrator) Narrate(ctx, findings, evidence) (Report, error) {
    if len(findings) == 0 {
        return Report{Summary: "All clear", Narrator: n.Name()}, nil
    }
    var crit, warn, info int
    for _, f := range findings {
        switch f.Severity {
        case SeverityCritical: crit++
        case SeverityWarning:  warn++
        case SeverityInfo:     info++
        }
    }
    return Report{
        Summary: fmt.Sprintf("%d critical, %d warning, %d info", crit, warn, info),
        Narrator: n.Name(),
    }, nil
}
```

### Task 8: Plugin stubs (MCP / Anthropic / Prometheus)

**Files:**
- Create: `internal/investigator/plugins/narrators/anthropic/narrator.go` (skeleton with gate)
- Create: `internal/investigator/plugins/sources/mcp/source.go` (skeleton with gate)
- Create: `internal/investigator/plugins/sources/prometheus/source.go` (skeleton with gate)

- [ ] **Step 8.1: Skeleton plugins + gate.** Each file does `init() { if v, ok := os.LookupEnv("INVESTIGATOR_X"); ok && v != "" { reg.RegisterX(...) } }`. The body is a no-op placeholder so v1 has no behavior change.

---

## Chunk 3: API handler + tests

### Task 9: Investigator handler

**Files:**
- Create: `internal/api/investigator_handler.go`

- [ ] **Step 9.1: Implement handler**

```go
package apiserver

import (
    "context"
    "fmt"
    "sort"
    "sync"
    "time"
    "connectrpc.com/connect"
    "sigs.k8s.io/controller-runtime/pkg/client"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    "github.com/benebsworth/paprika/internal/api/auth"
    paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
    "github.com/benebsworth/paprika/internal/investigator"
)

var registry = investigator.NewDefaultRegistry()

func (s *PaprikaServer) Investigate(ctx context.Context, req *connect.Request[paprikav1.InvestigateRequest]) (*connect.Response[paprikav1.InvestigateResponse], error) {
    var app pipelinesv1alpha1.Application
    if err := s.client.Get(ctx, client.ObjectKey{Namespace: req.Msg.ApplicationNamespace, Name: req.Msg.ApplicationName}, &app); err != nil {
        return nil, fmt.Errorf("getting application: %w", err)
    }
    if err := s.authorizeApplication(ctx, auth.ActionRead, &app); err != nil {
        return nil, connect.NewError(connect.CodePermissionDenied, err)
    }
    ref := investigator.ResourceRef{
        ApplicationNamespace: app.Namespace,
        ApplicationName:      app.Name,
        Kind:                 req.Msg.ResourceKind,
        Name:                 req.Msg.ResourceName,
        Namespace:            req.Msg.ResourceNamespace,
    }
    in, err := s.collectInvestigatorInput(ctx, ref)
    if err != nil { return nil, err }
    resp, err := registry.Investigate(ctx, in)
    if err != nil { return nil, err }
    return connect.NewResponse(toProtoResponse(resp)), nil
}

func (s *PaprikaServer) ListInvestigatorPlugins(ctx, req) (*connect.Response, error) {
    var plugins []*paprikav1.PluginInfo
    for _, s := range registry.Sources() {
        plugins = append(plugins, &paprikav1.PluginInfo{Name: s.Name(), Type: "source"})
    }
    for _, d := range registry.Detectors() {
        plugins = append(plugins, &paprikav1.PluginInfo{Name: d.ID(), Type: "detector"})
    }
    for _, n := range registry.Narrators() {
        plugins = append(plugins, &paprikav1.PluginInfo{Name: n.Name(), Type: "narrator"})
    }
    return connect.NewResponse(&paprikav1.ListInvestigatorPluginsResponse{Plugins: plugins}), nil
}
```

`collectInvestigatorInput` does the live manifest fetch, events fetch, and logs read (reusing helpers from the resource handlers).

- [ ] **Step 9.2: Test handler errors (auth)**

```go
func TestInvestigate_AppNotFound(t *testing.T)
func TestInvestigate_NoDynamicClient(t *testing.T)
func TestListInvestigatorPlugins_Defaults(t *testing.T)  // assert 3 sources, 8 detectors, 1 narrator
```

### Task 10: Wire plugins into cmd/main.go startup

- [ ] **Step 10.1: Import the plugin packages**

```go
import (
    _ "github.com/benebsworth/paprika/internal/investigator/plugins/narrators/anthropic"
    _ "github.com/benebsworth/paprika/internal/investigator/plugins/sources/mcp"
    _ "github.com/benebsworth/paprika/internal/investigator/plugins/sources/prometheus"
)
```

This ensures the plugin `init()`s run on startup.

---

## Chunk 4: UI

### Task 11: Investigation panel component

**Files:**
- Create: `ui/src/components/dashboard/investigation-panel.tsx`
- Create: `ui/src/components/dashboard/investigation-panel.test.tsx`

- [ ] **Step 11.1: Component**

`InvestigationPanel` props: `applicationNamespace`, `applicationName`, `resource`, `onClose`. Renders a slide-over drawer (same shape as `ResourceDetailPanel`) with the findings list, summary, narrator, evidence expanders, playbook list. Buttons: "Investigate" (calls `client.investigate`), "Refresh", "Close".

- [ ] **Step 11.2: Tests** (8+ tests)
  - Renders the summary header
  - Renders per-finding cards with severity pill
  - "All clear" empty state
  - Loading state while fetching
  - Evidence toggle opens/closes the list
  - Refresh button re-fetches
  - onClose called when dismissed

### Task 12: Wire into ResourceDetailPanel

**Files:**
- Modify: `ui/src/components/dashboard/resource-detail-panel.tsx`

- [ ] **Step 12.1: Add "Investigate" button** (lucide `Sparkles` icon) in the header next to the close button.

- [ ] **Step 12.2: Add investigation state** in the parent — `investigation: 'closed' | 'open'`, `<InvestigationPanel ... />` mounted when open.

---

## Chunk 5: Build, deploy, verify

- [ ] **Step 13.1: Run Go + UI tests**

```bash
go test -count=1 ./internal/...
cd ui && npx vitest run
```

- [ ] **Step 13.2: Build UI**

```bash
rm -rf .next ui/out && npm run build
```

- [ ] **Step 13.3: Copy uistatic, commit, push**

```bash
git add -A && git commit -m "feat: auto-issue investigator with pluggable sources/detectors/narrators"
git push origin master
```

- [ ] **Step 13.4: Watch GHA, deploy with sha pinning**

```bash
gh run watch <id>
# helm upgrade with image.tag=sha-...; rollout restart
```

- [ ] **Step 13.5: Verify the JS bundle includes `investigate`**

```bash
curl -sL https://paprika.benebsworth.com/.../page-chunk.js | grep -c "investigate"
```

---

## Done When

- Application detail page → Resource detail panel → "Investigate" button opens drawer
- Click → server returns ≤2s with 0-8 findings, deterministic narrator
- Each finding card: severity, title, description, evidence, playbook
- "All clear" empty state when no findings
- Adding a new `Detector` is: write struct + `init()` registration — nothing else
- v2 PR for an `AnthropicNarrator` simply adds a file in `plugins/narrators/anthropic/` + sets `INVESTIGATOR_ANTHROPIC_API_KEY`
