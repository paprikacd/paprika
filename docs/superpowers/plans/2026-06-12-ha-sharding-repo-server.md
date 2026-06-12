# HA Leader Election, Sharding & Repo Server Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable horizontal scaling of Paprika with leader-elected controller-manager replicas, namespace-hash controller sharding, and a dedicated repo-server for cached git/S3 source resolution.

**Architecture:**
- Controller-manager runs as a StatefulSet with `--leader-elect` and per-pod `PAPRIKA_SHARD_ID`/`PAPRIKA_SHARD_TOTAL` environment variables. Each shard reconciles only the namespaces whose hash maps to its ordinal.
- A new `repo-server` gRPC service provides source resolution and manifest rendering with a shared disk cache, so controller pods no longer clone/fetch per reconcile.
- Helm chart supports `manager.sharding.enabled` (StatefulSet) and `repoServer.enabled`, while retaining backward-compatible monolith/split modes.

**Tech Stack:** Go, controller-runtime, connect-go, Helm v3 SDK, Kubernetes StatefulSet.

---

## File Structure

- `internal/sharding/sharding.go` — existing shard filter (extend with per-replica helpers)
- `internal/controller/pipelines/*_controller.go` — already respect `ShardFilter` via early return in `Reconcile`
- `internal/reposerver/` — **new package** with gRPC service, source cache, and helm rendering
- `internal/reposerver/client/` — **new package** with connect client for controllers to call repo-server
- `cmd/main.go` — add `--mode=repo-server` and wire repo client into controllers when `PAPRIKA_REPO_SERVER_ADDR` is set
- `internal/api/paprika/v1/repo.proto` or plain connect service — define repo-server RPCs (optional; can start with shared Go interface)
- `charts/chart/templates/manager/statefulset.yaml` — **new** shard-aware StatefulSet (used when `manager.sharding.enabled`)
- `charts/chart/templates/repo-server/` — **new** directory with Deployment, Service, HPA
- `charts/chart/values.yaml` — add `manager.sharding` and `repoServer` sections

---

## Chunk 1: Extend Sharding Package

**Files:**
- Modify: `internal/sharding/sharding.go`
- Test: `internal/sharding/sharding_test.go`

### Task 1.1: Add shard-config validation helper

- [ ] **Step 1: Write failing test for `MustLoadFromEnvOrPod`**

```go
func TestMustLoadFromEnvOrPod(t *testing.T) {
	t.Setenv("POD_NAME", "paprika-controller-manager-2")
	t.Setenv("PAPRIKA_SHARD_TOTAL", "4")
	f, err := MustLoadFromEnvOrPod()
	require.NoError(t, err)
	assert.True(t, f.Enabled())
	assert.Equal(t, 2, f.ShardID())
}
```

- [ ] **Step 2: Run test; expect failure**

```bash
go test ./internal/sharding/... -run TestMustLoadFromEnvOrPod -v
```

- [ ] **Step 3: Implement `MustLoadFromEnvOrPod`**

Add to `internal/sharding/sharding.go`:

```go
const podNameEnv = "POD_NAME"

// MustLoadFromEnvOrPod creates a shard filter from explicit env vars or from the pod name.
// If PAPRIKA_SHARD_ID is unset and POD_NAME ends with an ordinal, the ordinal is used.
func MustLoadFromEnvOrPod() (*Filter, error) {
	idStr := os.Getenv(shardIDEnv)
	if idStr == "" {
		idStr = os.Getenv(podNameEnv)
	}
	totalStr := os.Getenv(shardTotalEnv)
	if totalStr == "" {
		return NewFilterFromEnv(), nil
	}
	total, err := strconv.Atoi(totalStr)
	if err != nil {
		return nil, fmt.Errorf("invalid %s: %w", shardTotalEnv, err)
	}
	if total <= 1 {
		return NewFilter(0, 1), nil
	}

	id, err := strconv.Atoi(idStr)
	if err != nil {
		id = extractOrdinalFromPodName(idStr)
	}
	if id < 0 || id >= total {
		return nil, fmt.Errorf("shard ID %d out of range [0, %d)", id, total)
	}
	return NewFilter(id, total), nil
}
```

- [ ] **Step 4: Run tests**

```bash
make test
```

- [ ] **Step 5: Commit**

---

## Chunk 2: Scaffold Repo Server Package

**Files:**
- Create: `internal/reposerver/server.go`
- Create: `internal/reposerver/source.go`
- Create: `internal/reposerver/render.go`
- Create: `internal/reposerver/client/client.go`
- Create: `internal/reposerver/reposerver_test.go`

### Task 2.1: Define repo-server interface

- [ ] **Step 1: Create `internal/reposerver/server.go`**

```go
package reposerver

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"connectrpc.com/connect"
	"sigs.k8s.io/controller-runtime/pkg/log"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	"github.com/benebsworth/paprika/source"
)

// Server provides cached source resolution and manifest rendering.
type Server struct {
	renderer engine.TemplateRenderer
	workDir  string
}

// NewServer creates a repo server with the given working directory.
func NewServer(workDir string) *Server {
	return &Server{
		renderer: engine.NewCachedTemplateRenderer(
			engine.NewHelmSDKRenderer(workDir),
			nil, // TODO: wire Redis cache when available
			workDir,
			0,
		),
		workDir: workDir,
	}
}

// ResolveSourceRequest is the input for source resolution.
type ResolveSourceRequest struct {
	Template *paprikav1.Template
}

// ResolveSourceResponse contains the resolved source.
type ResolveSourceResponse struct {
	Result *source.ResolveResult
}

// ResolveSource resolves a template source.
func (s *Server) ResolveSource(ctx context.Context, req *ResolveSourceRequest) (*ResolveSourceResponse, error) {
	log.FromContext(ctx).Info("Resolving source", "template", req.Template.Name)
	result, err := s.renderer.ResolveSource(ctx, req.Template)
	if err != nil {
		return nil, fmt.Errorf("resolve source: %w", err)
	}
	return &ResolveSourceResponse{Result: result}, nil
}

// RenderRequest is the input for manifest rendering.
type RenderRequest struct {
	Template *paprikav1.Template
	Values   map[string]interface{}
}

// RenderResponse contains rendered manifests.
type RenderResponse struct {
	Manifests []string
}

// Render renders a template into manifests.
func (s *Server) Render(ctx context.Context, req *RenderRequest) (*RenderResponse, error) {
	log.FromContext(ctx).Info("Rendering template", "template", req.Template.Name)
	manifests, err := s.renderer.Render(ctx, req.Template, req.Values)
	if err != nil {
		return nil, fmt.Errorf("render template: %w", err)
	}
	return &RenderResponse{Manifests: manifests}, nil
}

// Handler returns an HTTP handler for the repo server (placeholder for connect service).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return mux
}

// Run starts the repo server on the given address.
func (s *Server) Run(ctx context.Context, addr string) error {
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.FromContext(ctx).Info("Starting repo server", "addr", addr)
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("repo server error: %w", err)
	}
	return nil
}
```

- [ ] **Step 2: Create `internal/reposerver/reposerver_test.go`** with minimal health check test

```go
func TestServerHealth(t *testing.T) {
	srv := NewServer(t.TempDir())
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	assert.Equal(t, http.StatusOK, rr.Code)
}
```

- [ ] **Step 3: Run test**

```bash
go test ./internal/reposerver/... -v
```

- [ ] **Step 4: Commit**

---

### Task 2.2: Add repo-server connect service definition

- [ ] **Step 1: Create `internal/reposerver/v1/reposerver.proto`**

```protobuf
syntax = "proto3";
package paprika.reposerver.v1;

option go_package = "github.com/benebsworth/paprika/internal/reposerver/v1;repov1";

message ResolveSourceRequest {
  string namespace = 1;
  string name = 2;
  string type = 3;
  bytes spec_json = 4;
}

message ResolveSourceResponse {
  string local_path = 1;
  string hash = 2;
  string revision = 3;
}

message RenderRequest {
  string namespace = 1;
  string name = 2;
  string type = 3;
  bytes spec_json = 4;
  bytes values_json = 5;
}

message RenderResponse {
  repeated string manifests = 1;
}

service RepoServerService {
  rpc ResolveSource(ResolveSourceRequest) returns (ResolveSourceResponse);
  rpc Render(RenderRequest) returns (RenderResponse);
}
```

- [ ] **Step 2: Generate connect code**

```bash
buf generate internal/reposerver/v1
# or use protoc + connect plugins
```

- [ ] **Step 3: Commit**

---

## Chunk 3: Wire Repo Server Mode into Main Binary

**Files:**
- Modify: `cmd/main.go`
- Test: `cmd/main_test.go`

### Task 3.1: Add `--mode=repo-server`

- [ ] **Step 1: Register repo-server mode flag and env var**

In `cmd/main.go`, add to `cliConfig`:

```go
repoServerAddr string
```

Add flag:

```go
flag.StringVar(&cfg.repoServerAddr, "repo-server-addr", os.Getenv("PAPRIKA_REPO_SERVER_ADDR"),
    "Address of the repo server. When set, controllers delegate source resolution/rendering to it.")
```

- [ ] **Step 2: Add `runRepoServerMode`**

```go
func runRepoServerMode(addr, probeAddr string) error {
	workDir := os.Getenv("PAPRIKA_REPO_WORKDIR")
	if workDir == "" {
		workDir = "/tmp/paprika-repo"
	}
	srv := reposerver.NewServer(workDir)

	healthMux := buildHealthMux()
	startHealthProbeServer(healthMux, probeAddr)

	return srv.Run(context.Background(), addr)
}
```

- [ ] **Step 3: Update mode validation**

```go
if cfg.mode != "operator" && cfg.mode != "api" && cfg.mode != "webhook" && cfg.mode != "repo-server" {
```

- [ ] **Step 4: Add mode branch**

```go
if cfg.mode == "repo-server" {
    addr := cfg.uiAddr // reuse uiAddr as repo server bind address
    if err := runRepoServerMode(addr, cfg.probeAddr); err != nil {
        setupLog.Error(err, "Repo server mode failed")
        os.Exit(1)
    }
    os.Exit(0)
}
```

- [ ] **Step 5: Update test**

```go
func TestRepoServerHealthEndpoint(t *testing.T) {
    port := freePort()
    probe := freePort()
    go func() {
        _ = runRepoServerMode(port, probe)
    }()
    time.Sleep(200 * time.Millisecond)
    resp, err := http.Get("http://" + probe + "/healthz")
    require.NoError(t, err)
    assert.Equal(t, http.StatusOK, resp.StatusCode)
}
```

- [ ] **Step 6: Run tests**

```bash
make test
```

- [ ] **Step 7: Commit**

---

## Chunk 4: Update Helm Chart for Sharding and Repo Server

**Files:**
- Create: `charts/chart/templates/manager/statefulset.yaml`
- Create: `charts/chart/templates/repo-server/deployment.yaml`
- Create: `charts/chart/templates/repo-server/service.yaml`
- Create: `charts/chart/templates/repo-server/hpa.yaml`
- Modify: `charts/chart/values.yaml`
- Modify: `charts/chart/templates/manager/manager.yaml`

### Task 4.1: Add sharding values and StatefulSet

- [ ] **Step 1: Update `values.yaml`**

Under `manager:` add:

```yaml
  # -- Enable controller sharding. When true, manager is deployed as a StatefulSet
  # with per-pod PAPRIKA_SHARD_ID/PAPRIKA_SHARD_TOTAL env vars.
  sharding:
    enabled: false
    replicas: 3
    serviceName: controller-manager-headless
```

Add new top-level section:

```yaml
## Repo server caches git/S3 sources and renders manifests.
##
repoServer:
  enabled: false
  replicas: 2
  image:
    repository: controller
    pullPolicy: IfNotPresent
  args:
    - --mode=repo-server
    - --ui-bind-address=:8082
    - --health-probe-bind-address=:8081
  resources:
    limits:
      cpu: 1000m
      memory: 2Gi
    requests:
      cpu: 250m
      memory: 512Mi
  service:
    type: ClusterIP
    port: 8082
  hpa:
    enabled: false
    minReplicas: 2
    maxReplicas: 5
```

- [ ] **Step 2: Create `charts/chart/templates/manager/statefulset.yaml`**

Render only when `manager.sharding.enabled` is true. Mirror `manager.yaml` but:
- Use `kind: StatefulSet`
- Set `serviceName: {{ .Values.manager.sharding.serviceName }}`
- Set `replicas: {{ .Values.manager.sharding.replicas }}`
- Add env vars:

```yaml
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: PAPRIKA_SHARD_TOTAL
          value: {{ .Values.manager.sharding.replicas | quote }}
        - name: PAPRIKA_SHARD_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
```

- Add `--leader-elect` flag.

- [ ] **Step 3: Create repo-server templates**

`repo-server/deployment.yaml`, `service.yaml`, `hpa.yaml` similar to `api-server/`.

- [ ] **Step 4: Modify `manager.yaml`** to skip rendering when `manager.sharding.enabled`:

```yaml
{{- if and (or (not (hasKey .Values.manager "enabled")) (.Values.manager.enabled)) (not .Values.manager.sharding.enabled) }}
```

- [ ] **Step 5: Add repo-server address env to controllers**

In `manager.yaml` and `statefulset.yaml`, when `repoServer.enabled`:

```yaml
        - name: PAPRIKA_REPO_SERVER_ADDR
          value: http://{{ include "paprika.resourceName" (dict "suffix" "repo-server" "context" .) }}.{{ .Release.Namespace }}.svc.cluster.local:{{ .Values.repoServer.service.port }}
```

- [ ] **Step 6: Render and validate**

```bash
helm template paprika ./charts/chart --set manager.sharding.enabled=true --set repoServer.enabled=true | grep -E "(StatefulSet|Deployment|Service)" | head -20
```

- [ ] **Step 7: Commit**

---

## Chunk 5: Controller Integration with Repo Server Client

**Files:**
- Modify: `internal/controller/pipelines/application_controller.go`
- Modify: `internal/controller/pipelines/release_controller.go`
- Create: `internal/reposerver/client/client.go`

### Task 5.1: Create repo server client

- [ ] **Step 1: Create `internal/reposerver/client/client.go`**

```go
package client

import (
	"context"
	"fmt"
	"os"
)

// Client calls a repo server. This is a local stub until the connect service is fully wired.
type Client struct {
	addr string
}

// NewFromEnv creates a client from PAPRIKA_REPO_SERVER_ADDR. Returns nil if unset.
func NewFromEnv() *Client {
	addr := os.Getenv("PAPRIKA_REPO_SERVER_ADDR")
	if addr == "" {
		return nil
	}
	return &Client{addr: addr}
}

// Enabled returns true if a repo server is configured.
func (c *Client) Enabled() bool { return c != nil }

// ResolveSource is a placeholder returning an error until gRPC is implemented.
func (c *Client) ResolveSource(ctx context.Context) error {
	if c == nil {
		return nil
	}
	return fmt.Errorf("repo server client not yet implemented: %s", c.addr)
}
```

- [ ] **Step 2: Wire client into controllers**

Add `RepoClient` field to `ApplicationReconciler` and `ReleaseReconciler`. In `cmd/main.go`, create client and pass to controllers when env var is set.

- [ ] **Step 3: Run tests**

```bash
make test
```

- [ ] **Step 4: Commit**

---

## Chunk 6: Final Verification

- [ ] **Step 1: Run full test suite**

```bash
make test
```

- [ ] **Step 2: Run linter**

```bash
make lint
```

- [ ] **Step 3: Validate Helm templates**

```bash
helm template paprika ./charts/chart --set manager.sharding.enabled=true --set repoServer.enabled=true > /tmp/paprika-shard.yaml
helm template paprika ./charts/chart > /tmp/paprika-default.yaml
```

- [ ] **Step 4: Commit and finish**
