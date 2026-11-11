package insights

import (
	"context"
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

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
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
	mutations        sync.Mutex
	tokenHash        [32]byte
	insecureDev      bool
	queries          chan struct{}
	queryWaiting     chan struct{}
	queryWaitTimeout time.Duration
	queryCount       metric.Int64Counter
	queryDuration    metric.Float64Histogram
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
	s := &Server{store: store, providers: registry, savedQueries: savedQueries, observe: observe, tokenHash: sha256.Sum256([]byte(config.Token)), insecureDev: config.InsecureDev, queries: make(chan struct{}, 16), queryWaiting: make(chan struct{}, 64), queryWaitTimeout: 2 * time.Second}
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
	api.HandleFunc("GET /api/schemas/{kind}", s.getAuthoringSchema)
	api.HandleFunc("GET /api/observe-connection", s.observeConnection)
	api.HandleFunc("GET /api/provider-configs", s.listProviderConfigs)
	api.HandleFunc("PUT /api/provider-configs/{id}", s.putProviderConfig)
	api.HandleFunc("DELETE /api/provider-configs/{id}", s.deleteProviderConfig)
	api.HandleFunc("POST /api/providers/{id}/test", s.testProvider)
	api.HandleFunc("GET /api/providers/{id}/metadata", s.providerMetadata)
	api.HandleFunc("POST /api/query", s.query)
	api.HandleFunc("POST /api/query-dashboard", s.queryDashboard)
	api.HandleFunc("GET /api/saved-queries", s.listSavedQueries)
	api.HandleFunc("GET /api/saved-queries/{id}", s.getSavedQuery)
	api.HandleFunc("PUT /api/saved-queries/{id}", s.putSavedQuery)
	api.HandleFunc("DELETE /api/saved-queries/{id}", s.deleteSavedQuery)
	api.HandleFunc("GET /api/dashboards", s.listDashboards)
	api.HandleFunc("GET /api/dashboards/{id}", s.getDashboard)
	api.HandleFunc("POST /api/dashboards/validate", s.checkDashboard)
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
	if err := validateQuery(&q); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	p, err := s.resolveProvider(r, q.ProviderID)
	if err != nil {
		writeProviderError(w, err)
		return
	}
	if !p.public.supports(q.Kind) {
		writeError(w, 400, "provider does not support this query kind")
		return
	}
	result, _, err := s.runProviderQuery(r.Context(), p, &q)
	if errors.Is(err, errQueryCapacity) {
		w.Header().Set("Retry-After", "1")
		writeError(w, 429, "too many active queries; retry shortly")
		return
	}
	if err != nil {
		writeProviderError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

var errQueryCapacity = errors.New("query execution capacity reached")

// The dashboard reader and ordinary widget queries share execution admission
// and instrumentation. The boolean records whether provider I/O actually began.
// acquireQuery waits briefly for a shared execution slot when Insights is
// saturated. Both waiting and executing work have hard caps. A canceled caller
// releases its queue position without starting a detached provider request.
func (s *Server) acquireQuery(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("query admission context: %w", err)
	}
	select {
	case s.queries <- struct{}{}:
		return s.acquiredQuery(ctx)
	default:
	}
	select {
	case s.queryWaiting <- struct{}{}:
		defer func() { <-s.queryWaiting }()
	default:
		return nil, errQueryCapacity
	}
	timer := time.NewTimer(s.queryWaitTimeout)
	defer timer.Stop()
	select {
	case s.queries <- struct{}{}:
		return s.acquiredQuery(ctx)
	case <-ctx.Done():
		return nil, fmt.Errorf("query admission context: %w", ctx.Err())
	case <-timer.C:
		return nil, errQueryCapacity
	}
}

// acquiredQuery releases a newly acquired slot if its caller was canceled
// concurrently with admission; otherwise ownership passes to the returned cleanup.
func (s *Server) acquiredQuery(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		<-s.queries
		return nil, fmt.Errorf("query admission context: %w", err)
	}
	return func() { <-s.queries }, nil
}

func (s *Server) runProviderQuery(ctx context.Context, p *providerClient, q *Query) (QueryResult, bool, error) {
	release, err := s.acquireQuery(ctx)
	if err != nil {
		return QueryResult{}, false, err
	}
	defer release()
	started := time.Now()
	result, err := p.query(ctx, q)
	if err != nil && ctx.Err() != nil {
		err = fmt.Errorf("query execution context: %w", ctx.Err())
	}
	outcome := "success"
	if err != nil {
		outcome = "error"
	}
	attributes := metric.WithAttributes(attribute.String("provider", q.ProviderID), attribute.String("kind", q.Kind), attribute.String("outcome", outcome))
	s.queryCount.Add(ctx, 1, attributes)
	s.queryDuration.Record(ctx, time.Since(started).Seconds(), attributes)
	return result, true, err
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
	if findings := schemaFindings(r.PathValue("id"), doc); len(findings) > 0 {
		writeSchemaFindings(w, findings)
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

// maxCheckRequestBytes allows the envelope and whitespace around a document at
// the size limit. The document itself is still checked against maxDocumentBytes.
const maxCheckRequestBytes = maxDocumentBytes + 4<<10

// checkRequest is the dry-run body. The document sits under a key so that
// later options (execute, variables) can join it without a second route.
type checkRequest struct {
	Document json.RawMessage `json:"document"`
}

// checkDashboard is the dry run: it reports what a save would reject and never
// writes. It reads the same document a PUT takes, and a read-only caller may use it.
func (s *Server) checkDashboard(w http.ResponseWriter, r *http.Request) {
	var request checkRequest
	if err := decodeBody(w, r, &request, maxCheckRequestBytes); err != nil {
		writeError(w, 400, "invalid dashboard check request")
		return
	}
	if len(request.Document) == 0 {
		writeError(w, 400, "dashboard document is required")
		return
	}
	// The identity comes from the document itself, because there is no path id.
	// A document without a readable id fails the id check like any other invalid id.
	var identity struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(request.Document, &identity) != nil {
		identity.ID = ""
	}
	writeCheckReport(w, 200, capCheckReport(schemaFindings(identity.ID, request.Document)))
}

// validationErrorBody is the 400 response to a rejected save. Error keeps the
// single message clients have always read. The rest is the CheckReport list
// shape the dry run uses, so one parser reads both.
type validationErrorBody struct {
	Error     string            `json:"error"`
	Issues    []json.RawMessage `json:"issues"`
	Total     uint32            `json:"total"`
	Truncated bool              `json:"truncated"`
}

func writeSchemaFindings(w http.ResponseWriter, findings []*insightsv1.CheckFinding) {
	report := capCheckReport(findings)
	body := validationErrorBody{Error: findings[0].GetMessage(), Issues: make([]json.RawMessage, 0, len(report.GetIssues())), Total: report.GetTotal(), Truncated: report.GetTruncated()}
	for _, finding := range report.GetIssues() {
		issue, err := checkwire.Marshal(finding)
		if err != nil {
			writeError(w, 500, "dashboard validation failed")
			return
		}
		body.Issues = append(body.Issues, issue)
	}
	writeJSON(w, 400, body)
}

func writeCheckReport(w http.ResponseWriter, status int, report *insightsv1.CheckReport) {
	data, err := checkwire.Marshal(report)
	if err != nil {
		writeError(w, 500, "dashboard validation failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(data); err != nil {
		slog.Debug("could not write insights check report")
	}
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
	providers := registry.list()
	for i := range providers {
		if strings.HasPrefix(providers[i].ID, observeProviderPrefix) {
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
