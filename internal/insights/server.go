package insights

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	crmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"
)

type Config struct {
	Providers []ProviderConfig `json:"providers"`
	// ObservabilityURL enables the shared, caller-authorized provider catalog.
	ObservabilityURL string `json:"observabilityUrl,omitempty"`
	// Token authenticates Paprika's API proxy to this service. Never expose it
	// to browsers. InsecureDev is exclusively for a loopback development server.
	Token       string `json:"-"`
	InsecureDev bool   `json:"-"`
}

type Server struct {
	store        *Store
	providers    *providerRegistry
	savedQueries *savedQueryStore
	observe      *observeGateway
	// Serialize persistent mutations across stores so reference checks and the
	// corresponding deletion/type change observe a consistent snapshot.
	mutations     sync.Mutex
	tokenHash     [32]byte
	insecureDev   bool
	queries       chan struct{}
	queryCount    metric.Int64Counter
	queryDuration metric.Float64Histogram
}

func NewServer(config Config, store *Store) (*Server, error) {
	if err := validateServerConfig(&config, store); err != nil {
		return nil, err
	}
	registry, err := openProviderRegistry(store.dir, config.Providers)
	if err != nil {
		return nil, err
	}
	observe, err := newObserveGateway(config.ObservabilityURL)
	if err != nil {
		return nil, err
	}
	if validateErr := validateProviderIDs(registry, observe); validateErr != nil {
		return nil, validateErr
	}
	savedQueries, err := openSavedQueryStore(store.dir)
	if err != nil {
		return nil, err
	}
	s := &Server{store: store, providers: registry, savedQueries: savedQueries, observe: observe, tokenHash: sha256.Sum256([]byte(config.Token)), insecureDev: config.InsecureDev, queries: make(chan struct{}, 16)}
	s.queryCount, err = otel.Meter("paprika").Int64Counter("paprika_insights_queries", metric.WithDescription("Provider queries by outcome"))
	if err != nil {
		return nil, fmt.Errorf("create query counter: %w", err)
	}
	s.queryDuration, err = otel.Meter("paprika").Float64Histogram("paprika_insights_query_duration_seconds", metric.WithUnit("s"), metric.WithDescription("Provider query duration"))
	if err != nil {
		return nil, fmt.Errorf("create query duration histogram: %w", err)
	}
	return s, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(crmetrics.Registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "ready"}) })
	api := http.NewServeMux()
	api.HandleFunc("GET /api/providers", s.listProviders)
	api.HandleFunc("GET /api/provider-configs", s.listProviderConfigs)
	api.HandleFunc("PUT /api/provider-configs/{id}", s.putProviderConfig)
	api.HandleFunc("DELETE /api/provider-configs/{id}", s.deleteProviderConfig)
	api.HandleFunc("POST /api/providers/{id}/test", s.testProvider)
	api.HandleFunc("GET /api/providers/{id}/metadata", s.providerMetadata)
	api.HandleFunc("POST /api/query", s.query)
	api.HandleFunc("GET /api/saved-queries", s.listSavedQueries)
	api.HandleFunc("GET /api/saved-queries/{id}", s.getSavedQuery)
	api.HandleFunc("PUT /api/saved-queries/{id}", s.putSavedQuery)
	api.HandleFunc("DELETE /api/saved-queries/{id}", s.deleteSavedQuery)
	api.HandleFunc("GET /api/dashboards", s.listDashboards)
	api.HandleFunc("GET /api/dashboards/{id}", s.getDashboard)
	api.HandleFunc("PUT /api/dashboards/{id}", s.putDashboard)
	api.HandleFunc("DELETE /api/dashboards/{id}", s.deleteDashboard)
	mux.Handle("/api/", s.authenticate(api))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.insecureDev {
			header := r.Header.Get("Authorization")
			if !strings.HasPrefix(header, "Bearer ") {
				writeError(w, 401, "service authentication required")
				return
			}
			hash := sha256.Sum256([]byte(strings.TrimPrefix(header, "Bearer ")))
			if subtle.ConstantTimeCompare(hash[:], s.tokenHash[:]) != 1 {
				writeError(w, 401, "service authentication required")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) query(w http.ResponseWriter, r *http.Request) {
	var q Query
	if err := decodeBody(w, r, &q, 32<<10); err != nil {
		writeError(w, 400, "invalid query request")
		return
	}
	if err := validateQuery(q); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	p, err := s.resolveProvider(r, q.ProviderID)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	if p.public.Capabilities[0] != q.Kind {
		writeError(w, 400, "provider does not support this query kind")
		return
	}
	select {
	case s.queries <- struct{}{}:
		defer func() { <-s.queries }()
	default:
		w.Header().Set("Retry-After", "1")
		writeError(w, 429, "too many active queries; retry shortly")
		return
	}
	started := time.Now()
	result, err := p.query(r.Context(), q)
	outcome := "success"
	if err != nil {
		outcome = "error"
	}
	attributes := metric.WithAttributes(attribute.String("provider", q.ProviderID), attribute.String("kind", q.Kind), attribute.String("outcome", outcome))
	s.queryCount.Add(r.Context(), 1, attributes)
	s.queryDuration.Record(r.Context(), time.Since(started).Seconds(), attributes)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (s *Server) getDashboard(w http.ResponseWriter, r *http.Request) {
	doc, tag, err := s.store.Get(r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	setDocumentETag(w, tag)
	if matchesReadETag(r.Header.Get("If-None-Match"), tag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, 200, doc)
}

func (s *Server) putDashboard(w http.ResponseWriter, r *http.Request) {
	var doc json.RawMessage
	if err := decodeBody(w, r, &doc, maxDocumentBytes); err != nil {
		writeError(w, 400, "invalid dashboard document")
		return
	}
	if err := validateDashboard(r.PathValue("id"), doc); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	s.mutations.Lock()
	defer s.mutations.Unlock()
	tag, err := s.store.Put(r.PathValue("id"), doc, r.Header.Get("If-Match"), r.Header.Get("If-None-Match"))
	if err != nil {
		storeError(w, err)
		return
	}
	setDocumentETag(w, tag)
	writeJSON(w, 200, doc)
}

func (s *Server) deleteDashboard(w http.ResponseWriter, r *http.Request) {
	s.mutations.Lock()
	defer s.mutations.Unlock()
	if err := s.store.Delete(r.PathValue("id"), r.Header.Get("If-Match")); err != nil {
		storeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	defer closeReadBody(r.Body)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(v); err != nil {
		return fmt.Errorf("decode request body: %w", err)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("request must contain one JSON value")
	}
	return nil
}

func storeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		writeError(w, 404, err.Error())
	case errors.Is(err, ErrConflict):
		writeError(w, 412, err.Error())
	case errors.Is(err, ErrCapacity):
		writeError(w, 507, err.Error())
	default:
		writeError(w, 500, "dashboard storage operation failed")
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Debug("could not write insights JSON response")
	}
}

func closeReadBody(body io.Closer) {
	if err := body.Close(); err != nil {
		slog.Debug("could not close insights request or response body")
	}
}

func validateProviderIDs(registry *providerRegistry, observe *observeGateway) error {
	if observe == nil {
		return nil
	}
	for _, provider := range registry.list() {
		if strings.HasPrefix(provider.ID, observeProviderPrefix) {
			return errors.New("local provider ids beginning with observe- are reserved for shared observability providers")
		}
	}
	return nil
}

func validateServerConfig(config *Config, store *Store) error {
	if store == nil {
		return errors.New("dashboard store is required")
	}
	if !config.InsecureDev && len(config.Token) < 32 {
		return errors.New("PAPRIKA_INSIGHTS_TOKEN must contain at least 32 characters")
	}
	if len(config.Providers) > 32 {
		return errors.New("at most 32 providers may be configured")
	}
	return nil
}
