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
)

const observeProviderPrefix = "observe-"

// The service token and delegated caller token are deliberately independent.
// Only the latter is sent to the gateway; no process-level identity can stand
// in for a caller whose provider permissions have been removed.
const observeTokenHeader = "X-Paprika-Observe-Token" //nolint:gosec // Header name, not a credential value.

type observeGateway struct {
	baseURL *url.URL
	client  *http.Client
}

type observeProvider struct {
	gateway   *observeGateway
	token     string
	reference string
}

type observeError struct {
	status  int
	message string
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
	transport.MaxIdleConnsPerHost = 8
	transport.ResponseHeaderTimeout = 15 * time.Second
	return &observeGateway{baseURL: u, client: &http.Client{
		Transport: transport, Timeout: 20 * time.Second,
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
		return "", &observeError{http.StatusForbidden, "caller authorization is required for shared observability providers"}
	}
	return token, nil
}

func (s *Server) listProviders(w http.ResponseWriter, r *http.Request) {
	providers := s.providers.list()
	if s.observe != nil {
		token, err := delegatedObserveToken(r)
		if err != nil {
			writeProviderError(w, err)
			return
		}
		shared, err := s.observe.providers(r.Context(), token)
		if err != nil {
			writeProviderError(w, err)
			return
		}
		providers = append(providers, shared...)
	}
	sort.Slice(providers, func(i, j int) bool { return providers[i].ID < providers[j].ID })
	writeJSON(w, http.StatusOK, map[string]any{"providers": providers})
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

func (g *observeGateway) providers(ctx context.Context, token string) ([]Provider, error) {
	connection, err := g.connect(ctx, token)
	if err != nil {
		return nil, err
	}
	defer connection.close()
	return connection.providers()
}

func (c *observeMCPConnection) providers() ([]Provider, error) {
	body, failed, err := c.call("list_observability_providers", map[string]any{}, 1<<20)
	if err != nil {
		return nil, err
	}
	catalog, err := decodeObserveCatalog(body, failed)
	if err != nil {
		return nil, err
	}
	result := make([]Provider, 0, len(catalog))
	seen := make(map[string]bool)
	for _, p := range catalog {
		capabilities := observeCapabilities(p.Type)
		if len(capabilities) == 0 {
			continue
		}
		if !validObserveCatalogProvider(p) || seen[p.Name] {
			return nil, errUpstream
		}
		seen[p.Name] = true
		for _, capability := range capabilities {
			if err := c.requireTool("query_" + capability); err != nil {
				return nil, err
			}
		}
		result = append(result, Provider{ID: observeProviderID(p.Name), Name: p.Name, Type: p.Type, Capabilities: capabilities, Source: "observability", ProviderRef: p.Name, Transport: "mcp"})
	}
	return result, nil
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
		return &observeError{http.StatusForbidden, "shared observability provider access denied"}
	case http.StatusNotFound:
		return ErrNotFound
	case http.StatusBadRequest:
		return &observeError{http.StatusBadRequest, "observability gateway rejected the provider request"}
	case http.StatusTooManyRequests:
		return &observeError{http.StatusTooManyRequests, "too many active observability requests; retry shortly"}
	case http.StatusGatewayTimeout:
		return &observeError{http.StatusGatewayTimeout, "observability gateway request timed out"}
	default:
		return &observeError{http.StatusBadGateway, "observability gateway is unavailable"}
	}
}

func (p *observeProvider) data(ctx context.Context, tool string, request any, limit int64) ([]byte, error) {
	connection, err := p.gateway.connect(ctx, p.token)
	if err != nil {
		return nil, err
	}
	defer connection.close()
	body, failed, err := connection.call(tool, request, maxResponseBytes)
	if err != nil {
		return nil, err
	}
	return decodeObserveData(body, failed, limit)
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
		return nil, &observeError{http.StatusForbidden, "observability provider refused the configured credentials"}
	case "NotConfigured":
		return nil, &observeError{http.StatusServiceUnavailable, "observability provider is not configured"}
	case "NotAvailable":
		return nil, &observeError{http.StatusServiceUnavailable, "observability provider does not support this request"}
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

func (p *observeProvider) query(ctx context.Context, q Query) ([]byte, error) {
	input := map[string]any{"provider": p.reference, "query": q.Query, "start": observeTime(q.Start), "end": observeTime(q.End)}
	switch q.Kind {
	case "metrics":
		input["step_seconds"] = q.Step
		input["limit"] = maxSeries
	case "records":
		input["limit"] = 1000
	default:
		input["limit"] = maxTraces
	}
	tool := "query_" + q.Kind
	return p.data(ctx, tool, input, maxResponseBytes)
}

// Adapt the existing bounded native metadata decoders to the gateway's typed
// exploration API. No arbitrary upstream URL or credential is ever accepted.
func (p *observeProvider) metadata(ctx context.Context, path string, params url.Values, limit int64) ([]byte, error) {
	input := map[string]any{"provider": p.reference, "limit": maxMetadataValues}
	if err := setObserveMetadataKind(input, path); err != nil {
		return nil, err
	}
	if metricName := params.Get("match[]"); metricName != "" {
		input["metric"] = metricName
	}
	for _, key := range []string{"start", "end"} {
		seconds, err := strconv.ParseInt(params.Get(key), 10, 64)
		if err != nil {
			return nil, errUpstream
		}
		input[key] = time.Unix(seconds, 0).UTC().Format(time.RFC3339)
	}
	kind, ok := input["kind"].(string)
	if !ok {
		return nil, errUpstream
	}
	tool := "list_" + kind
	delete(input, "kind")
	return p.data(ctx, tool, input, limit)
}

func writeProviderError(w http.ResponseWriter, err error) {
	var remoteErr *observeError
	switch {
	case errors.As(err, &remoteErr):
		if remoteErr.status == http.StatusTooManyRequests {
			w.Header().Set("Retry-After", "1")
		}
		writeError(w, remoteErr.status, remoteErr.message)
	case errors.Is(err, ErrNotFound):
		writeError(w, http.StatusNotFound, "provider not found")
	default:
		writeError(w, http.StatusBadGateway, errUpstream.Error())
	}
}

func validObserveCatalogProvider(p observeCatalogProvider) bool {
	parts := strings.Split(p.Name, "/")
	return len(parts) == 2 && parts[0] == p.Namespace && parts[0] != "" && parts[1] != "" && len(p.Name) <= 320 && !strings.ContainsAny(p.Name, "\r\n\x00")
}

func setObserveMetadataKind(input map[string]any, path string) error {
	switch {
	case path == "/api/v1/label/__name__/values":
		input["kind"] = "metric_names"
	case path == "/api/v1/labels" || path == "/api/search/tags":
		input["kind"] = "label_names"
	case path == "/api/v1/series":
		input["kind"] = "metric_series"
	case strings.HasPrefix(path, "/api/v1/label/") && strings.HasSuffix(path, "/values"):
		input["kind"] = "label_values"
		input["label"] = strings.TrimSuffix(strings.TrimPrefix(path, "/api/v1/label/"), "/values")
	case strings.HasPrefix(path, "/api/search/tag/") && strings.HasSuffix(path, "/values"):
		input["kind"] = "label_values"
		input["label"] = strings.TrimSuffix(strings.TrimPrefix(path, "/api/search/tag/"), "/values")
	default:
		return errUpstream
	}
	return nil
}
