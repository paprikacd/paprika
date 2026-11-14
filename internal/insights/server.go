package insights

import (
	"bytes"
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
	// catalogPhases caps how many shared queries may be resolving the catalog at
	// once. catalogWaiting bounds the queue for those phases; a shared query waits
	// up to catalogWaitTimeout for a phase before it fails with a retry hint.
	catalogPhases      chan struct{}
	catalogWaiting     chan struct{}
	catalogWaitTimeout time.Duration
	// queryBudget bounds one /api/query end to end: every phase (catalog wait,
	// admission wait, listing, data call) is capped by what remains of it.
	queryBudget   time.Duration
	queryCount    metric.Int64Counter
	queryDuration metric.Float64Histogram
	// checkSlots caps the dry runs and checked saves in flight. A dry run holds its
	// slot while it decodes its request and builds its report; a checked save holds
	// it through its lock wait, its check, its write and its response. Each one
	// parses a whole document, so a burst of them is refused rather than allowed to
	// grow the heap of a replica. A request body is read before a slot is taken, so
	// a slow upload holds none.
	checkSlots chan struct{}
	// dryRunSlots caps the dry runs that execute queries. They hold a check slot
	// only until their report is built, so provider latency never blocks checked
	// saves; this pool bounds the executing dry runs on their own.
	dryRunSlots chan struct{}
	// documentReads caps the dashboard requests that read a whole body at once: a
	// save and a dry run, before any check slot. Their bodies can be 400 KB each,
	// and without this cap a flood of uploads could fill the heap before the check
	// slots refuse anything. A request waits up to bodyWaitTimeout for a read slot,
	// and at most cap(documentWaiting) requests may wait at once.
	documentReads       chan struct{}
	documentWaiting     chan struct{}
	documentWaitTimeout time.Duration
}

// maxActiveDashboardChecks is the number of dry runs and checked saves that may decode a document at once.
const maxActiveDashboardChecks = 4

// maxActiveDocumentReads is the number of dashboard requests that may read a body at once.
const maxActiveDocumentReads = 8

// maxActiveDryRunQueries is the number of dry runs with execute that may run their queries at once.
const maxActiveDryRunQueries = 4

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
	s := &Server{store: store, providers: registry, savedQueries: savedQueries, observe: observe, tokenHash: sha256.Sum256([]byte(config.Token)), insecureDev: config.InsecureDev, queries: make(chan struct{}, 16), queryWaiting: make(chan struct{}, 64), queryWaitTimeout: 2 * time.Second, catalogPhases: make(chan struct{}, 4), catalogWaiting: make(chan struct{}, 16), catalogWaitTimeout: 5 * time.Second, queryBudget: 22 * time.Second, checkSlots: make(chan struct{}, maxActiveDashboardChecks), dryRunSlots: make(chan struct{}, maxActiveDryRunQueries), documentReads: make(chan struct{}, maxActiveDocumentReads), documentWaiting: make(chan struct{}, 16), documentWaitTimeout: 2 * time.Second}
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
	api.HandleFunc("GET /api/starters", s.listStarters)
	api.HandleFunc("GET /api/starters/{id}", s.getStarter)
	api.HandleFunc("GET /api/dashboards", s.listDashboards)
	api.HandleFunc("GET /api/dashboards/{id}", s.getDashboard)
	api.HandleFunc("POST /api/dashboards/validate", s.checkDashboard)
	api.HandleFunc("PUT /api/dashboards/{id}", s.putDashboard)
	api.HandleFunc("DELETE /api/dashboards/{id}", s.deleteDashboard)
	mux.Handle("/api/", s.authenticate(s.scopeObserveSessions(api)))
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
	// The whole query shares one deadline, so it answers inside the API proxy's
	// header timeout. Each phase below draws on what remains of it.
	ctx, cancel := context.WithTimeout(r.Context(), s.queryBudget)
	defer cancel()
	r = r.WithContext(ctx)
	var (
		p       *providerClient
		release func()
		ok      bool
	)
	if s.observe != nil && strings.HasPrefix(q.ProviderID, observeProviderPrefix) {
		p, release, ok = s.admitAndResolveShared(w, r, &q)
	} else {
		// Local providers come from the registry, so they resolve before admission:
		// they never wait on the shared catalog, and an unknown id is a 404 even
		// while Insights is saturated.
		if p, ok = s.resolveLocalQuery(w, r, &q); ok {
			release, ok = s.admitQueryRequest(w, r)
		}
	}
	if !ok {
		return
	}
	defer release()
	result, err := s.executeProviderQuery(ctx, p, &q)
	if err != nil {
		writeQueryError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

// resolveLocalQuery resolves a registry provider and checks the query kind. It
// writes the failure and reports false when the request must stop.
func (s *Server) resolveLocalQuery(w http.ResponseWriter, r *http.Request, q *Query) (*providerClient, bool) {
	p, err := s.resolveProvider(r, q.ProviderID)
	if err != nil {
		writeQueryError(w, err)
		return nil, false
	}
	if !p.public.supports(q.Kind) {
		writeError(w, 400, "provider does not support this query kind")
		return nil, false
	}
	return p, true
}

// admitQueryRequest takes an Insights execution slot, writing the 429 or the
// admission failure when none is available.
func (s *Server) admitQueryRequest(w http.ResponseWriter, r *http.Request) (func(), bool) {
	release, err := s.acquireQuery(r.Context())
	if err != nil {
		if errors.Is(err, errQueryCapacity) {
			w.Header().Set("Retry-After", "1")
			writeError(w, 429, "too many active queries; retry shortly")
			return nil, false
		}
		writeQueryError(w, err)
		return nil, false
	}
	return release, true
}

// admitAndResolveShared runs the shared-catalog path in this order: wait for a
// catalog phase (no admission slot is held while waiting), take an admission
// slot, list the catalog, then release the phase before the data call. The
// listing therefore happens only for admitted work, and local queries never
// queue behind shared waiters for their slots.
func (s *Server) admitAndResolveShared(w http.ResponseWriter, r *http.Request, q *Query) (*providerClient, func(), bool) {
	leave, err := s.enterCatalogPhase(r.Context())
	if err != nil {
		s.writeCatalogAdmissionError(w, r, q, err)
		return nil, nil, false
	}
	defer leave()
	release, ok := s.admitQueryRequest(w, r)
	if !ok {
		return nil, nil, false
	}
	p, err := s.resolveSharedProvider(r, q.ProviderID)
	if err != nil {
		release()
		writeQueryError(w, err)
		return nil, nil, false
	}
	if !p.public.supports(q.Kind) {
		release()
		writeError(w, 400, "provider does not support this query kind")
		return nil, nil, false
	}
	return p, release, true
}

var errCatalogBusy = errors.New("shared catalog capacity reached")

// catalogBusyProvider is the provider label of a catalog-busy rejection.
const catalogBusyProvider = "shared-catalog"

// enterCatalogPhase takes a catalog phase, waiting up to catalogWaitTimeout when
// all phases are busy. Only catalogWaiting callers may queue; any beyond that
// fail fast, so a burst of shared work cannot pile up without bound.
func (s *Server) enterCatalogPhase(ctx context.Context) (func(), error) {
	leave := func() { <-s.catalogPhases }
	select {
	case s.catalogPhases <- struct{}{}:
		return leave, nil
	default:
	}
	select {
	case s.catalogWaiting <- struct{}{}:
		defer func() { <-s.catalogWaiting }()
	default:
		return nil, errCatalogBusy
	}
	timer := time.NewTimer(s.catalogWaitTimeout)
	defer timer.Stop()
	select {
	case s.catalogPhases <- struct{}{}:
		return leave, nil
	case <-timer.C:
		return nil, errCatalogBusy
	case <-ctx.Done():
		return nil, fmt.Errorf("catalog admission context: %w", ctx.Err())
	}
}

// writeQueryError reports a failed query phase. A deadline here is the query's
// own budget, so the message names the query; other failures keep the shared text.
func writeQueryError(w http.ResponseWriter, err error) {
	if errors.Is(err, context.DeadlineExceeded) {
		writeError(w, http.StatusGatewayTimeout, "query exceeded its time budget")
		return
	}
	writeProviderError(w, err)
}

// writeCatalogAdmissionError reports a shared query that could not get a catalog
// phase. Busy is retryable; a canceled caller is answered like other admission
// cancellations. The rejection is counted under the existing query metric.
func (s *Server) writeCatalogAdmissionError(w http.ResponseWriter, r *http.Request, q *Query, err error) {
	if !errors.Is(err, errCatalogBusy) {
		writeQueryError(w, err)
		return
	}
	// The provider label is fixed: the caller's id is not resolved yet, so it could
	// otherwise name an unbounded number of series.
	attributes := metric.WithAttributes(attribute.String("provider", catalogBusyProvider), attribute.String("kind", q.Kind), attribute.String("outcome", "catalog_busy"))
	s.queryCount.Add(r.Context(), 1, attributes)
	w.Header().Set("Retry-After", "1")
	writeError(w, 429, "too many active shared catalog requests; retry shortly")
}

// resolveSharedProvider bounds the catalog phase by the catalog timeout. The
// scope's session outlives this context, so the cap ends only this listing.
func (s *Server) resolveSharedProvider(r *http.Request, id string) (*providerClient, error) {
	ctx, cancel := context.WithTimeout(r.Context(), s.observe.timeouts.catalog)
	defer cancel()
	return s.resolveProvider(r.WithContext(ctx), id)
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

// runProviderQuery admits, then executes an already resolved provider. Callers
// that resolve providers first (dashboards) keep their existing ordering.
func (s *Server) runProviderQuery(ctx context.Context, p *providerClient, q *Query) (QueryResult, bool, error) {
	release, err := s.acquireQuery(ctx)
	if err != nil {
		return QueryResult{}, false, err
	}
	defer release()
	result, err := s.executeProviderQuery(ctx, p, q)
	return result, true, err
}

// executeProviderQuery runs the query under an admission slot the caller holds.
func (s *Server) executeProviderQuery(ctx context.Context, p *providerClient, q *Query) (QueryResult, error) {
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
	return result, err
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
	// The body is read before a check slot is taken, so a stalled upload holds no
	// slot. It is read under a document-read slot, which is released before the
	// check slot is taken. The check slot covers the rest of a checked save: the
	// lock wait, the check, the write and the response.
	release, ok := s.admitDocumentRead(w, r)
	if !ok {
		return
	}
	var doc json.RawMessage
	err := decodeBody(w, r, &doc, maxDocumentBytes)
	release()
	if err != nil {
		writeError(w, 400, "invalid dashboard document")
		return
	}
	if wantsChecks(r) {
		release, ok := s.admitCheck(w)
		if !ok {
			return
		}
		defer release()
	}
	id := r.PathValue("id")
	// The whole check runs under the mutation lock, for two reasons. The stored
	// version must be read in the same critical section as the write, so the overlap
	// check and the write see the same dashboard. And unchecked saves are not capped
	// by the check slots: the lock is what runs their validation one document at a
	// time, which bounds their memory. Moving the schema pass out of the lock needs
	// every array a document can make large bounded first, so it stays here until
	// then. A save of a valid dashboard takes well under a millisecond under it.
	s.mutations.Lock()
	defer s.mutations.Unlock()
	// Schema findings and error-severity lint findings reject the save. Warnings
	// and info are returned in the checks field of a successful save. An overlap
	// the stored version already has is a warning, so it does not reject the save.
	findings := saveReport(id, doc, s.storedDashboard(id), checkwire.MaxIssues)
	if findings.hasErrors() {
		writeSchemaFindings(w, findings)
		return
	}
	tag, err := s.store.Put(id, doc, r.Header.Get("If-Match"), r.Header.Get("If-None-Match"))
	if err != nil {
		storeError(w, err)
		return
	}
	setDocumentETag(w, tag)
	if wantsChecks(r) {
		writeSavedDocument(w, 200, doc, findings)
		return
	}
	writeJSON(w, 200, doc)
}

// admitCheck takes a dry-run or checked-save slot. When every slot is taken it
// writes the 429 the other Insights endpoints use, with a one-second retry hint.
func (s *Server) admitCheck(w http.ResponseWriter) (func(), bool) {
	return admitSlot(s.checkSlots, w, "too many active dashboard checks; retry shortly")
}

// admitDryRunQuery takes a slot for a dry run's query phase, with the same refusal as admitCheck.
func (s *Server) admitDryRunQuery(w http.ResponseWriter) (func(), bool) {
	return admitSlot(s.dryRunSlots, w, "too many active dashboard dry runs with queries; retry shortly")
}

// admitSlot takes a slot from pool without waiting. A full pool writes the 429 with
// a one-second retry hint and the message, and reports false.
func admitSlot(pool chan struct{}, w http.ResponseWriter, message string) (func(), bool) {
	select {
	case pool <- struct{}{}:
		return func() { <-pool }, true
	default:
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusTooManyRequests, message)
		return nil, false
	}
}

// wantsChecks reports whether a save asks for its warnings in the response. The
// checks field is opt-in: the default success body is the document as it was
// always returned, so a client that stores that body is not handed a member the
// dashboard schema does not know. A client that asks gets the same document with
// checks added after its members.
func wantsChecks(r *http.Request) bool {
	return r.URL.Query().Get("checks") == "true"
}

// writeSavedDocument writes the saved document with a checks field added after
// its members. The document bytes are otherwise written as they always were.
func writeSavedDocument(w http.ResponseWriter, status int, document Dashboard, findings *findingSet) {
	report, err := checkwire.Marshal(findings.report())
	if err != nil {
		writeError(w, 500, "dashboard validation failed")
		return
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, document); err != nil {
		writeError(w, 500, "dashboard validation failed")
		return
	}
	body := compact.Bytes()
	out := make([]byte, 0, len(body)+len(report)+len(`,"checks":`)+2)
	out = append(out, body[:len(body)-1]...)
	out = append(out, `,"checks":`...)
	out = append(out, report...)
	out = append(out, '}', '\n')
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// The bytes are a compacted, schema-checked document plus the checks report,
	// and the handler sends nosniff, so this is not an HTML or script response.
	if _, err := w.Write(out); err != nil {
		slog.Debug("could not write insights document")
	}
}

// maxCheckRequestBytes allows a document at its size limit, the envelope around it,
// and the worst-case escaped size of the dry run's variables (see checkwire).
// The document itself is still checked against maxDocumentBytes.
const maxCheckRequestBytes = maxDocumentBytes + checkwire.DryRunEnvelopeBytes

// checkRequest is the dry-run body. The document sits under a key so that the
// options join it without a second route. Execute runs the document's queries
// once each, read-only, with the dashboard's default time range, and reports what
// they returned. Variables apply only with execute.
type checkRequest struct {
	Document  json.RawMessage   `json:"document"`
	Execute   bool              `json:"execute"`
	Variables map[string]string `json:"variables"`
}

// checkDashboard is the dry run: it reports what a save would reject and never
// writes. It reads the same document a PUT takes, and a read-only caller may use it.
func (s *Server) checkDashboard(w http.ResponseWriter, r *http.Request) {
	request, report, ok := s.decodeCheck(w, r)
	if !ok {
		return
	}
	if !request.Execute {
		writeCheckReport(w, 200, report.report())
		return
	}
	s.executeDryRun(w, r, request, report)
}

// decodeCheck decodes a dry-run request and builds its schema and lint report. The
// raw body is read before a check slot is taken, so a stalled upload holds no slot.
// The envelope is decoded only once a slot is held, so a refused request costs its
// bytes and no more: decoding a variables object allocates several times its size.
// The slot is released before any query runs, so a slow provider never keeps a
// checked save out.
func (s *Server) decodeCheck(w http.ResponseWriter, r *http.Request) (*checkRequest, *findingSet, bool) {
	release, ok := s.admitDocumentRead(w, r)
	if !ok {
		return nil, nil, false
	}
	raw, err := readBody(w, r, maxCheckRequestBytes)
	release()
	if err != nil {
		writeError(w, 400, "invalid dashboard check request")
		return nil, nil, false
	}
	releaseCheck, ok := s.admitCheck(w)
	if !ok {
		return nil, nil, false
	}
	defer releaseCheck()
	var request checkRequest
	if err := decodeJSON(bytes.NewReader(raw), &request); err != nil {
		writeError(w, 400, "invalid dashboard check request")
		return nil, nil, false
	}
	if len(request.Document) == 0 {
		writeError(w, 400, "dashboard document is required")
		return nil, nil, false
	}
	if !request.Execute && len(request.Variables) > 0 {
		writeError(w, 400, "variables apply only when execute is true")
		return nil, nil, false
	}
	return &request, s.checkReport(request.Document), true
}

// validationErrorBody is the 400 response to a rejected save. Error keeps the
// single message clients have always read: the first finding in validation
// order. The rest is the CheckReport list shape the dry run uses, whose issues
// list document-level findings first.
type validationErrorBody struct {
	Error     string            `json:"error"`
	Issues    []json.RawMessage `json:"issues"`
	Total     uint32            `json:"total"`
	Truncated bool              `json:"truncated"`
	// Severity counts cover every finding, including those past the issue cap.
	ErrorCount   uint32 `json:"errorCount"`
	WarningCount uint32 `json:"warningCount"`
	InfoCount    uint32 `json:"infoCount"`
}

func writeSchemaFindings(w http.ResponseWriter, findings *findingSet) {
	report := findings.report()
	body := validationErrorBody{Error: findings.first.GetMessage(), Issues: make([]json.RawMessage, 0, len(report.GetIssues())), Total: report.GetTotal(), Truncated: report.GetTruncated(), ErrorCount: report.GetErrorCount(), WarningCount: report.GetWarningCount(), InfoCount: report.GetInfoCount()}
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

// admitDocumentRead takes a document-read slot for a request that reads a whole
// body. A request waits up to documentWaitTimeout for one. When none frees in time,
// or the waiting queue is full, it writes the 429 the other Insights admission
// errors use, with a one-second retry hint, and reports false.
func (s *Server) admitDocumentRead(w http.ResponseWriter, r *http.Request) (func(), bool) {
	release, err := s.acquireDocumentRead(r.Context())
	if err == nil {
		return release, true
	}
	if errors.Is(err, errDocumentReadCapacity) {
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusTooManyRequests, "too many active dashboard uploads; retry shortly")
		return nil, false
	}
	writeError(w, http.StatusServiceUnavailable, "dashboard upload ended before a read slot was free")
	return nil, false
}

var errDocumentReadCapacity = errors.New("dashboard document read capacity reached")

// acquireDocumentRead mirrors acquireQuery: a free slot is taken at once, a request
// may queue when the pool is full, up to a fixed number of waiters, and a canceled
// caller releases its place without reading.
func (s *Server) acquireDocumentRead(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("dashboard upload admission context: %w", err)
	}
	select {
	case s.documentReads <- struct{}{}:
		return s.acquiredDocumentRead(ctx)
	default:
	}
	select {
	case s.documentWaiting <- struct{}{}:
		defer func() { <-s.documentWaiting }()
	default:
		return nil, errDocumentReadCapacity
	}
	timer := time.NewTimer(s.documentWaitTimeout)
	defer timer.Stop()
	select {
	case s.documentReads <- struct{}{}:
		return s.acquiredDocumentRead(ctx)
	case <-ctx.Done():
		return nil, fmt.Errorf("dashboard upload admission context: %w", ctx.Err())
	case <-timer.C:
		return nil, errDocumentReadCapacity
	}
}

// acquiredDocumentRead releases a new read slot if its caller was canceled while it
// was being taken; otherwise ownership passes to the returned cleanup.
func (s *Server) acquiredDocumentRead(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		<-s.documentReads
		return nil, fmt.Errorf("dashboard upload admission context: %w", err)
	}
	return func() { <-s.documentReads }, nil
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	defer closeReadBody(r.Body)
	return decodeJSON(r.Body, v)
}

// readBody reads the request body, up to limit bytes, without decoding it. A handler
// that must not decode until it holds a slot reads the body first with this.
func readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	defer closeReadBody(r.Body)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, fmt.Errorf("read request body: %w", err)
	}
	return raw, nil
}

// decodeJSON decodes exactly one JSON value from in into v, with unknown members
// rejected.
func decodeJSON(in io.Reader, v any) error {
	decoder := json.NewDecoder(in)
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
