package insights

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
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
	for _, provider := range providers {
		if provider.ID == id {
			// A request-local client keeps its metadata cache scoped to this exact
			// authorization check. Never retain delegated tokens in a registry.
			return &providerClient{public: provider, metadataCache: make(map[string]metadataCacheEntry), remote: &observeProvider{
				gateway: s.observe, token: token, reference: provider.ProviderRef,
			}}, nil
		}
	}
	return nil, ErrNotFound
}

func (g *observeGateway) providers(ctx context.Context, token string) ([]Provider, error) {
	body, err := g.request(ctx, token, http.MethodGet, "/observe/api/providers", nil, 1<<20)
	if err != nil {
		return nil, err
	}
	var response struct {
		Providers []observeCatalogProvider `json:"providers"`
	}
	if json.Unmarshal(body, &response) != nil || response.Providers == nil {
		return nil, errUpstream
	}
	result := make([]Provider, 0, len(response.Providers))
	seen := make(map[string]bool)
	for _, p := range response.Providers {
		if p.Type != "prometheus" && p.Type != "tempo" {
			continue
		}
		if !validObserveCatalogProvider(p) || seen[p.Name] {
			return nil, errUpstream
		}
		seen[p.Name] = true
		capability := "metrics"
		if p.Type == "tempo" {
			capability = "traces"
		}
		result = append(result, Provider{ID: observeProviderID(p.Name), Name: p.Name, Type: p.Type, Capabilities: []string{capability}, Source: "observability", ProviderRef: p.Name})
	}
	return result, nil
}

func (g *observeGateway) request(ctx context.Context, token, method, path string, data any, limit int64) ([]byte, error) {
	var input []byte
	if data != nil {
		var err error
		input, err = json.Marshal(data)
		if err != nil {
			return nil, errUpstream
		}
	}
	u := *g.baseURL
	u.Path = strings.TrimSuffix(u.Path, "/") + path
	u.RawPath = ""
	// #nosec G704 -- The gateway origin is validated operator configuration; path is internal and redirects are disabled.
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(input))
	if err != nil {
		return nil, errUpstream
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if data != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := g.client.Do(req) // #nosec G704 -- Requests target the configured trusted gateway, with redirects disabled.
	if err != nil {
		return nil, &observeError{http.StatusBadGateway, "observability gateway is unavailable"}
	}
	defer closeReadBody(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, observeHTTPError(resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, errUpstream
	}
	return body, nil
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

func (p *observeProvider) data(ctx context.Context, path string, request any, limit int64) ([]byte, error) {
	body, err := p.gateway.request(ctx, p.token, http.MethodPost, path, request, limit)
	if err != nil {
		return nil, err
	}
	var response observeResponse
	if json.Unmarshal(body, &response) != nil {
		return nil, errUpstream
	}
	switch response.State {
	case "OK":
		if len(response.Data) == 0 || bytes.Equal(bytes.TrimSpace(response.Data), []byte("null")) {
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

func observeTime(seconds float64) string {
	whole := int64(seconds)
	return time.Unix(whole, int64((seconds-float64(whole))*1e9)).UTC().Format(time.RFC3339Nano)
}

func (p *observeProvider) query(ctx context.Context, q Query) ([]byte, error) {
	input := map[string]any{"provider": p.reference, "signal": q.Kind, "query": q.Query, "start": observeTime(q.Start), "end": observeTime(q.End)}
	if q.Kind == "metrics" {
		input["stepSeconds"] = q.Step
		input["limit"] = maxSeries
	} else {
		input["limit"] = maxTraces
	}
	return p.data(ctx, "/observe/api/query", input, maxResponseBytes)
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
	return p.data(ctx, "/observe/api/explore", input, limit)
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
