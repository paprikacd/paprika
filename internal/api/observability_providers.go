package apiserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"
	"sigs.k8s.io/controller-runtime/pkg/client"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/httpx"
)

// Observability management console surface: the inventory of
// ObservabilityProvider CRs and the gateway's own per-tool usage counters.
// Both RPCs answer install-level facts — which backends are wired in, how
// often the query tools run — so neither leaks tenant topology, and both
// follow the degraded-mode contract of console_stub.go: an absent source is
// a well-formed NOT_CONFIGURED answer, never an error.
//
// This file deliberately does NOT import internal/api/mcp or
// internal/observabilitygateway even though both hold vocabulary it needs
// (the paprika-observability audience, the paprika:observe scope, the
// connector signal descriptors, the usage snapshot wire shape): mcp's
// internal test files import this package, so apiserver importing mcp —
// directly, or transitively through observabilitygateway, which imports mcp
// for its tool registration — is an import cycle the toolchain rejects. The
// vocabulary is restated here as literals and local structs; the gateway is
// the verifier of the audience/scope strings, so a drift here fails closed
// with a rejected token, never an open door. The signal table is the one
// piece with no runtime verifier — keep it in lockstep with the connector
// descriptors (see the table's comment).

// observabilityTokenAudience and observabilityScopeObserve mirror
// mcp.ObservabilityTokenAudience and mcp.ScopeObserve — restated, not
// imported, for the cycle reason above.
//
//nolint:gosec // G101 false positive: an OAuth audience/scope vocabulary, not a credential (same as mcp.ObservabilityTokenAudience).
const (
	observabilityTokenAudience = "paprika-observability"
	observabilityScopeObserve  = "paprika:observe"
)

// observabilityGatewayUsagePath is the gateway endpoint the api-server
// proxies for GetObservabilityUsage. It lives under the gateway's route
// prefix (see cmd/main_observability_gateway.go) and is protected by the
// same paprika-observability audience and paprika:observe scope as the MCP
// tools, which is why the api-server mints an audience-bound, scoped,
// 30-second token rather than reusing the caller's credential.
const observabilityGatewayUsagePath = "/observe/api/usage"

// observabilityGatewayCatalogPath is the gateway endpoint the api-server
// proxies for ListObservabilityProviderTypes; one entry appended names the
// single-type detail the GetObservabilityProviderType handler serves.
const observabilityGatewayCatalogPath = "/observe/api/catalog"

// observabilityGatewayValidatePath is the gateway endpoint the api-server
// proxies for ValidateObservabilityProvider: the health probe the onboarding
// wizard runs before a provider is created.
const observabilityGatewayValidatePath = "/observe/api/validate"

// Discovered-label vocabulary. The provider-discovery controller
// (internal/controller/observe) is the writer and its constants are the
// source of truth; they are restated here — not imported — because a
// controller package is not a dependency an API projection may take.
const (
	observabilityDiscoveredLabel = "observability.paprika.io/discovered"
	observabilityDiscoveredValue = "service"
)

// Canonical sentences for the usage surface, authored as literals in the
// console_stub.go grammar — what is missing, then what to do about it —
// and never derived from a gateway error, so no reason can leak the
// cluster-internal gateway address or backend detail.
const (
	observabilityUsageUnavailableReason = "observability gateway is not configured; " +
		"enable it to see observability tool usage"
	observabilityUsageErrorReason = "observability gateway usage is unavailable; " +
		"retry, and check the gateway logs if it persists"
)

// observabilityUsageTokenTTL bounds the internal token the api-server mints
// for one gateway call. The usage fetch is a synchronous console read: a
// token that outlives one request adds replay value to nothing.
const observabilityUsageTokenTTL = 30 * time.Second

// ListObservabilityProviders serves the inventory of ObservabilityProvider
// CRs the gateway connectors resolve against.
//
// Authorization follows the cluster-inventory precedent (ListClusters):
// providers are control-plane config, not tenant workloads, so the read is
// authorized the same way an inventory read is — the caller's namespace
// filter narrows the fleet snapshot scope, and the fleet-scope authorization
// (buildFleetQueryScopeFromProjects) decides which projects the caller may
// see at all. A caller that may read nothing in scope gets an empty page,
// not an error, matching every other inventory list.
//
// The response deliberately carries no DataState: an inventory either lists
// rows or lists none. A server built without a Kubernetes client (the
// console-stub configuration) answers the degraded shell — a well-formed
// empty page stamped with the authorized snapshot's generation — so a client
// rendering this board never special-cases the unconfigured install.
func (s *PaprikaServer) ListObservabilityProviders(
	ctx context.Context,
	req *connect.Request[paprikav1.ListObservabilityProvidersRequest],
) (*connect.Response[paprikav1.ListObservabilityProvidersResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	namespaces, err := optionalNamespaceScope(req.Msg.Namespace)
	if err != nil {
		return nil, err
	}
	generation, err := s.authorizeFleetSnapshotScope(ctx, namespaces)
	if err != nil {
		return nil, err
	}

	response := &paprikav1.ListObservabilityProvidersResponse{
		Items:           []*paprikav1.ObservabilityProviderItem{},
		IndexGeneration: generation,
	}
	if s.client == nil {
		return connect.NewResponse(response), nil
	}

	var list observabilityv1alpha1.ObservabilityProviderList
	opts := []client.ListOption{}
	if req.Msg.Namespace != nil {
		opts = append(opts, client.InNamespace(*req.Msg.Namespace))
	}
	if err := s.client.List(ctx, &list, opts...); err != nil {
		return nil, fmt.Errorf("listing observability providers: %w", err)
	}
	for i := range list.Items {
		response.Items = append(response.Items, observabilityProviderItem(&list.Items[i]))
	}
	response.Total = uint64(len(response.Items))
	return connect.NewResponse(response), nil
}

// observabilityProviderItem projects one CR to its console row. Only the
// endpoint key of the opaque connector config is extracted — the rest of
// that document is connector-specific and can hold credential material, so
// it never leaves the gateway path. Signals come from the connector
// descriptor, so a type with no connector (a CR the admission webhook never
// saw, or one created before its connector shipped) reports none rather
// than a fabricated set.
func observabilityProviderItem(cr *observabilityv1alpha1.ObservabilityProvider) *paprikav1.ObservabilityProviderItem {
	return &paprikav1.ObservabilityProviderItem{
		Name:             cr.Name,
		Namespace:        cr.Namespace,
		Type:             cr.Spec.Type,
		State:            cr.Status.State,
		Reason:           cr.Status.Reason,
		Discovered:       cr.GetLabels()[observabilityDiscoveredLabel] == observabilityDiscoveredValue,
		Endpoint:         observabilityProviderEndpoint(cr.Spec.Config.Raw),
		Signals:          observabilityProviderSignals(cr.Spec.Type),
		ObservedAtUnixMs: observabilityProviderObservedAt(cr),
	}
}

// observabilityProviderEndpoint extracts the config document's endpoint
// key and nothing else. An absent, empty or non-object config is not an
// error: the connector's own ValidateConfig is the authority on config
// shape, and this projection never invents a failure the CR status did not
// record.
func observabilityProviderEndpoint(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var config map[string]json.RawMessage
	if err := json.Unmarshal(raw, &config); err != nil {
		return ""
	}
	value, ok := config["endpoint"]
	if !ok {
		return ""
	}
	var endpoint string
	if err := json.Unmarshal(value, &endpoint); err != nil {
		return ""
	}
	return endpoint
}

// providerTypeSignals maps an ObservabilityProvider spec.type to the signal
// planes its connector serves, in descriptor order. It duplicates the four
// connectors' Descriptor().Signals (internal/observabilitygateway/connector/*)
// because apiserver cannot import the package that assembles them — see the
// file header. There is no runtime verifier for this table: adding a
// connector, or changing what a connector serves, is a compile-time decision
// here exactly like the enum mapping switches elsewhere in this package.
var providerTypeSignals = map[string][]string{
	"prometheus":             {"metrics"},
	"loki":                   {"logs"},
	"tempo":                  {"traces"},
	"otlp":                   {"logs", "metrics", "traces"},
	"gcp-cloudlogging":       {"logs"},
	"gcp-cloudmonitoring":    {"metrics"},
	"gcp-cloudtrace":         {"traces"},
	"aws-cloudwatch-logs":    {"logs"},
	"aws-cloudwatch-metrics": {"metrics"},
	"aws-xray":               {"traces"},
	"aws-cloudtrail":         {"logs"},
}

// observabilityProviderSignals lists the signal planes the connector for
// providerType advertises. A type with no connector (a CR the admission
// webhook never saw, or one created before its connector shipped) yields an
// empty (non-nil) slice: the item still exists, it just serves nothing.
func observabilityProviderSignals(providerType string) []string {
	signals := make([]string, 0, len(providerTypeSignals[providerType]))
	return append(signals, providerTypeSignals[providerType]...)
}

// observabilityProviderObservedAt reports when the gateway last assessed the
// provider, taken as the newest condition transition on the CR status. A CR
// whose status carries no conditions has not been assessed in a way this
// projection can date, so it reports 0 — the same "never" every other
// timestamp field in this API uses.
func observabilityProviderObservedAt(cr *observabilityv1alpha1.ObservabilityProvider) int64 {
	var observed int64
	for _, condition := range cr.Status.Conditions {
		at := condition.LastTransitionTime.UnixMilli()
		if at > observed {
			observed = at
		}
	}
	return observed
}

// GetObservabilityUsage serves the observability gateway's per-tool call
// counters through one short-lived proxied call.
//
// When no gateway address is wired (Phase 0 stub pattern, see
// internal/api/cost_handler.go) the response is the canonical
// NOT_CONFIGURED shell: zeroed numerics, empty tools, the one canonical
// sentence, and never an error — a missing gateway is a fact about the
// install, not about the request.
//
// When wired, the server mints a 30-second self-signed token audience-bound
// to paprika-observability, issued by the public URL the gateway's
// authenticator checks (cmd wires the same --mcp-public-url into both
// binaries) and scoped paprika:observe — exactly the credential shape the
// gateway's own OAuth flow produces — and fetches the snapshot over h2c.
// Gateway-reachability failures answer DATA_STATE_ERROR with a fixed,
// sanitized sentence: the gateway address is cluster-internal and the
// failure detail belongs in the api-server log, not in a console string.
func (s *PaprikaServer) GetObservabilityUsage(
	ctx context.Context,
	req *connect.Request[paprikav1.GetObservabilityUsageRequest],
) (*connect.Response[paprikav1.GetObservabilityUsageResponse], error) {
	if req == nil || req.Msg == nil {
		return nil, fleetInvalidArgument("request is required")
	}
	if s.observabilityGatewayAddr == "" {
		return connect.NewResponse(notConfiguredObservabilityUsage()), nil
	}

	snapshot, err := s.fetchObservabilityUsage(ctx)
	if err != nil {
		return connect.NewResponse(&paprikav1.GetObservabilityUsageResponse{
			State:             paprikav1.DataState_DATA_STATE_ERROR,
			UnavailableReason: observabilityUsageErrorReason,
			Tools:             []*paprikav1.ObservabilityToolUsage{},
		}), nil
	}

	tools := make([]*paprikav1.ObservabilityToolUsage, 0, len(snapshot.Tools))
	for _, tool := range snapshot.Tools {
		tools = append(tools, &paprikav1.ObservabilityToolUsage{
			Name:   tool.Name,
			Calls:  tool.Calls,
			Errors: tool.Errors,
		})
	}
	return connect.NewResponse(&paprikav1.GetObservabilityUsageResponse{
		State:            paprikav1.DataState_DATA_STATE_OK,
		ObservedAtUnixMs: snapshot.GeneratedAt.UnixMilli(),
		Tools:            tools,
	}), nil
}

// notConfiguredObservabilityUsage is the one shape the usage surface
// degrades to: a well-formed response whose numerics are all zero and whose
// reason is the canonical sentence shared with every other NOT_CONFIGURED
// class in this API (console_stub.go).
func notConfiguredObservabilityUsage() *paprikav1.GetObservabilityUsageResponse {
	return &paprikav1.GetObservabilityUsageResponse{
		State:             paprikav1.DataState_DATA_STATE_NOT_CONFIGURED,
		UnavailableReason: observabilityUsageUnavailableReason,
		ObservedAtUnixMs:  0,
		Tools:             []*paprikav1.ObservabilityToolUsage{},
	}
}

// usageToolJSON is one tool's counters in the gateway's /observe/api/usage
// response. It mirrors observabilitygateway.UsageToolSnapshot — restated
// here, not imported, for the cycle reason in the file header. Only the
// fields the console surface serves are decoded; last_used_at is read past.
type usageToolJSON struct {
	Name   string `json:"name"`
	Calls  uint64 `json:"calls"`
	Errors uint64 `json:"errors"`
}

// usageSnapshotJSON mirrors observabilitygateway.UsageSnapshot's wire shape
// (see internal/observabilitygateway/usage.go) for the same cycle reason.
//
//nolint:tagliatelle // The wire contract (the gateway's /observe/api/usage response) is snake_case, matching observabilitygateway.UsageSnapshot's json tags.
type usageSnapshotJSON struct {
	GeneratedAt time.Time       `json:"generated_at"`
	Tools       []usageToolJSON `json:"tools"`
}

// fetchObservabilityUsage performs one authenticated GET against the
// gateway's usage endpoint and decodes its snapshot. The error return is
// sanitized by the caller into the fixed ERROR sentence; the wrapped detail
// exists for the log line only.
func (s *PaprikaServer) fetchObservabilityUsage(ctx context.Context) (*usageSnapshotJSON, error) {
	var snapshot usageSnapshotJSON
	if err := s.callObservabilityGateway(ctx, http.MethodGet, observabilityGatewayUsagePath, nil, &snapshot); err != nil {
		return nil, err
	}
	return &snapshot, nil
}

// callObservabilityGateway performs one authenticated call against the
// observability gateway and decodes a 200 response into out. Every proxied
// surface — usage, catalog, type detail, validate — shares the token mint,
// the h2c transport and the status handling, so a gateway that answers
// anything but 200 becomes one sanitized error the callers map to their
// fixed ERROR sentence; no gateway body ever reaches a console string.
// body may be nil (GETs) or a JSON-marshalable value (POSTs).
func (s *PaprikaServer) callObservabilityGateway(
	ctx context.Context,
	method, path string,
	body, out any,
) error {
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject:  "paprika-api-server",
		Audience: observabilityTokenAudience,
		Issuer:   s.observabilityGatewayIssuer,
		Scope:    observabilityScopeObserve,
		TTL:      observabilityUsageTokenTTL,
		Secret:   s.observabilityGatewayTokenSecret,
	})
	if err != nil {
		return fmt.Errorf("mint observability gateway token: %w", err)
	}

	var reader io.Reader
	if body != nil {
		encoded, marshalErr := json.Marshal(body)
		if marshalErr != nil {
			return fmt.Errorf("encode observability gateway request: %w", marshalErr)
		}
		reader = bytes.NewReader(encoded)
	}

	url := strings.TrimRight(s.observabilityGatewayAddr, "/") + path
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return fmt.Errorf("build observability gateway request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	httpClient := &http.Client{Transport: httpx.ConnectTransport(s.observabilityGatewayAddr)}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("call observability gateway: %w", err)
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // response body drain/close is best-effort on the read path
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("observability gateway answered %d", resp.StatusCode)
	}

	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode observability gateway response: %w", err)
	}
	return nil
}
