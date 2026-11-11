package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/benebsworth/paprika/internal/observabilitygateway"
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

// isObservabilityDashboardEnvelope recognises the orchestration tools: the ones
// that run nested data requests through this gateway's own work pool.
func isObservabilityDashboardEnvelope(body []byte) bool {
	var envelope map[string]json.RawMessage
	var version, method, name string
	var params map[string]json.RawMessage
	return json.Unmarshal(body, &envelope) == nil &&
		json.Unmarshal(envelope["jsonrpc"], &version) == nil && version == "2.0" &&
		json.Unmarshal(envelope["method"], &method) == nil && method == "tools/call" &&
		json.Unmarshal(envelope["params"], &params) == nil &&
		json.Unmarshal(params["name"], &name) == nil && (name == "query_dashboard" || name == "render_dashboard")
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

// observabilityEdge is the gateway's HTTP admission. Four pools guard it:
//
//   - intake is held only while a request body is read and the request is
//     classified, then released before the class's pool wait. Its waiters cover
//     every request the pools can hold, so intake refuses only a request that
//     arrives while intake and all pool capacity are already taken.
//   - work holds MCP data-tool requests. Its waiters equal the budget queue.
//   - catalog holds discovery and handshakes, and dashboards holds orchestration
//     (query_dashboard and render_dashboard), whose nested data requests need the
//     work pool. Neither waits behind data requests.
//
// Each request has one deadline, AdmissionWait from the start of the handler,
// shared by its intake and pool waits.
type observabilityEdge struct {
	wait       time.Duration
	intake     observabilityAdmissionPool
	work       observabilityAdmissionPool
	catalog    observabilityAdmissionPool
	dashboards observabilityAdmissionPool
}

func newObservabilityEdge(pools observabilityHTTPPools) *observabilityEdge {
	// Intake waiters cover every request the pools can hold: the work pool and
	// its waiters, plus catalog and dashboards each with waiters equal to size.
	intakeWaiters := pools.Work + pools.WorkWaiters + 2*pools.Catalog + 2*pools.Dashboards
	return &observabilityEdge{
		wait:       pools.AdmissionWait,
		intake:     newObservabilityAdmissionPool(pools.Intake, intakeWaiters),
		work:       newObservabilityAdmissionPool(pools.Work, pools.WorkWaiters),
		catalog:    newObservabilityAdmissionPool(pools.Catalog, pools.Catalog),
		dashboards: newObservabilityAdmissionPool(pools.Dashboards, pools.Dashboards),
	}
}

// classify reads and classifies a protocol request while holding an intake slot.
// The bounded body is read to its end, so the server watches the connection for
// a departed client before the request waits for its pool. REST POST bodies are
// read the same way.
func (e *observabilityEdge) classify(ctx context.Context, r *http.Request) (observabilityRequestClass, bool) {
	if !e.intake.acquire(ctx) {
		return 0, false
	}
	defer e.intake.release()
	if r.URL.Path != observabilityGatewayRoutePrefix+"/mcp" && r.Method == http.MethodPost && r.Body != nil {
		_, _ = readObservabilityEnvelope(r, maxObserveDashboardEnvelopeBytes)
	}
	return classifyObservabilityProtocolRequest(r), true
}

func (e *observabilityEdge) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isObservabilityProtocolRequest(r) {
			next.ServeHTTP(w, r)
			return
		}
		admitCtx, cancel := context.WithTimeout(r.Context(), e.wait)
		defer cancel()
		requestClass, ok := e.classify(admitCtx, r)
		if !ok {
			rejectObservabilityAdmission(w)
			return
		}
		pool := e.work
		switch requestClass {
		case observabilityCatalogRequest:
			pool = e.catalog
		case observabilityDashboardRequest:
			pool = e.dashboards
		case observabilityWorkRequest:
		}
		if !pool.acquire(admitCtx) {
			rejectObservabilityAdmission(w)
			return
		}
		defer pool.release()
		// Oversized or unclassifiable envelopes may still contain valid small
		// orchestration arguments. They must not run nested work while holding a
		// data-work slot; the tools check this trusted context marker.
		r = r.WithContext(observabilitygateway.WithDashboardQueryAdmission(r.Context(), requestClass == observabilityDashboardRequest))
		next.ServeHTTP(w, r)
	})
}
