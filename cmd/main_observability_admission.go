package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

const maxObserveCatalogEnvelopeBytes = 4 << 10

// Dashboard arguments are capped at 32 KiB; leave a bounded allowance for the
// JSON-RPC envelope so valid large variable overrides retain orchestration slots.
const maxObserveDashboardEnvelopeBytes = (32 + 4) << 10

type observabilityRequestClass uint8

const (
	observabilityWorkRequest observabilityRequestClass = iota
	observabilityCatalogRequest
	observabilityDashboardRequest
)

func isObservabilityProtocolRequest(r *http.Request) bool {
	switch r.URL.Path {
	case observabilityGatewayRoutePrefix + "/mcp",
		observabilityGatewayRoutePrefix + "/api/providers",
		observabilityGatewayRoutePrefix + "/api/query",
		observabilityGatewayRoutePrefix + "/api/explore":
		return true
	default:
		return false
	}
}

// An authoring tool re-enters provider discovery through Insights. Its nested
// MCP handshake and provider listing need the same bounded catalog reserve as
// REST discovery. Only exact read/control methods qualify; tool arguments or
// client-supplied headers cannot move query or write tools into this pool.
func isObservabilityCatalogRequest(r *http.Request) bool {
	if r.URL.Path == observabilityGatewayRoutePrefix+"/api/providers" {
		return r.Method == http.MethodGet
	}
	if !canInspectObservabilityEnvelope(r, maxObserveCatalogEnvelopeBytes) {
		return false
	}
	prefix, ok := readObservabilityEnvelope(r, maxObserveCatalogEnvelopeBytes)
	return ok && isObservabilityCatalogEnvelope(prefix)
}

// A dashboard query re-enters MCP data tools through Insights. It cannot hold a
// data-work slot while waiting for another data-work slot from the same pool.
// Classification is bounded, exact-key and leaves the SDK the original body.
func classifyObservabilityProtocolRequest(r *http.Request) observabilityRequestClass {
	if r.URL.Path == observabilityGatewayRoutePrefix+"/api/providers" && r.Method == http.MethodGet {
		return observabilityCatalogRequest
	}
	if !canInspectObservabilityEnvelope(r, maxObserveDashboardEnvelopeBytes) {
		return observabilityWorkRequest
	}
	prefix, ok := readObservabilityEnvelope(r, maxObserveDashboardEnvelopeBytes)
	if !ok {
		return observabilityWorkRequest
	}
	if len(prefix) <= maxObserveCatalogEnvelopeBytes && isObservabilityCatalogEnvelope(prefix) {
		return observabilityCatalogRequest
	}
	if isObservabilityDashboardEnvelope(prefix) {
		return observabilityDashboardRequest
	}
	return observabilityWorkRequest
}

func canInspectObservabilityEnvelope(r *http.Request, limit int64) bool {
	return r.URL.Path == observabilityGatewayRoutePrefix+"/mcp" && r.Method == http.MethodPost && r.Body != nil && r.ContentLength <= limit
}

func readObservabilityEnvelope(r *http.Request, limit int) ([]byte, bool) {
	original := r.Body
	prefix, err := io.ReadAll(io.LimitReader(original, int64(limit)+1))
	var remainder io.Reader = original
	if err != nil {
		// A one-shot upload error must reach the SDK as well. Replaying only
		// bytes could turn an incomplete upload into a successful tool call.
		remainder = observabilityBodyError{err: err}
	}
	r.Body = struct {
		io.Reader
		io.Closer
	}{Reader: io.MultiReader(bytes.NewReader(prefix), remainder), Closer: original}
	return prefix, err == nil && len(prefix) <= limit
}

func isObservabilityDashboardEnvelope(body []byte) bool {
	var envelope map[string]json.RawMessage
	var version, method, name string
	var params map[string]json.RawMessage
	return json.Unmarshal(body, &envelope) == nil &&
		json.Unmarshal(envelope["jsonrpc"], &version) == nil && version == "2.0" &&
		json.Unmarshal(envelope["method"], &method) == nil && method == "tools/call" &&
		json.Unmarshal(envelope["params"], &params) == nil &&
		json.Unmarshal(params["name"], &name) == nil && name == "query_dashboard"
}

type observabilityBodyError struct{ err error }

func (r observabilityBodyError) Read([]byte) (int, error) { return 0, r.err }

func isObservabilityCatalogEnvelope(body []byte) bool {
	// Match the SDK's case-sensitive JSON field decoding. A struct decoded by
	// encoding/json accepts "Method" and "Name", which could classify a query
	// differently from the SDK and let it consume the reserved catalog pool.
	var envelope map[string]json.RawMessage
	if json.Unmarshal(body, &envelope) != nil {
		return false
	}
	var version, method string
	if json.Unmarshal(envelope["jsonrpc"], &version) != nil || version != "2.0" || json.Unmarshal(envelope["method"], &method) != nil {
		return false
	}
	switch method {
	case "initialize", "server/discover", "notifications/initialized", "tools/list":
		return true
	case "tools/call":
		var params map[string]json.RawMessage
		var name string
		return json.Unmarshal(envelope["params"], &params) == nil && json.Unmarshal(params["name"], &name) == nil && name == "list_observability_providers"
	default:
		return false
	}
}

// observabilityHTTPPools are the gateway's HTTP admission pools. Each count is
// a slot limit. AdmissionWait is the one deadline a request has to get through
// intake and its pool, measured from the moment the handler starts.
type observabilityHTTPPools struct {
	Work       int
	Catalog    int
	Dashboards int
	Intake     int
	// WorkWaiters caps how many data requests may wait at the edge for a work
	// slot. It equals the execution budget's queue, so a burst the budget can
	// hold (concurrency + queue) is admitted at the edge rather than refused
	// there before the budget sees it.
	WorkWaiters   int
	AdmissionWait time.Duration
}

// defaultObservabilityHTTPPools are the built-in pool sizes, the same values
// resolveObservabilityCapacity derives from the default execution budget. The
// zero wait keeps the historical fail-fast behaviour for callers that do not
// pass a configured set.
func defaultObservabilityHTTPPools() observabilityHTTPPools {
	return observabilityHTTPPools{Work: 4, Catalog: 4, Dashboards: 2, Intake: 8, WorkWaiters: 32}
}

// observabilityAdmissionPool is a bounded slot pool with its own bounded waiter
// queue, the same shape as the execution budget's providerWorkSlots. Each pool
// bounds its own waiters, so a saturated pool cannot fill a queue another pool
// needs.
type observabilityAdmissionPool struct {
	slots   chan struct{}
	waiting chan struct{}
}

// newObservabilityAdmissionPool allows size running requests and up to waiters
// waiting ones. A waiter beyond that is rejected at once.
func newObservabilityAdmissionPool(size, waiters int) observabilityAdmissionPool {
	return observabilityAdmissionPool{slots: make(chan struct{}, size), waiting: make(chan struct{}, waiters)}
}

// acquire takes a slot. If none is free it waits until ctx ends, provided fewer
// than size requests are already waiting on this pool.
func (p observabilityAdmissionPool) acquire(ctx context.Context) bool {
	select {
	case p.slots <- struct{}{}:
		return true
	default:
	}
	if ctx.Err() != nil {
		return false
	}
	select {
	case p.waiting <- struct{}{}:
	default:
		return false
	}
	defer func() { <-p.waiting }()
	select {
	case p.slots <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func (p observabilityAdmissionPool) release() { <-p.slots }

// rejectObservabilityAdmission answers a request that did not get a slot:
// 429 with Retry-After: 1 and no-store, as before.
func rejectObservabilityAdmission(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, "observability gateway is at its request limit; retry later", http.StatusTooManyRequests)
}
