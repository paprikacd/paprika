package insights

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/benebsworth/paprika/internal/capacityhint"
)

const observeProviderPrefix = "observe-"

// The service token and delegated caller token are deliberately independent.
// Only the latter is sent to the gateway; no process-level identity can stand
// in for a caller whose provider permissions have been removed.
const observeTokenHeader = "X-Paprika-Observe-Token" //nolint:gosec // Header name, not a credential value.

type observeGateway struct {
	baseURL  *url.URL
	client   *http.Client
	timeouts observeTimeouts
}

type observeProvider struct {
	gateway   *observeGateway
	token     string
	reference string
}

type observeError struct {
	status  int
	message string
	// retryAfter is the gateway's Retry-After in seconds for a 429, or zero when
	// the gateway gave none.
	retryAfter int
}

func (e *observeError) Error() string { return e.message }

type observeCatalogProvider struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Type      string `json:"type"`
}

type observeResponse struct {
	State string          `json:"state"`
	Data  json.RawMessage `json:"data"`
}

func newObserveGateway(rawURL string) (*observeGateway, error) {
	if rawURL == "" {
		return nil, nil
	}
	u, err := url.Parse(rawURL)
	if err != nil || len(rawURL) > 2048 || !validProviderBaseURL(u) {
		return nil, errors.New("observability URL requires HTTP(S) without credentials, query, or fragment")
	}
	transport, err := providerTransport()
	if err != nil {
		return nil, err
	}
	transport.MaxIdleConnsPerHost = defaultObserveIdleConnsPerHost
	// Header and client waits equal the per-operation bound, so a read the gateway
	// is still running is not abandoned early. The uptime connector allows 20 s
	// per read; each call's deadline, min(operation, remaining budget), ends it.
	transport.ResponseHeaderTimeout = defaultObserveTimeouts.operation
	return &observeGateway{baseURL: u, timeouts: defaultObserveTimeouts, client: &http.Client{
		Transport: transport, Timeout: defaultObserveTimeouts.operation,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func observeProviderID(reference string) string {
	digest := sha256.Sum256([]byte(reference))
	return observeProviderPrefix + hex.EncodeToString(digest[:])
}

func delegatedObserveToken(r *http.Request) (string, error) {
	token := r.Header.Get(observeTokenHeader)
	if token == "" || len(token) > 32<<10 || strings.TrimSpace(token) != token || strings.ContainsAny(token, "\r\n") {
		return "", &observeError{http.StatusForbidden, "caller authorization is required for shared observability providers", 0}
	}
	return token, nil
}

// sharedCatalogFailure reports why the shared catalog is missing from a listing
// that still carries the local providers. Status is busy, forbidden or
// unavailable; Code is the HTTP status Insights would otherwise have returned.
type sharedCatalogFailure struct {
	Status  string `json:"status"`
	Code    int    `json:"code"`
	Message string `json:"message"`
	// RetryAfter is the seconds a busy listing should wait before a replay: the
	// gateway's Retry-After when it sent one, otherwise a one-second default.
	RetryAfter int `json:"retryAfter,omitempty"`
}

// defaultSharedRetryAfter is used when the gateway gives no Retry-After.
const defaultSharedRetryAfter = 1

// sharedCatalogFailureFor classifies a failed listing. A busy listing without a
// gateway delay takes fallback, the catalog pool's estimate (at least one second).
func sharedCatalogFailureFor(err error, fallback int) *sharedCatalogFailure {
	failure := &sharedCatalogFailure{Code: http.StatusBadGateway, Message: errUpstream.Error()}
	var remote *observeError
	switch {
	case errors.As(err, &remote):
		failure.Code, failure.Message = remote.status, remote.message
		failure.RetryAfter = remote.retryAfter
	case errors.Is(err, ErrNotFound):
		failure.Code, failure.Message = http.StatusNotFound, "provider not found"
	case errors.Is(err, context.DeadlineExceeded):
		// The listing's own request budget ended the call, not the gateway's operation cap.
		failure.Code, failure.Message = http.StatusGatewayTimeout, "request exceeded its time budget"
	}
	switch failure.Code {
	case http.StatusTooManyRequests:
		failure.Status = "busy"
		if failure.RetryAfter == 0 {
			failure.RetryAfter = max(fallback, defaultSharedRetryAfter)
		}
	case http.StatusForbidden:
		failure.Status = "forbidden"
	default:
		failure.Status = "unavailable"
	}
	return failure
}

// defaultObserveIdleConnsPerHost is the idle connection pool to the gateway
// before NewServer sizes it from the admission capacity.
const defaultObserveIdleConnsPerHost = 8

// idleConnsPerHost sizes the idle connections kept to the gateway.
func (g *observeGateway) idleConnsPerHost(n int) {
	if transport, ok := g.client.Transport.(*http.Transport); ok {
		transport.MaxIdleConnsPerHost = n
	}
}

// observeHTTPErrorFor maps a gateway HTTP status and its Retry-After header.
// Only a whole-second delay between 1 and capacityhint.MaxSeconds is kept, so a
// forwarded hint stays inside the browser's replay cap. Anything else is ignored.
func observeHTTPErrorFor(status int, retryAfter string) error {
	err := observeHTTPError(status)
	var remote *observeError
	if errors.As(err, &remote) && status == http.StatusTooManyRequests {
		if seconds, parseErr := strconv.Atoi(strings.TrimSpace(retryAfter)); parseErr == nil && seconds >= capacityhint.MinSeconds && seconds <= capacityhint.MaxSeconds {
			remote.retryAfter = seconds
		}
	}
	return err
}

// listProviders always returns the local providers. A shared-catalog failure
// does not fail the listing: it is reported in sharedCatalog, so local tiles
// keep working while the client explains the shared ones. A missing delegation
// is still a whole-request failure, because no shared listing is possible.
func (s *Server) listProviders(w http.ResponseWriter, r *http.Request) {
	providers := s.providers.list()
	var sharedFailure *sharedCatalogFailure
	if s.observe != nil {
		token, err := delegatedObserveToken(r)
		if err != nil {
			writeProviderError(w, err)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), s.observe.timeouts.providers)
		shared, err := s.observe.providers(ctx, token)
		cancel()
		if err != nil {
			sharedFailure = sharedCatalogFailureFor(err, s.catalogRetryAfter())
		}
		providers = append(providers, shared...)
	}
	sort.Slice(providers, func(i, j int) bool { return providers[i].ID < providers[j].ID })
	body := map[string]any{"providers": providers}
	if sharedFailure != nil {
		body["sharedCatalog"] = sharedFailure
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) resolveProvider(r *http.Request, id string) (*providerClient, error) {
	if s.observe == nil || !strings.HasPrefix(id, observeProviderPrefix) {
		p, ok := s.providers.get(id)
		if !ok {
			return nil, ErrNotFound
		}
		return p, nil
	}
	token, err := delegatedObserveToken(r)
	if err != nil {
		return nil, err
	}
	providers, err := s.observe.providers(r.Context(), token)
	if err != nil {
		return nil, err
	}
	for i := range providers {
		provider := &providers[i]
		if provider.ID == id {
			// A request-local client keeps its metadata cache scoped to this exact
			// authorization check. Never retain delegated tokens in a registry.
			return &providerClient{public: *provider, metadataCache: make(map[string]metadataCacheEntry), remote: &observeProvider{
				gateway: s.observe, token: token, reference: provider.ProviderRef,
			}}, nil
		}
	}
	return nil, ErrNotFound
}

// providers lists the caller's shared catalog over REST. Within one request the
// outcome, success or failure, is memoized, so a dashboard lists its catalog
// once. A request without a scope lists without memoizing.
func (g *observeGateway) providers(ctx context.Context, token string) ([]Provider, error) {
	scope := observeScopeFor(ctx, token)
	if scope == nil {
		return g.listShared(ctx, token)
	}
	scope.mu.Lock()
	defer scope.mu.Unlock()
	if !scope.catalogLoaded {
		scope.catalogLoaded = true
		scope.catalog, scope.catalogErr = g.listShared(ctx, token)
	}
	return scope.catalog, scope.catalogErr
}

// providers counts the shared catalog over MCP for the Data sources status. It
// also requires every data tool the catalog's providers need.
func (c *observeMCPConnection) providers(ctx context.Context) ([]Provider, error) {
	body, failed, err := c.call(ctx, "list_observability_providers", map[string]any{}, 1<<20)
	if err != nil {
		return nil, err
	}
	catalog, err := decodeObserveCatalog(body, failed)
	if err != nil {
		return nil, err
	}
	for _, p := range catalog {
		for _, capability := range observeCapabilities(p.Type) {
			if err := c.requireTool("query_" + capability); err != nil {
				return nil, err
			}
		}
	}
	return sharedProvidersFromCatalog(catalog)
}

func observeCapabilities(providerType string) []string {
	switch providerType {
	case "prometheus":
		return []string{"metrics"}
	case "tempo":
		return []string{"traces"}
	case "shorted", "uptime", "postgresql":
		return []string{"metrics", "records"}
	default:
		return nil
	}
}

func decodeObserveCatalog(body []byte, failed bool) ([]observeCatalogProvider, error) {
	var response struct {
		Providers []observeCatalogProvider `json:"providers"`
	}
	if failed || json.Unmarshal(body, &response) != nil || response.Providers == nil {
		return nil, errUpstream
	}
	return response.Providers, nil
}

func observeHTTPError(status int) error {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return &observeError{http.StatusForbidden, "shared observability provider access denied", 0}
	case http.StatusNotFound:
		return ErrNotFound
	case http.StatusBadRequest:
		return &observeError{http.StatusBadRequest, "observability gateway rejected the provider request", 0}
	case http.StatusTooManyRequests:
		return &observeError{http.StatusTooManyRequests, "too many active observability requests; retry shortly", 0}
	case http.StatusGatewayTimeout:
		return &observeError{http.StatusGatewayTimeout, "observability gateway request timed out", 0}
	default:
		return &observeError{http.StatusBadGateway, "observability gateway is unavailable", 0}
	}
}

// data is one REST data call. Its body is decoded and checked exactly as the
// MCP tool result was.
func (p *observeProvider) data(ctx context.Context, path string, request any, limit int64, measurement *queryMeasurement) ([]byte, error) {
	body, err := p.gateway.restDo(ctx, p.token, path, request, limit, measurement)
	if err != nil {
		return nil, err
	}
	return decodeObserveData(body, false, limit)
}

func decodeObserveData(body []byte, failed bool, limit int64) ([]byte, error) {
	var response observeResponse
	if json.Unmarshal(body, &response) != nil {
		return nil, errUpstream
	}
	switch response.State {
	case "OK":
		if !validObserveData(response.Data, failed, limit) {
			return nil, errUpstream
		}
		return response.Data, nil
	case "Forbidden":
		return nil, &observeError{http.StatusForbidden, "observability provider refused the configured credentials", 0}
	case "NotConfigured":
		return nil, &observeError{http.StatusServiceUnavailable, "observability provider is not configured", 0}
	case "NotAvailable":
		return nil, &observeError{http.StatusServiceUnavailable, "observability provider does not support this request", 0}
	default:
		return nil, errUpstream
	}
}

func validObserveData(data []byte, failed bool, limit int64) bool {
	return !failed && int64(len(data)) <= limit && len(data) != 0 && !bytes.Equal(bytes.TrimSpace(data), []byte("null"))
}

func observeTime(seconds float64) string {
	whole := int64(seconds)
	return time.Unix(whole, int64((seconds-float64(whole))*1e9)).UTC().Format(time.RFC3339Nano)
}

func (p *observeProvider) query(ctx context.Context, q *Query, measurement *queryMeasurement) ([]byte, error) {
	return p.data(ctx, observeRESTQueryPath, observeRESTQueryBody(p, q), maxResponseBytes, measurement)
}

// Adapt the existing bounded native metadata decoders to the gateway's typed
// exploration API. No arbitrary upstream URL or credential is ever accepted.
func (p *observeProvider) metadata(ctx context.Context, path string, params url.Values, limit int64) ([]byte, error) {
	input := observeRESTExplore{Provider: p.reference, Limit: maxMetadataValues}
	if err := setObserveMetadataKind(&input, path); err != nil {
		return nil, err
	}
	input.Metric = params.Get("match[]")
	for _, key := range []string{"start", "end"} {
		seconds, err := strconv.ParseInt(params.Get(key), 10, 64)
		if err != nil {
			return nil, errUpstream
		}
		value := time.Unix(seconds, 0).UTC().Format(time.RFC3339)
		if key == "start" {
			input.Start = value
		} else {
			input.End = value
		}
	}
	return p.data(ctx, observeRESTExplorePath, input, limit, nil)
}

// providerErrorResponse maps a failed provider call to its status and fixed
// message. A deadline outside a query names the request's own budget.
func providerErrorResponse(err error) (status int, message string) {
	var remoteErr *observeError
	switch {
	case errors.As(err, &remoteErr):
		return remoteErr.status, remoteErr.message
	case errors.Is(err, ErrNotFound):
		return http.StatusNotFound, "provider not found"
	case errors.Is(err, context.DeadlineExceeded):
		// The request's own deadline, not a provider fault. Query paths name the query.
		return http.StatusGatewayTimeout, "request exceeded its time budget"
	default:
		return http.StatusBadGateway, errUpstream.Error()
	}
}

func writeProviderError(w http.ResponseWriter, err error) {
	status, message := providerErrorResponse(err)
	var remoteErr *observeError
	if errors.As(err, &remoteErr) && status == http.StatusTooManyRequests {
		// Forward the gateway's bounded delay; one second when it sent none.
		retryAfter := remoteErr.retryAfter
		if retryAfter == 0 {
			retryAfter = defaultSharedRetryAfter
		}
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	}
	writeError(w, status, message)
}

func validObserveCatalogProvider(p observeCatalogProvider) bool {
	parts := strings.Split(p.Name, "/")
	return len(parts) == 2 && parts[0] == p.Namespace && parts[0] != "" && parts[1] != "" && len(p.Name) <= 320 && !strings.ContainsAny(p.Name, "\r\n\x00")
}

func setObserveMetadataKind(input *observeRESTExplore, path string) error {
	switch {
	case path == "/api/v1/label/__name__/values":
		input.Kind = "metric_names"
	case path == "/api/v1/labels" || path == "/api/search/tags":
		input.Kind = "label_names"
	case path == "/api/v1/series":
		input.Kind = "metric_series"
	case strings.HasPrefix(path, "/api/v1/label/") && strings.HasSuffix(path, "/values"):
		input.Kind = "label_values"
		input.Label = strings.TrimSuffix(strings.TrimPrefix(path, "/api/v1/label/"), "/values")
	case strings.HasPrefix(path, "/api/search/tag/") && strings.HasSuffix(path, "/values"):
		input.Kind = "label_values"
		input.Label = strings.TrimSuffix(strings.TrimPrefix(path, "/api/search/tag/"), "/values")
	default:
		return errUpstream
	}
	return nil
}
