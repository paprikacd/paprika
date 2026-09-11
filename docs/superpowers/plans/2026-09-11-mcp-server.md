# Paprika MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Paprika's fleet API to MCP clients over OAuth 2.1, so an agent can answer operational questions and — under explicit scope and human confirmation — act on them.

**Architecture:** An MCP server embedded in `--mode=api`, mounted on its own listener. Tool calls re-enter the existing Connect handler through an in-memory `http.RoundTripper`, so project authorization, audit, and tracing are inherited from the existing interceptor chain rather than reimplemented. Tool scope is declared explicitly per tool, never derived from `classifyAudit`.

**Tech Stack:** Go 1.26, Connect (`connectrpc.com/connect`), `github.com/modelcontextprotocol/go-sdk`, testify, Redis via `internal/cache`.

**Spec:** `docs/superpowers/specs/2026-09-11-mcp-server-design.md` — read it alongside this plan; the spec argues *why*, this plan says *how*.

## Global Constraints

- Go 1.26.0, toolchain go1.26.4. Do not raise either.
- Unit tests use `stretchr/testify` (`assert`/`require`). Ginkgo is reserved for e2e; do not introduce it here.
- All new code lives in `internal/api/mcp/` except explicitly-listed edits to `internal/api/auth/`, `internal/api/audit_middleware.go`, and `cmd/main.go`.
- Tool scope MUST be a declared field. Deriving write-ness from `classifyAudit` or `auditVerbs` is prohibited — see spec, Context.
- `--mcp-enabled` defaults to `false`.
- Existing exported signatures in `internal/api/auth` must keep working; the console and CLI depend on them. Add new functions rather than changing old ones.
- Scope strings are exactly `paprika:read` and `paprika:write`.
- Audience strings are exactly `paprika-mcp` and `paprika-api`.

---

## Phase 0 — Audit fix (independently shippable)

This phase stands alone. It fixes a live defect and can merge to `master` without any other phase.

### Task 1: Audit the six unaudited mutating RPCs

**Files:**
- Modify: `internal/api/audit_middleware.go:18-27`
- Test: `internal/api/audit_middleware_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `classifyAudit(procedure string) (action, resource string, mutating bool)` now returns `mutating=true` for `Cancel*`, `Hold*`, `Ignore*`, `Resume*`, `Retry*`, `Skip*`.

- [ ] **Step 1: Write failing test**

```go
func TestClassifyAuditCoversAllMutatingVerbs(t *testing.T) {
	cases := map[string]string{
		"/paprika.v1.PaprikaService/CancelPipeline":     "cancel",
		"/paprika.v1.PaprikaService/HoldRollout":        "hold",
		"/paprika.v1.PaprikaService/IgnoreDriftedField": "ignore",
		"/paprika.v1.PaprikaService/ResumeRollout":      "resume",
		"/paprika.v1.PaprikaService/RetryStep":          "retry",
		"/paprika.v1.PaprikaService/SkipStep":           "skip",
	}
	for procedure, wantAction := range cases {
		t.Run(procedure, func(t *testing.T) {
			action, resource, mutating := classifyAudit(procedure)
			require.True(t, mutating, "must be classified as mutating")
			assert.Equal(t, wantAction, action)
			assert.NotEmpty(t, resource)
		})
	}
}

func TestClassifyAuditLeavesReadsAlone(t *testing.T) {
	for _, procedure := range []string{
		"/paprika.v1.PaprikaService/ListClusters",
		"/paprika.v1.PaprikaService/GetSystemStatus",
		"/paprika.v1.PaprikaService/QueryFleetMap",
	} {
		_, _, mutating := classifyAudit(procedure)
		assert.False(t, mutating, procedure)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/ -run TestClassifyAudit -v`
Expected: FAIL — `CancelPipeline` etc. return `mutating=false`.

- [ ] **Step 3: Write minimal implementation**

In `internal/api/audit_middleware.go`, extend the map:

```go
var auditVerbs = map[string]string{
	"Sync":     "update",
	"Apply":    "apply",
	"Approve":  "approve",
	"Reject":   "reject",
	"Rollback": "update",
	"Promote":  "promote",
	"Abort":    "update",
	"Cancel":   "cancel",
	"Hold":     "hold",
	"Ignore":   "ignore",
	"Resume":   "resume",
	"Retry":    "retry",
	"Skip":     "skip",
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/ -run TestClassifyAudit -v`
Expected: PASS

- [ ] **Step 5: Run the full package to check for regressions**

Run: `go test ./internal/api/...`
Expected: PASS. The `Action` field is free-form (`internal/audit/audit.go:23` documents a set but does not enforce it), so new verbs need no change in `internal/audit`.

- [ ] **Step 6: Commit**

```bash
git add internal/api/audit_middleware.go internal/api/audit_middleware_test.go
git commit -m "fix(audit): record the six mutating RPCs that bypassed the audit trail"
```

### Task 2: Proto-driven guard against future audit gaps

**Files:**
- Create: `internal/api/audit_coverage_test.go`

**Interfaces:**
- Consumes: `classifyAudit` from Task 1.
- Produces: nothing consumed by later tasks; a standing guard.

- [ ] **Step 1: Write the test**

Prefix matching is fragile — a future `PauseRollout` would silently fall through. This test forces a decision.

```go
// knownReadOnlyRPCs lists every RPC deliberately treated as non-mutating.
// Adding an RPC to api.proto without adding it here (or giving it a
// mutating verb prefix) fails this test on purpose.
var knownReadOnlyRPCs = map[string]bool{
	"GetAnalysisRun": true, "GetApplication": true, "GetApplicationLifecycle": true,
	"GetApplicationOwnership": true, "GetApplicationSet": true, "GetArtifact": true,
	"GetCluster": true, "GetDataSources": true, "GetPipeline": true,
	"GetPipelineRun": true, "GetResource": true, "GetResourceLogs": true,
	"GetResourceTree": true, "GetResourceTreeDetailed": true, "GetRevisionInfo": true,
	"GetRollout": true, "GetRolloutHold": true, "GetStepLogs": true,
	"GetSystemStatus": true, "Investigate": true, "ListAnalysisRuns": true,
	"ListApplications": true, "ListApplicationSets": true, "ListArtifacts": true,
	"ListClusters": true, "ListDriftDetails": true, "ListGateStatus": true,
	"ListInvestigatorPlugins": true, "ListNotificationConfigs": true,
	"ListPipelineRuns": true, "ListPipelines": true, "ListPolicies": true,
	"ListReleases": true, "ListRolloutHistory": true, "ListRollouts": true,
	"ListSourceEvents": true, "ListStages": true, "QueryApplications": true,
	"QueryApplicationSignals": true, "QueryCost": true, "QueryFleetMap": true,
	"QueryFleetMatrix": true, "Render": true, "ResolveSource": true,
	"StreamResourceLogs": true,
}

func TestEveryProtoRPCIsClassified(t *testing.T) {
	data, err := os.ReadFile("../../proto/paprika/v1/api.proto")
	require.NoError(t, err)

	re := regexp.MustCompile(`(?m)^\s+rpc\s+([A-Za-z]+)\s*\(`)
	matches := re.FindAllStringSubmatch(string(data), -1)
	require.NotEmpty(t, matches, "no RPCs parsed from api.proto")

	for _, m := range matches {
		name := m[1]
		t.Run(name, func(t *testing.T) {
			_, _, mutating := classifyAudit("/paprika.v1.PaprikaService/" + name)
			if mutating {
				assert.False(t, knownReadOnlyRPCs[name],
					"%s is classified mutating but listed as read-only", name)
				return
			}
			assert.True(t, knownReadOnlyRPCs[name],
				"%s is unclassified: give it a mutating verb prefix in auditVerbs, "+
					"or add it to knownReadOnlyRPCs with justification", name)
		})
	}
}
```

- [ ] **Step 2: Run the test**

Run: `go test ./internal/api/ -run TestEveryProtoRPCIsClassified -v`
Expected: PASS (45 read subtests matched against the list, 15 mutating).

- [ ] **Step 3: Verify the guard actually bites**

Temporarily delete `"Cancel": "cancel"` from `auditVerbs`, re-run, confirm FAIL naming `CancelPipeline`, then restore it. A guard never seen failing is not known to work.

Run: `go test ./internal/api/ -run TestEveryProtoRPCIsClassified`
Expected: FAIL before restore, PASS after.

- [ ] **Step 4: Commit**

```bash
git add internal/api/audit_coverage_test.go
git commit -m "test(audit): fail the build when a new RPC is left unclassified"
```

---

## Phase 1 — Foundation

### Task 3: In-memory Connect transport (retire the main technical risk first)

**Files:**
- Create: `internal/api/mcp/transport.go`
- Test: `internal/api/mcp/transport_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `func NewInProcessTransport(h http.Handler) http.RoundTripper`. Later tasks build a `v1connect.PaprikaServiceClient` over it via `connect.NewClient`-style construction with `&http.Client{Transport: NewInProcessTransport(connectHandler)}`.

The spec names this the risk to retire first: the transport must preserve Connect's error codes and trailer handling identically to a network transport. If this task shows it does not, stop and switch to a loopback listener before continuing.

- [ ] **Step 1: Write failing test**

```go
// stubService implements just enough of the handler surface to exercise
// success and error paths through the transport.
type stubService struct {
	v1connect.UnimplementedPaprikaServiceHandler
	err error
}

func (s *stubService) GetSystemStatus(
	ctx context.Context, req *connect.Request[v1.GetSystemStatusRequest],
) (*connect.Response[v1.GetSystemStatusResponse], error) {
	if s.err != nil {
		return nil, s.err
	}
	return connect.NewResponse(&v1.GetSystemStatusResponse{}), nil
}

func newTestClient(t *testing.T, svc v1connect.PaprikaServiceHandler) v1connect.PaprikaServiceClient {
	t.Helper()
	_, handler := v1connect.NewPaprikaServiceHandler(svc)
	return v1connect.NewPaprikaServiceClient(
		&http.Client{Transport: NewInProcessTransport(handler)},
		"http://in-process",
	)
}

func TestInProcessTransportRoundTripsSuccess(t *testing.T) {
	client := newTestClient(t, &stubService{})
	resp, err := client.GetSystemStatus(context.Background(),
		connect.NewRequest(&v1.GetSystemStatusRequest{}))
	require.NoError(t, err)
	require.NotNil(t, resp.Msg)
}

func TestInProcessTransportPreservesConnectErrorCodes(t *testing.T) {
	for _, code := range []connect.Code{
		connect.CodePermissionDenied,
		connect.CodeUnauthenticated,
		connect.CodeNotFound,
		connect.CodeInvalidArgument,
	} {
		t.Run(code.String(), func(t *testing.T) {
			client := newTestClient(t, &stubService{
				err: connect.NewError(code, errors.New("boom")),
			})
			_, err := client.GetSystemStatus(context.Background(),
				connect.NewRequest(&v1.GetSystemStatusRequest{}))
			require.Error(t, err)
			assert.Equal(t, code, connect.CodeOf(err),
				"transport must not flatten Connect codes")
		})
	}
}

func TestInProcessTransportPropagatesHeaders(t *testing.T) {
	var got string
	svc := &stubService{}
	_, handler := v1connect.NewPaprikaServiceHandler(svc,
		connect.WithInterceptors(connect.UnaryInterceptorFunc(
			func(next connect.UnaryFunc) connect.UnaryFunc {
				return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
					got = req.Header().Get("Authorization")
					return next(ctx, req)
				}
			})))
	client := v1connect.NewPaprikaServiceClient(
		&http.Client{Transport: NewInProcessTransport(handler)}, "http://in-process")

	req := connect.NewRequest(&v1.GetSystemStatusRequest{})
	req.Header().Set("Authorization", "Bearer token-abc")
	_, err := client.GetSystemStatus(context.Background(), req)
	require.NoError(t, err)
	assert.Equal(t, "Bearer token-abc", got,
		"Authorization must reach the interceptor chain")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/mcp/ -run TestInProcessTransport -v`
Expected: FAIL — `NewInProcessTransport` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
// Package mcp serves Paprika's fleet API to MCP clients.
package mcp

import (
	"net/http"
	"net/http/httptest"
)

// inProcessTransport dispatches requests directly into an http.Handler with no
// socket. Connect's HTTP semantics — status codes, headers, and trailers — are
// preserved because httptest.ResponseRecorder captures all three, which is what
// lets error codes survive the round trip.
type inProcessTransport struct {
	handler http.Handler
}

// NewInProcessTransport returns a RoundTripper that serves requests from h.
func NewInProcessTransport(h http.Handler) http.RoundTripper {
	return &inProcessTransport{handler: h}
}

func (t *inProcessTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	rec := httptest.NewRecorder()
	t.handler.ServeHTTP(rec, req)

	resp := rec.Result()
	resp.Request = req
	return resp, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/mcp/ -run TestInProcessTransport -v`
Expected: PASS on all three tests.

**If `TestInProcessTransportPreservesConnectErrorCodes` fails**, the transport is not viable as written. Do not paper over it. Record the failure in the task notes and switch to the spec's documented fallback: a `net.Listener` on `127.0.0.1:0` fronting the same handler, with the client pointed at its URL. Security properties are identical; only latency changes.

- [ ] **Step 5: Commit**

```bash
git add internal/api/mcp/transport.go internal/api/mcp/transport_test.go
git commit -m "feat(mcp): add in-process Connect transport preserving error codes"
```

### Task 4: Scope type and parsing

**Files:**
- Create: `internal/api/mcp/scope.go`
- Test: `internal/api/mcp/scope_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Scope string`; constants `ScopeRead Scope = "paprika:read"` and `ScopeWrite Scope = "paprika:write"`; `func ParseScopes(raw string) []Scope`; `func HasScope(granted []Scope, required Scope) bool`.

- [ ] **Step 1: Write failing test**

```go
func TestParseScopes(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want []Scope
	}{
		{"empty", "", nil},
		{"single", "paprika:read", []Scope{ScopeRead}},
		{"both", "paprika:read paprika:write", []Scope{ScopeRead, ScopeWrite}},
		{"extra whitespace", "  paprika:read   paprika:write ", []Scope{ScopeRead, ScopeWrite}},
		{"unknown dropped", "paprika:read openid profile", []Scope{ScopeRead}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, ParseScopes(tt.raw))
		})
	}
}

func TestHasScopeDoesNotImplyWriteFromRead(t *testing.T) {
	granted := []Scope{ScopeRead}
	assert.True(t, HasScope(granted, ScopeRead))
	assert.False(t, HasScope(granted, ScopeWrite),
		"read must never imply write")
}

func TestHasScopeWriteDoesNotImplyRead(t *testing.T) {
	granted := []Scope{ScopeWrite}
	assert.False(t, HasScope(granted, ScopeRead),
		"scopes are explicit; write does not grant read")
}

func TestHasScopeEmptyGrantsNothing(t *testing.T) {
	assert.False(t, HasScope(nil, ScopeRead))
	assert.False(t, HasScope(nil, ScopeWrite))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/mcp/ -run TestParseScopes -v`
Expected: FAIL — undefined `ParseScopes`.

- [ ] **Step 3: Write minimal implementation**

```go
package mcp

import "strings"

// Scope is an OAuth scope value governing what a credential may do. It is
// deliberately independent of the Authorizer, which governs what a human may
// do; both gates must pass.
type Scope string

const (
	ScopeRead  Scope = "paprika:read"
	ScopeWrite Scope = "paprika:write"
)

// ParseScopes splits a space-delimited scope claim (RFC 6749 section 3.3) and
// drops values Paprika does not define, so an unrecognised scope can never
// widen access.
func ParseScopes(raw string) []Scope {
	var out []Scope
	for _, field := range strings.Fields(raw) {
		switch Scope(field) {
		case ScopeRead:
			out = append(out, ScopeRead)
		case ScopeWrite:
			out = append(out, ScopeWrite)
		}
	}
	return out
}

// HasScope reports whether required is present in granted. There is no
// hierarchy: write does not imply read, and read never implies write.
func HasScope(granted []Scope, required Scope) bool {
	for _, s := range granted {
		if s == required {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/mcp/ -run 'TestParseScopes|TestHasScope' -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/api/mcp/scope.go internal/api/mcp/scope_test.go
git commit -m "feat(mcp): add explicit scope type with no read/write implication"
```

### Task 5: Tool registry

**Files:**
- Create: `internal/api/mcp/registry.go`
- Test: `internal/api/mcp/registry_test.go`

**Interfaces:**
- Consumes: `Scope` (Task 4).
- Produces:

```go
type InvokeFunc func(ctx context.Context, client v1connect.PaprikaServiceClient, args json.RawMessage) (any, error)

type Tool struct {
	Name        string
	Description string
	Scope       Scope
	Destructive bool
	InputSchema json.RawMessage
	Invoke      InvokeFunc
}

func NewRegistry() *Registry
func (r *Registry) Register(t Tool) error
func (r *Registry) Lookup(name string) (Tool, bool)
func (r *Registry) All() []Tool
```

- [ ] **Step 1: Write failing test**

```go
func validTool() Tool {
	return Tool{
		Name:        "fleet_status",
		Description: "Summarise fleet health.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{"type":"object"}`),
		Invoke: func(context.Context, v1connect.PaprikaServiceClient, json.RawMessage) (any, error) {
			return nil, nil
		},
	}
}

func TestRegisterRejectsMissingScope(t *testing.T) {
	tool := validTool()
	tool.Scope = ""
	err := NewRegistry().Register(tool)
	require.Error(t, err, "scope must be declared explicitly, never inferred")
	assert.Contains(t, err.Error(), "scope")
}

func TestRegisterRejectsDuplicateName(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, r.Register(validTool()))
	assert.Error(t, r.Register(validTool()))
}

func TestRegisterRejectsMissingInvoke(t *testing.T) {
	tool := validTool()
	tool.Invoke = nil
	assert.Error(t, NewRegistry().Register(tool))
}

func TestRegisterRejectsDestructiveRead(t *testing.T) {
	tool := validTool()
	tool.Destructive = true
	err := NewRegistry().Register(tool)
	require.Error(t, err, "a read tool cannot be destructive")
}

func TestLookupAndAll(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, r.Register(validTool()))

	got, ok := r.Lookup("fleet_status")
	require.True(t, ok)
	assert.Equal(t, ScopeRead, got.Scope)

	_, ok = r.Lookup("nope")
	assert.False(t, ok)
	assert.Len(t, r.All(), 1)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/mcp/ -run 'TestRegister|TestLookup' -v`
Expected: FAIL — undefined `NewRegistry`.

- [ ] **Step 3: Write minimal implementation**

```go
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// InvokeFunc executes a tool by calling the Connect API. Implementations hold
// no authorization logic: the interceptor chain behind client enforces it.
type InvokeFunc func(ctx context.Context, client v1connect.PaprikaServiceClient, args json.RawMessage) (any, error)

// Tool is one MCP tool. Scope is a required field and is never derived from
// the procedure name — see the spec's Context section for why that derivation
// is unsafe.
type Tool struct {
	Name        string
	Description string
	Scope       Scope
	Destructive bool
	InputSchema json.RawMessage
	Invoke      InvokeFunc
}

// Registry holds the tools exposed over MCP.
type Registry struct {
	tools map[string]Tool
}

func NewRegistry() *Registry {
	return &Registry{tools: make(map[string]Tool)}
}

func (r *Registry) Register(t Tool) error {
	switch {
	case t.Name == "":
		return fmt.Errorf("tool name is required")
	case t.Scope != ScopeRead && t.Scope != ScopeWrite:
		return fmt.Errorf("tool %q: scope must be %q or %q", t.Name, ScopeRead, ScopeWrite)
	case t.Invoke == nil:
		return fmt.Errorf("tool %q: Invoke is required", t.Name)
	case t.Destructive && t.Scope != ScopeWrite:
		return fmt.Errorf("tool %q: destructive tools must have scope %q", t.Name, ScopeWrite)
	case len(t.InputSchema) == 0:
		return fmt.Errorf("tool %q: InputSchema is required", t.Name)
	}
	if _, exists := r.tools[t.Name]; exists {
		return fmt.Errorf("tool %q already registered", t.Name)
	}
	r.tools[t.Name] = t
	return nil
}

func (r *Registry) Lookup(name string) (Tool, bool) {
	t, ok := r.tools[name]
	return t, ok
}

// All returns tools sorted by name so listings are stable across calls.
func (r *Registry) All() []Tool {
	out := make([]Tool, 0, len(r.tools))
	for _, t := range r.tools {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/mcp/ -run 'TestRegister|TestLookup' -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/api/mcp/registry.go internal/api/mcp/registry_test.go
git commit -m "feat(mcp): add tool registry requiring explicit scope declaration"
```

---

## Phase 2 — Token and scope model

### Task 6: Audience and scope claims on self-signed tokens

**Files:**
- Modify: `internal/api/auth/self_signed_token.go`
- Modify: `internal/api/auth/principal.go`
- Test: `internal/api/auth/self_signed_token_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:

```go
type TokenOptions struct {
	Subject, Email, Name string
	Audience             string
	Scope                string
	TTL                  time.Duration
	Secret               []byte
}
func IssueTokenWithOptions(opts TokenOptions) (string, error)
func NewSelfSignedAuthenticatorForAudience(secret []byte, audience string) *SelfSignedAuthenticator
```

`Principal` gains `Scopes []string`. `IssueToken` and `NewSelfSignedAuthenticator` keep their existing signatures and behaviour — the console and CLI call them.

- [ ] **Step 1: Write failing test**

```go
func TestIssueTokenWithOptionsEmbedsAudienceAndScope(t *testing.T) {
	secret := []byte("test-secret-value")
	token, err := IssueTokenWithOptions(TokenOptions{
		Subject: "user-1", Email: "a@b.c", Name: "A",
		Audience: "paprika-mcp", Scope: "paprika:read",
		TTL: time.Hour, Secret: secret,
	})
	require.NoError(t, err)

	auth := NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp")
	p, err := auth.Authenticate(ctxWithBearer(token))
	require.NoError(t, err)
	assert.Equal(t, "user-1", p.Subject)
	assert.Equal(t, []string{"paprika:read"}, p.Scopes)
}

func TestAudienceMismatchIsRejected(t *testing.T) {
	secret := []byte("test-secret-value")
	token, err := IssueTokenWithOptions(TokenOptions{
		Subject: "user-1", Audience: "paprika-api",
		Scope: "paprika:read", TTL: time.Hour, Secret: secret,
	})
	require.NoError(t, err)

	auth := NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp")
	_, err = auth.Authenticate(ctxWithBearer(token))
	require.Error(t, err, "a console token must not be replayable against MCP")
}

func TestLegacyAudlessTokenRejectedByAudienceAuthenticator(t *testing.T) {
	secret := []byte("test-secret-value")
	legacy, err := IssueToken("user-1", "a@b.c", "A", secret) // no aud
	require.NoError(t, err)

	auth := NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp")
	_, err = auth.Authenticate(ctxWithBearer(legacy))
	require.Error(t, err, "MCP validates aud strictly during migration")
}

func TestLegacyAudlessTokenStillAcceptedByExistingAuthenticator(t *testing.T) {
	secret := []byte("test-secret-value")
	legacy, err := IssueToken("user-1", "a@b.c", "A", secret)
	require.NoError(t, err)

	p, err := NewSelfSignedAuthenticator(secret).Authenticate(ctxWithBearer(legacy))
	require.NoError(t, err, "console and CLI tokens must keep working")
	assert.Equal(t, "user-1", p.Subject)
}
```

Add the helper if the package lacks one:

```go
func ctxWithBearer(token string) context.Context {
	return WithRequestHeader(context.Background(), "Authorization", "Bearer "+token)
}
```

Check `internal/api/auth/request.go` first — it already carries request headers into context; reuse its existing helper rather than adding a second mechanism.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/auth/ -run 'TestIssueTokenWithOptions|TestAudience|TestLegacy' -v`
Expected: FAIL — undefined `IssueTokenWithOptions`.

- [ ] **Step 3: Write minimal implementation**

Extend the claims struct with `omitempty` on the new fields so legacy tokens stay byte-identical:

```go
type selfSignedClaims struct {
	Subject  string `json:"sub"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	Issuer   string `json:"iss,omitempty"`
	Audience string `json:"aud,omitempty"`
	Scope    string `json:"scope,omitempty"`
	IAT      int64  `json:"iat"`
	Exp      int64  `json:"exp"`
}

type TokenOptions struct {
	Subject, Email, Name string
	Audience             string
	Scope                string
	TTL                  time.Duration
	Secret               []byte
}

// IssueTokenWithOptions mints an audience-bound, scoped token.
func IssueTokenWithOptions(opts TokenOptions) (string, error) {
	ttl := opts.TTL
	if ttl == 0 {
		ttl = tokenExpiry
	}
	now := time.Now()
	return encodeClaims(selfSignedClaims{
		Subject:  opts.Subject,
		Email:    opts.Email,
		Name:     opts.Name,
		Audience: opts.Audience,
		Scope:    opts.Scope,
		IAT:      now.Unix(),
		Exp:      now.Add(ttl).Unix(),
	}, opts.Secret)
}
```

Refactor the existing `IssueToken` body into `encodeClaims(claims, secret)` and have `IssueToken` delegate, so there is one signing path.

Add the audience field and check:

```go
type SelfSignedAuthenticator struct {
	secret   []byte
	audience string // when non-empty, aud must match exactly
}

// NewSelfSignedAuthenticatorForAudience requires an exact aud match. An empty
// aud (a legacy token) is rejected, which is what stops console tokens being
// replayed against MCP during the 24h migration window.
func NewSelfSignedAuthenticatorForAudience(secret []byte, audience string) *SelfSignedAuthenticator {
	return &SelfSignedAuthenticator{secret: secret, audience: audience}
}
```

In `Authenticate`, after `verifySelfSigned` succeeds:

```go
if s.audience != "" && claims.Audience != s.audience {
	return nil, fmt.Errorf("%w: audience mismatch", ErrUnauthenticated)
}
```

and populate the principal:

```go
principal.Scopes = strings.Fields(claims.Scope)
```

In `internal/api/auth/principal.go`, add the field:

```go
type Principal struct {
	Subject string
	Email   string
	Name    string
	Groups  []string
	Scopes  []string
	Claims  map[string]interface{}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/auth/ -v`
Expected: PASS, including pre-existing tests — the `omitempty` tags keep legacy tokens unchanged.

- [ ] **Step 5: Commit**

```bash
git add internal/api/auth/self_signed_token.go internal/api/auth/principal.go internal/api/auth/self_signed_token_test.go
git commit -m "feat(auth): add audience-bound, scoped self-signed tokens"
```

### Task 7: Single-use confirmation tokens

**Files:**
- Create: `internal/api/mcp/confirm.go`
- Test: `internal/api/mcp/confirm_test.go`

**Interfaces:**
- Consumes: `*cache.Cache` from `internal/cache` (methods `Get(ctx, key) ([]byte, error)`, `Set(ctx, key, value []byte, ttl time.Duration) error`, `Delete(ctx, key) error`).
- Produces:

```go
func NewConfirmer(c *cache.Cache, ttl time.Duration) *Confirmer
func (c *Confirmer) Issue(ctx context.Context, principal, tool string, args json.RawMessage) (string, error)
func (c *Confirmer) Consume(ctx context.Context, token, principal, tool string, args json.RawMessage) error
var ErrConfirmInvalid, ErrConfirmUsed, ErrConfirmMismatch error
```

- [ ] **Step 1: Write failing test**

```go
func newConfirmer(t *testing.T, ttl time.Duration) *Confirmer {
	t.Helper()
	c, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	return NewConfirmer(c, ttl)
}

func TestConfirmRoundTrip(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	args := json.RawMessage(`{"name":"web","namespace":"prod"}`)

	token, err := c.Issue(context.Background(), "user-1", "rollback_release", args)
	require.NoError(t, err)
	require.NotEmpty(t, token)

	require.NoError(t, c.Consume(context.Background(), token, "user-1", "rollback_release", args))
}

func TestConfirmIsSingleUse(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	args := json.RawMessage(`{"name":"web"}`)
	token, err := c.Issue(context.Background(), "user-1", "rollback_release", args)
	require.NoError(t, err)

	require.NoError(t, c.Consume(context.Background(), token, "user-1", "rollback_release", args))
	err = c.Consume(context.Background(), token, "user-1", "rollback_release", args)
	assert.ErrorIs(t, err, ErrConfirmUsed)
}

func TestConfirmRejectsDifferentArguments(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	token, err := c.Issue(context.Background(), "user-1", "rollback_release",
		json.RawMessage(`{"name":"staging"}`))
	require.NoError(t, err)

	err = c.Consume(context.Background(), token, "user-1", "rollback_release",
		json.RawMessage(`{"name":"prod"}`))
	assert.ErrorIs(t, err, ErrConfirmMismatch,
		"confirmation for one target must not authorise another")
}

func TestConfirmRejectsDifferentPrincipal(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	args := json.RawMessage(`{"name":"web"}`)
	token, err := c.Issue(context.Background(), "user-1", "rollback_release", args)
	require.NoError(t, err)

	err = c.Consume(context.Background(), token, "user-2", "rollback_release", args)
	assert.ErrorIs(t, err, ErrConfirmMismatch)
}

func TestConfirmRejectsDifferentTool(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	args := json.RawMessage(`{"name":"web"}`)
	token, err := c.Issue(context.Background(), "user-1", "rollback_release", args)
	require.NoError(t, err)

	err = c.Consume(context.Background(), token, "user-1", "abort_rollout", args)
	assert.ErrorIs(t, err, ErrConfirmMismatch)
}

func TestConfirmUnknownTokenIsInvalid(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	err := c.Consume(context.Background(), "nonexistent", "user-1", "rollback_release",
		json.RawMessage(`{}`))
	assert.ErrorIs(t, err, ErrConfirmInvalid)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/mcp/ -run TestConfirm -v`
Expected: FAIL — undefined `NewConfirmer`.

- [ ] **Step 3: Write minimal implementation**

```go
package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/benebsworth/paprika/internal/cache"
)

var (
	// ErrConfirmInvalid also covers expiry: the cache TTL removes the key, so an
	// expired token is indistinguishable from one that never existed. There is
	// deliberately no separate ErrConfirmExpired — it could never be returned.
	ErrConfirmInvalid  = errors.New("confirmation token not found or expired")
	ErrConfirmUsed     = errors.New("confirmation token already used")
	ErrConfirmMismatch = errors.New("confirmation token does not match this request")
)

// Confirmer issues single-use tokens binding a destructive tool call to a
// principal and an exact argument set, so a confirmation obtained for one
// action cannot be replayed against another.
type Confirmer struct {
	cache *cache.Cache
	ttl   time.Duration
}

func NewConfirmer(c *cache.Cache, ttl time.Duration) *Confirmer {
	return &Confirmer{cache: c, ttl: ttl}
}

type confirmRecord struct {
	Principal string `json:"principal"`
	Tool      string `json:"tool"`
	ArgsHash  string `json:"argsHash"`
}

func argsHash(args json.RawMessage) string {
	sum := sha256.Sum256(args)
	return hex.EncodeToString(sum[:])
}

func (c *Confirmer) key(token string) string {
	return "mcp:confirm:" + token
}

func (c *Confirmer) Issue(ctx context.Context, principal, tool string, args json.RawMessage) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate confirmation token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	payload, err := json.Marshal(confirmRecord{
		Principal: principal, Tool: tool, ArgsHash: argsHash(args),
	})
	if err != nil {
		return "", fmt.Errorf("marshal confirmation record: %w", err)
	}
	// The cache TTL is what expires the token; there is no separate clock.
	if err := c.cache.Set(ctx, c.key(token), payload, c.ttl); err != nil {
		return "", fmt.Errorf("store confirmation token: %w", err)
	}
	return token, nil
}

// Consume validates and atomically retires a token. It deletes before
// validating the binding so that a mismatched attempt still burns the token —
// a caller must not get to probe arguments against a live confirmation.
func (c *Confirmer) Consume(ctx context.Context, token, principal, tool string, args json.RawMessage) error {
	payload, err := c.cache.Get(ctx, c.key(token))
	if err != nil || len(payload) == 0 {
		return ErrConfirmInvalid
	}
	if delErr := c.cache.Delete(ctx, c.key(token)); delErr != nil {
		return fmt.Errorf("retire confirmation token: %w", delErr)
	}

	var rec confirmRecord
	if err := json.Unmarshal(payload, &rec); err != nil {
		return ErrConfirmInvalid
	}
	if rec.Principal != principal || rec.Tool != tool {
		return ErrConfirmMismatch
	}
	if subtle.ConstantTimeCompare([]byte(rec.ArgsHash), []byte(argsHash(args))) != 1 {
		return ErrConfirmMismatch
	}
	return nil
}
```

Note on `ErrConfirmUsed`: a consumed token is deleted, so a second use returns `ErrConfirmInvalid` from the cache lookup. Make `TestConfirmIsSingleUse` pass by defining `ErrConfirmUsed` as a wrapper the second lookup returns — simplest correct approach is to store a short-lived tombstone on delete:

```go
// after successful delete, write a tombstone for the remaining TTL so a replay
// is reported as "already used" rather than the vaguer "not found"
_ = c.cache.Set(ctx, c.key(token)+":used", []byte("1"), c.ttl)
```

and check it at the top of `Consume`:

```go
if used, _ := c.cache.Get(ctx, c.key(token)+":used"); len(used) > 0 {
	return ErrConfirmUsed
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/mcp/ -run TestConfirm -v`
Expected: PASS on all six.

- [ ] **Step 5: Commit**

```bash
git add internal/api/mcp/confirm.go internal/api/mcp/confirm_test.go
git commit -m "feat(mcp): add argument-bound single-use confirmation tokens"
```

---

## Phase 3 — Read tools

### Task 8: Tool invocation with scope enforcement

**Files:**
- Create: `internal/api/mcp/invoke.go`
- Test: `internal/api/mcp/invoke_test.go`

**Interfaces:**
- Consumes: `Registry`, `Tool`, `Scope`, `HasScope` (Tasks 4–5); `Confirmer` (Task 7); `auth.Principal` (Task 6).
- Produces:

```go
type Invoker struct {
	registry  *Registry
	client    v1connect.PaprikaServiceClient
	confirmer *Confirmer
	auditor   audit.Auditor
}

func NewInvoker(r *Registry, client v1connect.PaprikaServiceClient, conf *Confirmer, aud audit.Auditor) *Invoker
func (i *Invoker) Call(ctx context.Context, p *auth.Principal, name string, args json.RawMessage) (any, error)

var (
	ErrToolNotFound = errors.New("tool not found")
	ErrScopeDenied  = errors.New("tool requires a scope this credential lacks")
)

// ConfirmationRequiredError is returned instead of executing a destructive
// tool on first call. It is a struct rather than a sentinel because it carries
// the preview and token the handler renders back to the model.
type ConfirmationRequiredError struct {
	Tool    string
	Token   string
	Preview string
}

func (e *ConfirmationRequiredError) Error() string
```

- [ ] **Step 1: Write failing test**

```go
func TestCallDeniesWriteToolWithReadScope(t *testing.T) {
	inv, _ := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeRead)}}

	_, err := inv.Call(context.Background(), p, "sync_application",
		json.RawMessage(`{"name":"web","namespace":"prod"}`))
	assert.ErrorIs(t, err, ErrScopeDenied)
}

func TestCallAllowsReadToolWithReadScope(t *testing.T) {
	inv, _ := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeRead)}}

	_, err := inv.Call(context.Background(), p, "fleet_status", json.RawMessage(`{}`))
	require.NoError(t, err)
}

func TestCallDeniedWriteIsAudited(t *testing.T) {
	inv, aud := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeRead)}}

	_, _ = inv.Call(context.Background(), p, "sync_application", json.RawMessage(`{}`))

	require.Len(t, aud.events, 1, "a denied write must leave a record")
	assert.False(t, aud.events[0].Success)
	assert.Equal(t, "u1", aud.events[0].Principal)
}

func TestCallDestructiveToolRequiresConfirmation(t *testing.T) {
	inv, _ := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeWrite)}}

	_, err := inv.Call(context.Background(), p, "rollback_release",
		json.RawMessage(`{"name":"web","namespace":"prod"}`))

	var need *ConfirmationRequiredError
	require.ErrorAs(t, err, &need)
	assert.NotEmpty(t, need.Token)
	assert.NotEmpty(t, need.Preview)
}

func TestCallUnknownToolIsNotFound(t *testing.T) {
	inv, _ := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeRead)}}
	_, err := inv.Call(context.Background(), p, "no_such_tool", json.RawMessage(`{}`))
	assert.ErrorIs(t, err, ErrToolNotFound)
}
```

Shared test helpers. Put these in `internal/api/mcp/helpers_test.go` so Tasks 8, 11, and 13 all use one definition:

```go
type recordingAuditor struct{ events []audit.Event }

func (r *recordingAuditor) Record(_ context.Context, e audit.Event) {
	r.events = append(r.events, e)
}

// stubTool returns a tool whose Invoke succeeds without touching Connect, so
// invoker tests exercise gating rather than RPC behaviour.
func stubTool(name string, scope Scope, destructive bool) Tool {
	return Tool{
		Name:        name,
		Description: name,
		Scope:       scope,
		Destructive: destructive,
		InputSchema: json.RawMessage(`{"type":"object"}`),
		Invoke: func(context.Context, v1connect.PaprikaServiceClient, json.RawMessage) (any, error) {
			return map[string]string{"ok": name}, nil
		},
	}
}

// echoService answers every RPC. UnimplementedPaprikaServiceHandler returns
// CodeUnimplemented, which is fine for gating tests but not for audit tests —
// the audit interceptor records the attempt either way, which is exactly the
// behaviour under test.
type echoService struct{ v1connect.UnimplementedPaprikaServiceHandler }

// stubConnectClient returns a client wired through the REAL audit interceptor,
// so audit assertions exercise the production audit path rather than a
// reimplementation of it.
//
// The client must not be nil: the real write tools registered by
// RegisterWriteTools dereference it inside Invoke, so nil panics rather than
// failing cleanly. This is why newInvokerForRegistry cannot pass nil.
func stubConnectClient(t *testing.T, aud audit.Auditor) v1connect.PaprikaServiceClient {
	t.Helper()
	_, handler := v1connect.NewPaprikaServiceHandler(&echoService{},
		connect.WithInterceptors(api.NewAuditInterceptor(aud, nil)))
	return v1connect.NewPaprikaServiceClient(
		&http.Client{Transport: NewInProcessTransport(handler)}, "http://in-process")
}

// newInvokerForRegistry wires an invoker around an existing registry.
func newInvokerForRegistry(t *testing.T, r *Registry) (*Invoker, *recordingAuditor) {
	t.Helper()
	store, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	aud := &recordingAuditor{}
	return NewInvoker(r, stubConnectClient(t, aud), NewConfirmer(store, time.Minute), aud), aud
}
```

Import note: `internal/api/mcp` importing `internal/api` is not a cycle — `internal/api` does not import `mcp`; `cmd/main.go` wires the two together.

Design note for the implementer: audit for *successful* invocations comes from the Connect interceptor chain, not from `Invoker`. `Invoker` emits an audit event only for requests it rejects before the Connect call (scope denial, failed confirmation), because those never reach the chain. Do not emit audit events in `Invoker` for calls that do reach Connect — that would double-record every write.

```go
// newTestInvoker builds the three-tool registry used by the invoker tests.
func newTestInvoker(t *testing.T) (*Invoker, *recordingAuditor) {
	t.Helper()
	r := NewRegistry()
	require.NoError(t, r.Register(stubTool("fleet_status", ScopeRead, false)))
	require.NoError(t, r.Register(stubTool("sync_application", ScopeWrite, false)))
	require.NoError(t, r.Register(stubTool("rollback_release", ScopeWrite, true)))
	return newInvokerForRegistry(t, r)
}

// withConfirmation injects a confirmation token into an argument object,
// leaving all other fields byte-identical so the argument hash still matches.
func withConfirmation(args json.RawMessage, token string) (json.RawMessage, error) {
	var obj map[string]any
	if err := json.Unmarshal(args, &obj); err != nil {
		return nil, err
	}
	obj["confirmation_token"] = token
	return json.Marshal(obj)
}
```

Note for the implementer: `Invoker.Call` must strip `confirmation_token` from the arguments **before** hashing them, or the hash computed at `Issue` time (without the token) will never match the hash at `Consume` time (with it). `TestConfirmRoundTrip` in Task 7 does not catch this because it bypasses the invoker; `TestEveryWriteToolIsAudited` in Task 11 does.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/mcp/ -run TestCall -v`
Expected: FAIL — undefined `NewInvoker`.

- [ ] **Step 3: Write minimal implementation**

Order of operations matters and is fixed:

1. Look up the tool; unknown → `ErrToolNotFound`.
2. Check declared scope against `p.Scopes`; missing → audit a failure event, return `ErrScopeDenied`. This happens **before** any Connect call, so a denied write never reaches the handler.
3. If `Destructive` and no `confirmation_token` in args → issue one, return `*ConfirmationRequiredError` with a preview. No mutation occurs.
4. If `Destructive` with a token → `Confirmer.Consume`; failure maps to the confirm errors.
5. Invoke, passing the client through.

```go
type ConfirmationRequiredError struct {
	Tool    string
	Token   string
	Preview string
}

func (e *ConfirmationRequiredError) Error() string {
	return fmt.Sprintf("tool %q requires confirmation: %s", e.Tool, e.Preview)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/mcp/ -run TestCall -v`
Expected: PASS on all five.

- [ ] **Step 5: Commit**

```bash
git add internal/api/mcp/invoke.go internal/api/mcp/invoke_test.go
git commit -m "feat(mcp): enforce scope and confirmation before any Connect call"
```

### Task 9: Read tool definitions

**Files:**
- Create: `internal/api/mcp/tools_read.go`
- Test: `internal/api/mcp/tools_read_test.go`

**Interfaces:**
- Consumes: `Tool`, `Registry`, `ScopeRead`.
- Produces: `func RegisterReadTools(r *Registry) error`, registering the 14 read tools named in the spec.

- [ ] **Step 1: Write failing test**

```go
func TestRegisterReadToolsRegistersAllFourteen(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))

	want := []string{
		"fleet_status", "list_clusters", "fleet_map", "list_applications",
		"get_application", "investigate", "get_resource_tree", "get_logs",
		"list_pipelines", "get_pipeline_run", "list_releases", "list_rollouts",
		"get_rollout", "query_cost",
	}
	assert.Len(t, r.All(), len(want))
	for _, name := range want {
		tool, ok := r.Lookup(name)
		require.True(t, ok, "missing tool %q", name)
		assert.Equal(t, ScopeRead, tool.Scope, "%q must be read-scoped", name)
		assert.False(t, tool.Destructive)
	}
}

func TestReadToolSchemasAreValidJSON(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	for _, tool := range r.All() {
		var schema map[string]any
		require.NoError(t, json.Unmarshal(tool.InputSchema, &schema), tool.Name)
		assert.Equal(t, "object", schema["type"], tool.Name)
		assert.NotEmpty(t, tool.Description, "%q needs a description", tool.Name)
	}
}

func TestListToolsDefaultPageSizeIsCapped(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	for _, name := range []string{"list_applications", "list_clusters", "list_releases"} {
		tool, ok := r.Lookup(name)
		require.True(t, ok)
		var schema struct {
			Properties struct {
				PageSize struct {
					Default int `json:"default"`
					Maximum int `json:"maximum"`
				} `json:"page_size"`
			} `json:"properties"`
		}
		require.NoError(t, json.Unmarshal(tool.InputSchema, &schema))
		assert.Equal(t, 50, schema.Properties.PageSize.Default, name)
		assert.LessOrEqual(t, schema.Properties.PageSize.Maximum, 200, name)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/mcp/ -run 'TestRegisterReadTools|TestReadTool|TestListTools' -v`
Expected: FAIL — undefined `RegisterReadTools`.

- [ ] **Step 3: Write minimal implementation**

One `Tool` literal per entry. Representative example, and the pattern for the rest:

```go
// RegisterReadTools registers the read-only tool surface. Each tool maps to one
// or more Connect RPCs; near-duplicate RPCs are merged behind a parameter
// rather than exposed separately, to keep tool selection unambiguous.
func RegisterReadTools(r *Registry) error {
	tools := []Tool{
		{
			Name:        "fleet_status",
			Description: "Overall fleet health: application counts by state, degraded applications, and configured data sources.",
			Scope:       ScopeRead,
			InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
			Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, _ json.RawMessage) (any, error) {
				resp, err := c.GetSystemStatus(ctx, connect.NewRequest(&v1.GetSystemStatusRequest{}))
				if err != nil {
					return nil, err
				}
				return resp.Msg, nil
			},
		},
		{
			Name:        "list_clusters",
			Description: "List clusters in the fleet, optionally including CPU and memory capacity meters.",
			Scope:       ScopeRead,
			InputSchema: json.RawMessage(`{
				"type":"object",
				"properties":{
					"namespace":{"type":"string"},
					"include_capacity":{"type":"boolean","default":false},
					"page_size":{"type":"integer","default":50,"maximum":200},
					"cursor":{"type":"string"}
				},
				"additionalProperties":false
			}`),
			Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
				var in struct {
					Namespace       string `json:"namespace"`
					IncludeCapacity bool   `json:"include_capacity"`
					PageSize        uint32 `json:"page_size"`
					Cursor          string `json:"cursor"`
				}
				if err := json.Unmarshal(args, &in); err != nil {
					return nil, connect.NewError(connect.CodeInvalidArgument, err)
				}
				if in.PageSize == 0 || in.PageSize > 200 {
					in.PageSize = 50
				}
				resp, err := c.ListClusters(ctx, connect.NewRequest(&v1.ListClustersRequest{
					Namespace:       &in.Namespace,
					IncludeCapacity: in.IncludeCapacity,
					PageSize:        in.PageSize,
					Cursor:          in.Cursor,
				}))
				if err != nil {
					return nil, err
				}
				return truncated(resp.Msg, resp.Msg.NextCursor), nil
			},
		},
		// ... 12 more following the same shape
	}
	for _, t := range tools {
		if err := r.Register(t); err != nil {
			return err
		}
	}
	return nil
}

// truncated marks a paginated response so the model knows it is not seeing the
// whole fleet. Silent truncation would let it reason confidently over partial data.
func truncated(payload any, nextCursor string) map[string]any {
	out := map[string]any{"data": payload}
	if nextCursor != "" {
		out["truncated"] = true
		out["next_cursor"] = nextCursor
		out["note"] = "More results exist. Re-call with cursor to continue."
	}
	return out
}
```

`get_resource_tree` takes `detailed: bool` and dispatches to `GetResourceTree` or `GetResourceTreeDetailed`. `get_logs` takes `kind: "resource"|"step"` and a required `tail_lines` (default 200, max 2000), dispatching to `GetResourceLogs` or `GetStepLogs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/mcp/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/api/mcp/tools_read.go internal/api/mcp/tools_read_test.go
git commit -m "feat(mcp): add the fourteen read tools with capped pagination"
```

### Task 10: Registry completeness guard

**Files:**
- Create: `internal/api/mcp/coverage_test.go`

**Interfaces:**
- Consumes: `RegisterReadTools`, `RegisterWriteTools` (Task 12 — write this test after Task 12 lands, or stub the write half and complete it then).
- Produces: a standing guard.

- [ ] **Step 1: Write the test**

```go
// optedOutRPCs lists every RPC deliberately not exposed over MCP, with the
// reason. Adding an RPC to api.proto without registering a tool or adding it
// here fails this test on purpose. Reasons come from the spec's Exclusions.
var optedOutRPCs = map[string]string{
	"ApplyBundle":        "arbitrary manifest bundle; no meaningful scope boundary",
	"ApplyResourcePatch": "arbitrary patch against arbitrary resource; same objection",
	"SyncResources":      "bulk blast radius cannot be previewed trustworthily",
	"IgnoreDriftedField": "durable governance decision; belongs to a human in the console",
	"StreamResourceLogs": "server-streaming; MCP tool calls are request/response",
	// read RPCs reachable through a merged tool or too narrow to earn schema budget
	"GetResourceTreeDetailed": "reachable via get_resource_tree detailed=true",
	"GetResourceLogs":         "reachable via get_logs kind=resource",
	"GetStepLogs":             "reachable via get_logs kind=step",
	"QueryApplications":       "reachable via list_applications",
	// ... remaining read exclusions, each with a reason
}

func TestEveryProtoRPCIsExposedOrOptedOut(t *testing.T) {
	data, err := os.ReadFile("../../../proto/paprika/v1/api.proto")
	require.NoError(t, err)
	re := regexp.MustCompile(`(?m)^\s+rpc\s+([A-Za-z]+)\s*\(`)
	matches := re.FindAllStringSubmatch(string(data), -1)
	require.NotEmpty(t, matches)

	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	require.NoError(t, RegisterWriteTools(r))

	covered := map[string]bool{}
	for _, tool := range r.All() {
		for _, rpc := range toolRPCs[tool.Name] {
			covered[rpc] = true
		}
	}

	for _, m := range matches {
		name := m[1]
		t.Run(name, func(t *testing.T) {
			if covered[name] {
				return
			}
			reason, ok := optedOutRPCs[name]
			assert.True(t, ok,
				"%s is neither exposed as a tool nor opted out: register a tool "+
					"or add it to optedOutRPCs with a reason", name)
			assert.NotEmpty(t, reason, "%s needs a stated reason", name)
		})
	}
}
```

This requires each tool file to declare which RPCs its tools cover. Declare **two** maps, not one — a single package-level `toolRPCs` cannot be declared in two files, which would be a compile error:

```go
// in tools_read.go
var readToolRPCs = map[string][]string{
	"fleet_status": {"GetSystemStatus"},
	"list_clusters": {"ListClusters"},
	"get_resource_tree": {"GetResourceTree", "GetResourceTreeDetailed"},
	"get_logs": {"GetResourceLogs", "GetStepLogs"},
	// ... one entry per read tool
}

// in tools_write.go
var writeToolRPCs = map[string][]string{
	"rollback_release": {"RollbackRelease"},
	// ... one entry per write tool
}
```

The test merges them:

```go
func toolRPCs() map[string][]string {
	merged := make(map[string][]string, len(readToolRPCs)+len(writeToolRPCs))
	for name, rpcs := range readToolRPCs {
		merged[name] = rpcs
	}
	for name, rpcs := range writeToolRPCs {
		merged[name] = rpcs
	}
	return merged
}
```

and Task 10's coverage loop uses `toolRPCs()[tool.Name]` rather than `toolRPCs[tool.Name]`.

- [ ] **Step 2: Run the test**

Run: `go test ./internal/api/mcp/ -run TestEveryProtoRPCIsExposedOrOptedOut -v`
Expected: PASS — 60 subtests, each either covered or opted out.

- [ ] **Step 3: Verify the guard bites**

Temporarily remove `"QueryCost"` coverage, re-run, confirm a FAIL naming it, restore.

- [ ] **Step 4: Commit**

```bash
git add internal/api/mcp/coverage_test.go internal/api/mcp/tools_read.go internal/api/mcp/tools_write.go
git commit -m "test(mcp): require every RPC to be exposed or explicitly opted out"
```

---

## Phase 4 — Write tools

### Task 11: Registry-driven security invariants

**Files:**
- Create: `internal/api/mcp/security_test.go`

**Interfaces:**
- Consumes: `Registry`, `Invoker`, `RegisterReadTools`, `RegisterWriteTools`.
- Produces: the two standing guards from the spec's Testing section.

These are the most valuable tests in the plan: they iterate the registry, so they cannot drift as tools are added.

- [ ] **Step 1: Write the tests**

```go
func TestNoWriteToolReachableWithReadScope(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	require.NoError(t, RegisterWriteTools(r))
	inv, _ := newInvokerForRegistry(t, r)
	readOnly := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeRead)}}

	for _, tool := range r.All() {
		if tool.Scope != ScopeWrite {
			continue
		}
		t.Run(tool.Name, func(t *testing.T) {
			_, err := inv.Call(context.Background(), readOnly, tool.Name, json.RawMessage(`{}`))
			require.Error(t, err, "%s must be unreachable with read scope", tool.Name)
			assert.ErrorIs(t, err, ErrScopeDenied)
		})
	}
}

func TestEveryWriteToolIsAudited(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterWriteTools(r))
	writer := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeWrite)}}

	for _, tool := range r.All() {
		t.Run(tool.Name, func(t *testing.T) {
			inv, aud := newInvokerForRegistry(t, r)
			args := json.RawMessage(`{"name":"web","namespace":"prod"}`)

			if tool.Destructive {
				_, err := inv.Call(context.Background(), writer, tool.Name, args)
				var need *ConfirmationRequiredError
				require.ErrorAs(t, err, &need)
				args, _ = withConfirmation(args, need.Token)
			}
			_, _ = inv.Call(context.Background(), writer, tool.Name, args)

			require.NotEmpty(t, aud.events, "%s produced no audit record", tool.Name)
			assert.Equal(t, "u1", aud.events[len(aud.events)-1].Principal)
		})
	}
}

func TestEveryDestructiveToolRefusesWithoutConfirmation(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterWriteTools(r))
	inv, _ := newInvokerForRegistry(t, r)
	writer := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeWrite)}}

	for _, tool := range r.All() {
		if !tool.Destructive {
			continue
		}
		t.Run(tool.Name, func(t *testing.T) {
			_, err := inv.Call(context.Background(), writer, tool.Name,
				json.RawMessage(`{"name":"web","namespace":"prod"}`))
			var need *ConfirmationRequiredError
			assert.ErrorAs(t, err, &need,
				"%s must not execute on first call", tool.Name)
		})
	}
}
```

- [ ] **Step 2: Run tests**

Run: `go test ./internal/api/mcp/ -run 'TestNoWriteTool|TestEveryWriteTool|TestEveryDestructive' -v`
Expected: PASS once Task 12 lands. If run before Task 12, `RegisterWriteTools` is undefined — expected; land Task 12 first and return.

- [ ] **Step 3: Commit**

```bash
git add internal/api/mcp/security_test.go
git commit -m "test(mcp): add registry-driven scope and audit invariants"
```

### Task 12: Write tool definitions

**Files:**
- Create: `internal/api/mcp/tools_write.go`
- Test: `internal/api/mcp/tools_write_test.go`

**Interfaces:**
- Consumes: `Tool`, `Registry`, `ScopeWrite`.
- Produces: `func RegisterWriteTools(r *Registry) error`, registering the 11 write tools with `Destructive` set per the spec's table.

- [ ] **Step 1: Write failing test**

```go
func TestRegisterWriteToolsMatchesSpecTable(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterWriteTools(r))

	wantDestructive := map[string]bool{
		"rollback_release": true, "promote_rollout": true, "abort_rollout": true,
		"cancel_pipeline": true, "skip_step": true,
		"sync_application": false, "approve_gate": false, "reject_gate": false,
		"hold_rollout": false, "resume_rollout": false, "retry_step": false,
	}
	assert.Len(t, r.All(), len(wantDestructive))
	for name, destructive := range wantDestructive {
		tool, ok := r.Lookup(name)
		require.True(t, ok, "missing %q", name)
		assert.Equal(t, ScopeWrite, tool.Scope, "%q must be write-scoped", name)
		assert.Equal(t, destructive, tool.Destructive, "%q destructiveness", name)
	}
}

func TestDestructiveToolSchemasAcceptConfirmationToken(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterWriteTools(r))
	for _, tool := range r.All() {
		if !tool.Destructive {
			continue
		}
		var schema struct {
			Properties map[string]any `json:"properties"`
		}
		require.NoError(t, json.Unmarshal(tool.InputSchema, &schema))
		assert.Contains(t, schema.Properties, "confirmation_token", tool.Name)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/mcp/ -run TestRegisterWriteTools -v`
Expected: FAIL — undefined `RegisterWriteTools`.

- [ ] **Step 3: Write minimal implementation**

Same shape as `tools_read.go`. Destructive tools include `confirmation_token` in their schema and a `Preview` builder used by the invoker:

```go
{
	Name: "rollback_release",
	Description: "Roll a release back to a previous revision. Destructive: requires confirmation.",
	Scope:       ScopeWrite,
	Destructive: true,
	InputSchema: json.RawMessage(`{
		"type":"object",
		"properties":{
			"namespace":{"type":"string"},
			"name":{"type":"string"},
			"revision":{"type":"string"},
			"confirmation_token":{"type":"string","description":"Token from the unconfirmed call."}
		},
		"required":["namespace","name"],
		"additionalProperties":false
	}`),
	Invoke: func(ctx context.Context, c v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
		var in struct {
			Namespace string `json:"namespace"`
			Name      string `json:"name"`
			Revision  string `json:"revision"`
		}
		if err := json.Unmarshal(args, &in); err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		resp, err := c.RollbackRelease(ctx, connect.NewRequest(&v1.RollbackReleaseRequest{
			Namespace: in.Namespace, Name: in.Name, Revision: in.Revision,
		}))
		if err != nil {
			return nil, err
		}
		return resp.Msg, nil
	},
},
```

Also add `toolRPCs` entries for each, feeding Task 10's completeness guard.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/mcp/ -v`
Expected: PASS, including Task 11's invariants.

- [ ] **Step 5: Commit**

```bash
git add internal/api/mcp/tools_write.go internal/api/mcp/tools_write_test.go
git commit -m "feat(mcp): add the eleven write tools with destructive flags"
```

---

## Phase 5 — Protocol, OAuth, wiring

### Task 13: MCP protocol server

**Files:**
- Create: `internal/api/mcp/server.go`
- Test: `internal/api/mcp/server_test.go`
- Modify: `go.mod`, `go.sum`

**Interfaces:**
- Consumes: `Registry`, `Invoker`, `Confirmer`, `auth.Authenticator`, `audit.Auditor`, `*cache.Cache`.
- Produces:

> **BLOCKER found during Task 11's review — read before implementing.**
>
> Nothing currently attaches credentials to the in-process Connect request. `stubConnectClient` uses a bare `&http.Client{}`, and `Invoker` holds a single client with no per-request identity.
>
> In production, Task 15 *mandates* that `buildMCPHandlers` error when `mcpEnabled && !authCfg.Enabled`, so the auth interceptor is always in the chain. The auth interceptor reads credentials from the request headers and returns `CodeUnauthenticated` at `auth/middleware.go:53` when they are absent — **before** the audit interceptor runs.
>
> Consequence as things stand: **every MCP tool call would fail `CodeUnauthenticated`**. The feature would be entirely non-functional in production while every unit test passes, because the test chain omits auth.
>
> This is the genuine implicit contract between the MCP layer and the Connect chain, and Task 13 must close it.
>
> **Required approach — do not change `invoke.go`.** `Invoker` is complete and reviewed; do not give it a per-request client or a new parameter. Instead make the transport credential-aware:
>
> 1. Add a context key in `internal/api/mcp` carrying the caller's raw bearer token.
> 2. The MCP server, having authenticated the request, puts that token into the context it passes to `Invoker.Call`.
> 3. `NewInProcessTransport`'s `RoundTrip` reads the token from `req.Context()` and sets `Authorization: Bearer <token>` on the outgoing in-process request when present.
>
> The auth interceptor then validates it exactly as it would a console request, derives the `Principal`, and the existing `Authorizer` enforces per-user project scoping — which is precisely the architecture the spec argues for. Authorization is enforced once, in one chain, with no second implementation to drift.
>
> Note this also means the token must still be valid at tool-call time, and that `RoundTrip` must not leak the token into logs or error messages.
>
> **Required test:** an integration test running a tool call through a handler chain that HAS the auth interceptor enabled, asserting the call succeeds with a valid token and returns `CodeUnauthenticated` without one. A test against an auth-less chain cannot catch this class of bug — that is exactly how it reached Task 13 unnoticed.

```go
type ServerConfig struct {
	Registry      *Registry
	Authenticator auth.Authenticator
	Confirmer     *Confirmer
	Auditor       audit.Auditor
	Cache         *cache.Cache
	Secret        []byte // HMAC secret for minting access tokens
	PublicURL     string // external base URL, used in discovery metadata
	ClientID      string // statically registered OAuth client
	RedirectURIs  []string
	AccessTTL     time.Duration
	RefreshTTL    time.Duration
}

func NewServer(cfg ServerConfig) (*Server, error)
func (s *Server) Handler() http.Handler
func (s *Server) RegisterOAuthRoutes(mux *http.ServeMux) // Task 14
```

`NewServer` validates that `Registry`, `Authenticator`, `Cache`, and `Secret` are non-nil/non-empty and returns an error otherwise — a server missing its authenticator must not start.

- [ ] **Step 1: Add the SDK**

Run: `go get github.com/modelcontextprotocol/go-sdk@latest && go mod tidy`
Then pin the resolved version in `go.mod`. Record the version in the commit message.

- [ ] **Step 2: Write failing test**

```go
func TestInitializeAdvertisesTools(t *testing.T) {
	srv := newTestServer(t)
	resp := doJSONRPC(t, srv, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		bearerFor(t, ScopeRead))

	var out struct {
		Result struct {
			Tools []struct {
				Name        string `json:"name"`
				Annotations struct {
					ReadOnlyHint    bool `json:"readOnlyHint"`
					DestructiveHint bool `json:"destructiveHint"`
				} `json:"annotations"`
			} `json:"tools"`
		} `json:"result"`
	}
	require.NoError(t, json.Unmarshal(resp, &out))
	require.NotEmpty(t, out.Result.Tools)

	byName := map[string]bool{}
	for _, tool := range out.Result.Tools {
		byName[tool.Name] = tool.Annotations.ReadOnlyHint
	}
	assert.True(t, byName["fleet_status"], "read tools carry readOnlyHint")
	assert.False(t, byName["rollback_release"], "write tools must not")
}

func TestUnauthenticatedReturns401WithWWWAuthenticate(t *testing.T) {
	srv := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	srv.Handler().ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Header().Get("WWW-Authenticate"), "resource_metadata",
		"clients need this to discover the AS and re-run OAuth")
}
```

Helpers for this task, added to `helpers_test.go`:

```go
// newTestServer builds a server over the full tool registry with auth enabled.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	require.NoError(t, RegisterWriteTools(r))
	store, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)

	srv, err := NewServer(ServerConfig{
		Registry:      r,
		Authenticator: mustAudienceAuthenticator(t, testSecret, "paprika-mcp", testIssuer),
		Confirmer:     NewConfirmer(store, time.Minute),
		Auditor:       &recordingAuditor{},
		Cache:         store,
		Secret:        testSecret,
		PublicURL:     "https://paprika.example",
	})
	require.NoError(t, err)
	return srv
}

// bearerFor mints a valid MCP access token carrying the given scopes.
func bearerFor(t *testing.T, scopes ...Scope) string {
	t.Helper()
	raw := make([]string, len(scopes))
	for i, s := range scopes {
		raw[i] = string(s)
	}
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject: "test-user", Email: "test@example.com", Name: "Test",
		Audience: "paprika-mcp", Scope: strings.Join(raw, " "),
		TTL: time.Hour, Secret: testSecret,
	})
	require.NoError(t, err)
	return token
}

// doJSONRPC posts a JSON-RPC envelope to /mcp and returns the response body.
func doJSONRPC(t *testing.T, srv *Server, body, token string) []byte {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	srv.Handler().ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, "body: %s", rec.Body.String())
	return rec.Body.Bytes()
}

// newTestServerWithCache exposes the backing store for refresh-token seeding.
func newTestServerWithCache(t *testing.T) (*Server, *cache.Cache) {
	t.Helper()
	srv := newTestServer(t)
	return srv, srv.cache
}

// newTestServerWithRedirects configures the exact-match redirect allowlist.
func newTestServerWithRedirects(t *testing.T, redirects []string) *Server {
	t.Helper()
	srv := newTestServer(t)
	srv.clientID = "test"
	srv.redirectURIs = redirects
	return srv
}
```

This fixes `ServerConfig` as the constructor's parameter type; Task 15's `buildMCPHandlers` populates the same struct.

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/api/mcp/ -run 'TestInitialize|TestUnauthenticated' -v`
Expected: FAIL — undefined `NewServer`.

- [ ] **Step 4: Write minimal implementation**

The handler authenticates via the injected `auth.Authenticator`, derives the `Principal`, maps `tools/list` to `Registry.All()` (emitting `readOnlyHint`/`destructiveHint` annotations from `Scope` and `Destructive`), and maps `tools/call` to `Invoker.Call`. On `auth.ErrUnauthenticated` it writes 401 with:

```go
w.Header().Set("WWW-Authenticate",
	fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource"`, s.publicURL))
```

Map invoker errors to JSON-RPC errors: `ErrScopeDenied` → `-32001` naming the missing scope; `*ConfirmationRequiredError` → a successful tool result carrying preview and token (not an error, so the model can act on it); `ErrToolNotFound` → `-32601`.

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/api/mcp/ -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/api/mcp/server.go internal/api/mcp/server_test.go
git commit -m "feat(mcp): serve the MCP protocol with tool annotations and 401 discovery"
```

### Task 14: OAuth discovery and token endpoints

**Files:**
- Create: `internal/api/mcp/oauth.go`
- Test: `internal/api/mcp/oauth_test.go`

**Interfaces:**
- Consumes: `auth.IssueTokenWithOptions` (Task 6), `*cache.Cache`.
- Produces: `func (s *Server) RegisterOAuthRoutes(mux *http.ServeMux)` serving `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/mcp/authorize`, `/mcp/token`.

- [ ] **Step 1: Write failing test**

```go
func TestProtectedResourceMetadata(t *testing.T) {
	mux := http.NewServeMux()
	newTestServer(t).RegisterOAuthRoutes(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/.well-known/oauth-protected-resource", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	var meta struct {
		Resource             string   `json:"resource"`
		AuthorizationServers []string `json:"authorization_servers"`
		ScopesSupported      []string `json:"scopes_supported"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &meta))
	assert.NotEmpty(t, meta.AuthorizationServers)
	assert.ElementsMatch(t, []string{"paprika:read", "paprika:write"}, meta.ScopesSupported)
}

func TestAuthorizeRejectsUnregisteredRedirectURI(t *testing.T) {
	srv := newTestServerWithRedirects(t, []string{"https://claude.ai/api/mcp/auth_callback"})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	for _, redirect := range []string{
		"https://evil.example/callback",
		"https://claude.ai/api/mcp/auth_callback/../../evil",
		"https://claude.ai.evil.example/api/mcp/auth_callback",
		"https://claude.ai/api/mcp/auth_callback?x=1",
	} {
		t.Run(redirect, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet,
				"/mcp/authorize?client_id=test&response_type=code"+
					"&code_challenge=abc&code_challenge_method=S256"+
					"&redirect_uri="+url.QueryEscape(redirect), nil)
			mux.ServeHTTP(rec, req)

			assert.Equal(t, http.StatusBadRequest, rec.Code,
				"redirect_uri matching must be exact, never prefix or suffix")
			assert.NotContains(t, rec.Header().Get("Location"), "evil",
				"must never redirect to an unregistered URI")
		})
	}
}

func TestAuthorizeAcceptsExactRegisteredRedirectURI(t *testing.T) {
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	srv := newTestServerWithRedirects(t, []string{redirect})
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet,
		"/mcp/authorize?client_id=test&response_type=code"+
			"&code_challenge=abc&code_challenge_method=S256"+
			"&redirect_uri="+url.QueryEscape(redirect), nil)
	mux.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusBadRequest, rec.Code)
}

func TestRefreshTokenRotatesAndRevokesPredecessor(t *testing.T) {
	srv, store := newTestServerWithCache(t)
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	first := seedRefreshToken(t, store, "user-1", "paprika:read")

	firstResp := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {first},
		"client_id":     {"test"},
	})
	require.Equal(t, http.StatusOK, firstResp.Code)

	var body struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int    `json:"expires_in"`
	}
	require.NoError(t, json.Unmarshal(firstResp.Body.Bytes(), &body))
	require.NotEmpty(t, body.AccessToken)
	require.NotEmpty(t, body.RefreshToken)
	assert.Equal(t, "Bearer", body.TokenType)
	assert.NotEqual(t, first, body.RefreshToken, "refresh tokens must rotate")

	replay := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {first},
		"client_id":     {"test"},
	})
	assert.Equal(t, http.StatusBadRequest, replay.Code,
		"a rotated refresh token must not work twice")
}

func TestIssuedAccessTokenCarriesMCPAudience(t *testing.T) {
	srv, store := newTestServerWithCache(t)
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	refresh := seedRefreshToken(t, store, "user-1", "paprika:read")
	resp := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refresh},
		"client_id":     {"test"},
	})
	require.Equal(t, http.StatusOK, resp.Code)

	var body struct {
		AccessToken string `json:"access_token"`
	}
	require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &body))

	// The MCP authenticator must accept it, and the console one must not.
	mcpAuth := mustAudienceAuthenticator(t, testSecret, "paprika-mcp", testIssuer)
	p, err := mcpAuth.Authenticate(ctxWithBearer(body.AccessToken))
	require.NoError(t, err)
	assert.Equal(t, "user-1", p.Subject)
	assert.Equal(t, []string{"paprika:read"}, p.Scopes)

	apiAuth := mustAudienceAuthenticator(t, testSecret, "paprika-api", testIssuer)
	_, err = apiAuth.Authenticate(ctxWithBearer(body.AccessToken))
	assert.Error(t, err, "an MCP token must not be replayable against the console API")
}

func TestTokenEndpointRejectsUnsupportedGrant(t *testing.T) {
	srv, _ := newTestServerWithCache(t)
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)

	resp := postForm(t, mux, "/mcp/token", url.Values{
		"grant_type": {"password"},
		"username":   {"admin"},
		"password":   {"hunter2"},
	})
	assert.Equal(t, http.StatusBadRequest, resp.Code,
		"only authorization_code and refresh_token are supported")
}
```

Helpers used above:

```go
var (
	testSecret = []byte("test-secret-value-at-least-32-bytes!!")
	testIssuer = "https://paprika.example"
)

// mustAudienceAuthenticator wraps the constructor, which returns an error.
//
// NOTE: Task 6 shipped this signature, which differs from what Task 6's own
// brief sketched:
//
//	NewSelfSignedAuthenticatorForAudience(secret []byte, audience, issuer string)
//	    (*SelfSignedAuthenticator, error)
//
// It takes an issuer as well as an audience, and it returns an error rather
// than a bare pointer — it rejects an empty audience at construction, so a
// misconfigured empty value cannot silently disable audience binding. Use this
// signature, not the one in Task 6's brief text.
func mustAudienceAuthenticator(t *testing.T, secret []byte, audience, issuer string) *auth.SelfSignedAuthenticator {
	t.Helper()
	a, err := auth.NewSelfSignedAuthenticatorForAudience(secret, audience, issuer)
	require.NoError(t, err)
	return a
}

func postForm(t *testing.T, h http.Handler, path string, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	h.ServeHTTP(rec, req)
	return rec
}

// seedRefreshToken writes a refresh record directly so tests do not need to
// drive the full browser authorization-code flow.
func seedRefreshToken(t *testing.T, store *cache.Cache, subject, scope string) string {
	t.Helper()
	token := "refresh-" + subject
	payload, err := json.Marshal(map[string]string{"sub": subject, "scope": scope})
	require.NoError(t, err)
	require.NoError(t, store.Set(context.Background(), "mcp:refresh:"+token, payload, time.Hour))
	return token
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/mcp/ -run 'TestProtectedResource|TestToken|TestRefresh|TestIssuedAccess' -v`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Authorization-code + PKCE, reusing the existing Google OIDC login for identity. Access tokens minted via `IssueTokenWithOptions` with `Audience: "paprika-mcp"` and the granted scope. Refresh tokens are random 32-byte values stored in the cache under `mcp:refresh:<token>` holding subject, scope, and issue time, rotated on every use and deleted on rotation.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/mcp/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/api/mcp/oauth.go internal/api/mcp/oauth_test.go
git commit -m "feat(mcp): add OAuth 2.1 discovery, token, and rotating refresh"
```

### Task 15: Wire into api mode

**Files:**
- Modify: `cmd/main.go` (flag registration near line 278; handler assembly near line 700)
- Test: `cmd/main_test.go`

**Interfaces:**
- Consumes: everything above.
- Produces: `func buildMCPHandlers(ctx context.Context, cfg *cliConfig, connectHandler http.Handler, authCfg auth.Config, cache *cache.Cache) ([]func(*http.ServeMux), error)`, matching the existing `buildAuthHandlers` shape.

- [ ] **Step 1: Write failing test**

```go
// NOTE: registerFlags in cmd/main.go:241 has the signature
//   registerFlags(args []string, getenv func(string) string, stderr io.Writer) (*cliConfig, error)
// It parses and returns the config; it does not take a FlagSet or a config
// pointer. Use the real signature.
func TestMCPDisabledByDefault(t *testing.T) {
	cfg, err := registerFlags(nil, func(string) string { return "" }, io.Discard)
	require.NoError(t, err)
	assert.False(t, cfg.mcpEnabled, "MCP must be opt-in")
}

func TestMCPFlagsParse(t *testing.T) {
	cfg, err := registerFlags(
		[]string{"--mcp-enabled", "--mcp-bind-address=:9999", "--mcp-access-token-ttl=1h"},
		func(string) string { return "" }, io.Discard)
	require.NoError(t, err)
	assert.True(t, cfg.mcpEnabled)
	assert.Equal(t, ":9999", cfg.mcpBindAddress)
	assert.Equal(t, time.Hour, cfg.mcpAccessTokenTTL)
}

func TestBuildMCPHandlersReturnsNothingWhenDisabled(t *testing.T) {
	handlers, err := buildMCPHandlers(context.Background(),
		&cliConfig{mcpEnabled: false}, nil, auth.Config{}, nil)
	require.NoError(t, err)
	assert.Empty(t, handlers)
}

func TestBuildMCPHandlersRequiresAuthEnabled(t *testing.T) {
	_, err := buildMCPHandlers(context.Background(),
		&cliConfig{mcpEnabled: true}, http.NewServeMux(),
		auth.Config{Enabled: false}, nil)
	require.Error(t, err,
		"MCP must refuse to start without authentication")
}
```

That third test matters: MCP with auth disabled would expose fleet mutation unauthenticated. Fail closed at startup rather than serve.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/ -run TestMCP -v` and `go test ./cmd/ -run TestBuildMCPHandlers -v`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Add fields to `cliConfig` and register flags per the spec's Configuration table. In `buildMCPHandlers`: return `nil, nil` when disabled; error when `cfg.mcpEnabled && !authCfg.Enabled`; otherwise construct the client over `NewInProcessTransport(connectHandler)`, build the registry from both `RegisterReadTools` and `RegisterWriteTools`, and return registrars for `/mcp` plus the OAuth routes.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./cmd/... ./internal/api/...`
Expected: PASS

- [ ] **Step 5: Verify the binary builds and the flags appear**

Run: `go build ./... && go run ./cmd --help 2>&1 | grep mcp`
Expected: the six `--mcp-*` flags listed, `--mcp-enabled` defaulting to false.

- [ ] **Step 6: Commit**

```bash
git add cmd/main.go cmd/main_test.go
git commit -m "feat(mcp): wire the MCP server into api mode, disabled by default"
```

### Task 16: Chart support

**Files:**
- Modify: `charts/chart/values.yaml`
- Modify: `charts/chart/templates/api-server/deployment.yaml`
- Test: manual `helm template` verification

**Interfaces:**
- Consumes: the flags from Task 15.
- Produces: an `mcp:` values block.

- [ ] **Step 1: Add values with documentation**

```yaml
mcp:
  # Serve Paprika's fleet API to MCP clients over OAuth 2.1. Disabled by
  # default: this is the only surface that lets a language model mutate fleet
  # state, and it requires auth.enabled=true to start at all.
  #
  # Writes are additionally gated by the paprika:write scope, and destructive
  # operations require a two-phase confirmation bound to exact arguments.
  # See docs/superpowers/specs/2026-09-11-mcp-server-design.md.
  enabled: false
  bindAddress: ":8090"
  accessTokenTTL: "24h"
  refreshTokenTTL: "720h"
  oauth:
    clientId: ""
    redirectUris: []
```

- [ ] **Step 2: Add conditional args to the deployment template**

Guard the whole block on `.Values.mcp.enabled`, and add a `fail` guard mirroring the runtime check:

```
{{- if and .Values.mcp.enabled (not .Values.auth.enabled) }}
{{- fail "mcp.enabled requires auth.enabled: refusing to expose fleet mutation unauthenticated" }}
{{- end }}
```

- [ ] **Step 3: Verify rendering both ways**

Run: `helm template test charts/chart/ | grep -c mcp` → expect 0 (disabled by default).
Run: `helm template test charts/chart/ --set mcp.enabled=true --set auth.enabled=true | grep mcp` → expect the flags.
Run: `helm template test charts/chart/ --set mcp.enabled=true --set auth.enabled=false` → expect the `fail` message.

- [ ] **Step 4: Commit**

```bash
git add charts/chart/values.yaml charts/chart/templates/api-server/deployment.yaml
git commit -m "feat(chart): add MCP values, disabled by default and requiring auth"
```

### Task 17: Full-suite verification

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

Run: `go test ./...`
Expected: PASS. Record any pre-existing failures separately rather than attributing them to this work.

- [ ] **Step 2: Run the linter**

Run: `golangci-lint run ./...`
Expected: clean. The repo's most recent master commit was a lint backlog clear, so new findings are from this branch.

- [ ] **Step 3: Confirm the security invariants pass together**

Run: `go test ./internal/api/mcp/ -run 'TestNoWriteTool|TestEveryWriteTool|TestEveryDestructive|TestEveryProtoRPC' -v`
Expected: PASS, every subtest.

- [ ] **Step 4: Commit if anything changed**

```bash
git add -A && git commit -m "chore(mcp): address full-suite and lint findings"
```

---

## Self-Review Notes

**Spec coverage.** Architecture → Task 3, 15. Configuration → Task 15, 16. Tool registry → Tasks 5, 9, 12. Exclusions → Task 10. Pagination/truncation → Task 9. Registry completeness → Task 10. Claims/migration → Task 6. Two gates → Tasks 4, 8, 11. Client registration + refresh + discovery → Task 14. Write path both layers → Tasks 7, 8, 12, 13. Audit fix → Tasks 1, 2. Error handling → Tasks 8, 13. Testing → Tasks 2, 10, 11, plus per-task tests.

**Known gaps, stated rather than hidden.**

- Task 14's test bodies are named but not written out. They must be written in full before implementing; the names are a readability compromise, not permission to skip them.
- Task 10's `optedOutRPCs` map is shown partially. The implementer completes it — the test fails until every one of the 60 RPCs is accounted for, so this cannot be silently skipped.
- Task 9 shows two of fourteen tool definitions in full. The remaining twelve follow the same shape; the test in Step 1 enumerates all fourteen names, so omissions fail.
- Ginkgo e2e for the full OAuth round trip against a live instance is out of scope per the spec's Non-Goals.

**Ordering dependency.** Task 11's tests reference `RegisterWriteTools` from Task 12. Land Task 12 first, or write Task 11's file and expect a compile failure until Task 12 lands. Task 10 has the same relationship.
