// An isolated loopback fixture for browser integration tests. It uses the real
// authenticated API proxy, Insights stores, Observe handlers, MCP server and
// Kubernetes-backed provider resolver. Only Kubernetes storage and telemetry
// backends are deterministic fixtures; it never contacts a cluster.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observev1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/insights"
	observe "github.com/benebsworth/paprika/internal/observabilitygateway"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

const fixtureIssuer = "https://observe-e2e.example.test"

func run() error {
	ready := flag.String("ready-file", "", "Private JSON connection file")
	uiURL := flag.String("ui-url", "", "Optional local frontend server")
	uiDir := flag.String("ui-dir", "ui/out", "Built static UI")
	dataDir := flag.String("data-dir", "", "Isolated Insights persistence")
	flag.Parse()
	if *ready == "" || *dataDir == "" {
		return errors.New("ready-file and data-dir are required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	fixture := &telemetryFixture{}
	upstream := httptest.NewServer(fixture)
	defer upstream.Close()
	k8s, err := newFixtureClient(upstream.URL)
	if err != nil {
		return err
	}
	rules := []auth.RBACRule{
		{Subjects: []string{"reader", "denied"}, Actions: []string{"admin"}, Resources: []string{"insights"}, Namespaces: []string{"*"}},
		{Subjects: []string{"viewer"}, Actions: []string{"read"}, Resources: []string{"insights"}, Namespaces: []string{"*"}},
		{Subjects: []string{"group:metrics-readers"}, Actions: []string{"read"}, Resources: []string{"observabilityproviders"}, Namespaces: []string{"observability"}},
	}
	secret := []byte(rand.Text() + rand.Text())
	authCfg := auth.Config{Enabled: true, TokenSecret: secret, RBACRules: rules}
	backend := observe.NewAuthorizedBackend(k8s, auth.NewRBACAuthorizer(rules))
	storeCache, err := cache.New(ctx, cache.Config{Backend: cache.BackendMemory})
	if err != nil {
		return fmt.Errorf("open fixture cache: %w", err)
	}
	defer closeFixtureCache(storeCache)
	gatewayMux := http.NewServeMux()
	gateway := httptest.NewServer(fixture.recordGateway(gatewayMux))
	defer gateway.Close()
	serviceToken := rand.Text() + rand.Text()
	serviceHTTP, err := newInsightsFixture(*dataDir, gateway.URL, serviceToken)
	if err != nil {
		return err
	}
	defer serviceHTTP.Close()
	proxy, err := apiserver.NewInsightsProxy(ctx, authCfg, serviceHTTP.URL, serviceToken, apiserver.InsightsProxyOptions{ObservabilityIssuer: fixtureIssuer})
	if err != nil {
		return fmt.Errorf("configure fixture Insights proxy: %w", err)
	}
	appHandler, err := newAppHandler(proxy, fixture, *uiURL, *uiDir)
	if err != nil {
		return err
	}
	app := httptest.NewServer(appHandler)
	defer app.Close()
	if err = registerFixtureGateway(gatewayMux, proxy, backend, storeCache, secret, app.URL); err != nil {
		return err
	}
	if err = writeReadyFile(*ready, app.URL, gateway.URL, secret); err != nil {
		return err
	}
	fmt.Println("Observe/Insights E2E fixture ready")
	<-ctx.Done()
	return nil
}

func registerFixtureGateway(mux *http.ServeMux, proxy http.Handler, backend observe.Backend, storeCache *cache.Cache, secret []byte, appURL string) error {
	authoring, err := observe.NewInsightsAuthoringClient(proxy, secret, appURL, audit.NoopAuditor{})
	if err != nil {
		return fmt.Errorf("configure fixture authoring client: %w", err)
	}
	handler, err := newGatewayHandler(backend, storeCache, secret, authoring)
	if err != nil {
		return err
	}
	mux.Handle("/", handler)
	return nil
}

func newFixtureClient(endpoint string) (client.Client, error) {
	scheme := runtime.NewScheme()
	if err := observev1.AddToScheme(scheme); err != nil {
		return nil, fmt.Errorf("register observability fixture scheme: %w", err)
	}
	if err := corev1.AddToScheme(scheme); err != nil {
		return nil, fmt.Errorf("register core fixture scheme: %w", err)
	}
	config, err := json.Marshal(map[string]string{"endpoint": endpoint})
	if err != nil {
		return nil, fmt.Errorf("encode fixture provider config: %w", err)
	}
	objects := make([]client.Object, 0, 6)
	for _, namespace := range []string{"observability", "restricted"} {
		objects = append(objects, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "provider-key", Namespace: namespace, Labels: map[string]string{observev1.CredentialsSecretLabel: "true"}}, Data: map[string][]byte{"credentials": []byte("fixture-provider-secret")}})
		for _, typ := range []string{"prometheus", "tempo"} {
			objects = append(objects, &observev1.ObservabilityProvider{ObjectMeta: metav1.ObjectMeta{Name: typ, Namespace: namespace}, Spec: observev1.ObservabilityProviderSpec{Type: typ, Config: runtime.RawExtension{Raw: config}, CredentialsSecretRef: &observev1.CredentialsSecretRef{Name: "provider-key"}}})
		}
	}
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objects...).Build(), nil
}

func closeFixtureCache(storeCache *cache.Cache) {
	if err := storeCache.Close(); err != nil {
		slog.Warn("close fixture cache", "error", err)
	}
}

func newGatewayHandler(backend observe.Backend, storeCache *cache.Cache, secret []byte, authoring *observe.InsightsAuthoringClient) (http.Handler, error) {
	verifier, err := auth.NewSelfSignedAuthenticatorForAudience(secret, mcp.ObservabilityTokenAudience, fixtureIssuer)
	if err != nil {
		return nil, fmt.Errorf("configure fixture authenticator: %w", err)
	}
	registry := mcp.NewRegistry()
	usage := observe.NewUsageTracker()
	if err = observe.RegisterTools(registry, backend, usage); err != nil {
		return nil, fmt.Errorf("register fixture MCP tools: %w", err)
	}
	if err = observe.RegisterInsightsTools(registry, authoring, usage); err != nil {
		return nil, fmt.Errorf("register fixture authoring tools: %w", err)
	}
	mcpServer, err := mcp.NewServer(mcp.ServerConfig{Registry: registry, Authenticator: verifier, Confirmer: mcp.NewConfirmer(storeCache, time.Minute), Auditor: audit.NoopAuditor{}, Cache: storeCache, Secret: secret, PublicURL: fixtureIssuer, ClientID: "e2e", RedirectURIs: []string{"http://127.0.0.1/callback"}, RoutePrefix: "/observe", ProtocolPath: "/observe/mcp", Audience: mcp.ObservabilityTokenAudience, SupportedScopes: []mcp.Scope{mcp.ScopeObserve, mcp.ScopeInsightsWrite}, DisableConsoleResources: true, LinkRequestCancellation: true})
	if err != nil {
		return nil, fmt.Errorf("configure fixture MCP server: %w", err)
	}
	gatewayMux := http.NewServeMux()
	protect := observe.RequireObserveScope(verifier, fixtureIssuer, "/observe")
	gatewayMux.Handle("GET /observe/api/providers", protect(observe.DashboardProvidersHandler(backend, usage)))
	gatewayMux.Handle("POST /observe/api/query", protect(observe.DashboardQueryHandler(backend, usage)))
	gatewayMux.Handle("POST /observe/api/explore", protect(observe.DashboardExploreHandler(backend, usage)))
	gatewayMux.Handle("GET /observe/api/usage", protect(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		jsonResponse(w, usage.Snapshot())
	})))
	gatewayMux.Handle("/observe/mcp", mcpServer.Handler())
	return gatewayMux, nil
}

func newInsightsFixture(dataDir, gatewayURL, token string) (*httptest.Server, error) {
	documents, err := insights.OpenStore(dataDir)
	if err != nil {
		return nil, fmt.Errorf("open fixture Insights store: %w", err)
	}
	service, err := insights.NewServer(insights.Config{Token: token, ObservabilityURL: gatewayURL}, documents)
	if err != nil {
		return nil, fmt.Errorf("configure fixture Insights server: %w", err)
	}
	return httptest.NewServer(service.Handler()), nil
}

func newAppHandler(proxy http.Handler, fixture *telemetryFixture, uiURL, uiDir string) (http.Handler, error) {
	frontend, err := frontendHandler(uiURL, uiDir)
	if err != nil {
		return nil, err
	}
	appMux := http.NewServeMux()
	appMux.Handle("/api/insights/", proxy)
	appMux.HandleFunc("GET /__test/requests", func(w http.ResponseWriter, _ *http.Request) {
		fixture.mu.Lock()
		defer fixture.mu.Unlock()
		jsonResponse(w, map[string]any{"queries": fixture.requests, "gateway": fixture.gatewayRequests})
	})
	appMux.Handle("/", frontend)
	return appMux, nil
}

func frontendHandler(uiURL, uiDir string) (http.Handler, error) {
	if uiURL == "" {
		return http.FileServer(http.Dir(uiDir)), nil
	}
	frontend, err := url.Parse(uiURL)
	if err != nil || (frontend.Scheme != "http" && frontend.Scheme != "https") || (frontend.Hostname() != "localhost" && frontend.Hostname() != "127.0.0.1" && frontend.Hostname() != "::1") {
		return nil, errors.New("ui-url must be a loopback HTTP(S) server")
	}
	return httputil.NewSingleHostReverseProxy(frontend), nil
}

func mintFixtureToken(secret []byte, subject, audience string, groups []string, scopes ...mcp.Scope) (string, error) {
	granted := make([]string, 0, 1+len(scopes))
	granted = append(granted, string(mcp.ScopeObserve))
	for _, scope := range scopes {
		granted = append(granted, string(scope))
	}
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{Subject: subject, Email: subject + "@example.test", Name: subject, Groups: groups, Audience: audience, Issuer: fixtureIssuer, Scope: strings.Join(granted, " "), Secret: secret, TTL: time.Hour})
	if err != nil {
		return "", fmt.Errorf("issue fixture token: %w", err)
	}
	return token, nil
}

func writeReadyFile(path, appURL, gatewayURL string, secret []byte) error {
	ready := map[string]string{"baseURL": appURL, "mcpURL": gatewayURL + "/observe/mcp", "providerRef": "observability/prometheus", "traceProviderRef": "observability/tempo"}
	credentials := []struct {
		key, subject, audience string
		providerAccess         bool
		scopes                 []mcp.Scope
	}{
		{"token", "reader", auth.ConsoleAPIAudience, true, nil},
		{"deniedToken", "denied", auth.ConsoleAPIAudience, false, nil},
		{"viewerToken", "viewer", auth.ConsoleAPIAudience, true, nil},
		{"mcpToken", "reader", mcp.ObservabilityTokenAudience, true, nil},
		{"mcpViewerToken", "viewer", mcp.ObservabilityTokenAudience, true, nil},
		{"mcpNoInsightsToken", "outsider", mcp.ObservabilityTokenAudience, true, nil},
		{"mcpWriteToken", "reader", mcp.ObservabilityTokenAudience, true, []mcp.Scope{mcp.ScopeInsightsWrite}},
		{"mcpDeniedWriteToken", "viewer", mcp.ObservabilityTokenAudience, true, []mcp.Scope{mcp.ScopeInsightsWrite}},
		{"mcpDeniedProviderToken", "denied", mcp.ObservabilityTokenAudience, false, []mcp.Scope{mcp.ScopeInsightsWrite}},
	}
	for _, credential := range credentials {
		groups := []string{}
		if credential.providerAccess {
			groups = append(groups, "metrics-readers")
		}
		token, err := mintFixtureToken(secret, credential.subject, credential.audience, groups, credential.scopes...)
		if err != nil {
			return err
		}
		ready[credential.key] = token
	}
	readyJSON, err := json.Marshal(ready)
	if err != nil {
		return fmt.Errorf("encode fixture connection file: %w", err)
	}
	if err = os.WriteFile(path, readyJSON, 0600); err != nil {
		return fmt.Errorf("write fixture connection file: %w", err)
	}
	return nil
}

type telemetryFixture struct {
	mu              sync.Mutex
	requests        []map[string]string
	gatewayRequests []gatewayRequest
}

// Capture the protocol boundary without retaining authorization headers or
// credentials. Native connector receipts alone cannot distinguish MCP from a
// parallel REST data path.
type gatewayRequest struct {
	Path       string          `json:"path"`
	HTTPMethod string          `json:"httpMethod"`
	Method     string          `json:"method,omitempty"`
	Tool       string          `json:"tool,omitempty"`
	Arguments  json.RawMessage `json:"arguments,omitempty"`
}

func (f *telemetryFixture) recordGateway(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receipt := gatewayRequest{Path: r.URL.Path, HTTPMethod: r.Method}
		if r.URL.Path == "/observe/mcp" && r.Method == http.MethodPost {
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
			if err != nil {
				http.Error(w, "invalid fixture MCP request", http.StatusBadRequest)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			var rpc struct {
				Method string `json:"method"`
				Params struct {
					Name      string          `json:"name"`
					Arguments json.RawMessage `json:"arguments"`
				} `json:"params"`
			}
			if json.Unmarshal(body, &rpc) == nil {
				receipt.Method = rpc.Method
				receipt.Tool = rpc.Params.Name
				receipt.Arguments = rpc.Params.Arguments
			}
		}
		f.mu.Lock()
		f.gatewayRequests = append(f.gatewayRequests, receipt)
		f.mu.Unlock()
		next.ServeHTTP(w, r)
	})
}

var serviceLiteral = regexp.MustCompile(`service=("(?:\\.|[^"\\])*")`)

func (f *telemetryFixture) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer fixture-provider-secret" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	q := r.URL.Query()
	f.mu.Lock()
	f.requests = append(f.requests, map[string]string{"path": r.URL.Path, "query": q.Get("query"), "traceQuery": q.Get("q"), "start": q.Get("start"), "end": q.Get("end"), "step": q.Get("step")})
	f.mu.Unlock()
	if strings.HasPrefix(r.URL.Path, "/api/v1/") {
		servePrometheus(w, r)
		return
	}
	serveTempo(w, r)
}

var fixtureServices = []string{"api-gateway", "release-controller"}

func servePrometheus(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/v1/query_range":
		serveMetricRange(w, r)
	case "/api/v1/query":
		jsonResponse(w, map[string]any{"status": "success", "data": map[string]any{"resultType": "vector", "result": []any{map[string]any{"metric": map[string]string{}, "value": []any{time.Now().Unix(), "1"}}}}})
	case "/api/v1/label/__name__/values":
		jsonResponse(w, map[string]any{"status": "success", "data": []string{"http_requests_total"}})
	case "/api/v1/labels":
		jsonResponse(w, map[string]any{"status": "success", "data": []string{"service", "instance"}})
	case "/api/v1/label/service/values":
		jsonResponse(w, map[string]any{"status": "success", "data": fixtureServices})
	case "/api/v1/label/instance/values":
		jsonResponse(w, map[string]any{"status": "success", "data": []string{"one", "two"}})
	case "/api/v1/series":
		jsonResponse(w, map[string]any{"status": "success", "data": []any{map[string]string{"__name__": "http_requests_total", "service": fixtureServices[0], "instance": "one"}, map[string]string{"__name__": "http_requests_total", "service": fixtureServices[1], "instance": "two"}}})
	case "/api/v1/metadata":
		jsonResponse(w, map[string]any{"status": "success", "data": map[string]any{"http_requests_total": []any{map[string]string{"type": "counter", "help": "HTTP requests", "unit": "requests"}}}})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func metricRangeEnd(raw string) float64 {
	end, err := strconv.ParseFloat(raw, 64)
	if err == nil && end != 0 {
		return end
	}
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return 0
	}
	return float64(parsed.UnixNano()) / 1e9
}

func serveMetricRange(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if strings.Contains(q.Get("query"), "unavailable_fixture_metric") {
		http.Error(w, "simulated upstream unavailable", http.StatusServiceUnavailable)
		return
	}
	end := metricRangeEnd(q.Get("end"))
	service := fixtureServices[0]
	if match := serviceLiteral.FindStringSubmatch(q.Get("query")); len(match) > 1 {
		if err := json.Unmarshal([]byte(match[1]), &service); err != nil {
			http.Error(w, "invalid service selector", http.StatusBadRequest)
			return
		}
	}
	last := 101.2345
	if service == fixtureServices[1] {
		last = 202.3456
	}
	values := [][]any{{end - 180, strconv.FormatFloat(last-9.25, 'f', -1, 64)}, {end - 120, strconv.FormatFloat(last+12.5, 'f', -1, 64)}, {end - 60, strconv.FormatFloat(last-3.75, 'f', -1, 64)}, {end, strconv.FormatFloat(last, 'f', -1, 64)}}
	if service == fixtureServices[0] {
		values[0][1] = strconv.FormatFloat(last+8.5, 'f', -1, 64)
		values[1][1] = strconv.FormatFloat(last-4.25, 'f', -1, 64)
		values[2][1] = strconv.FormatFloat(last+1.75, 'f', -1, 64)
	}
	if strings.Contains(q.Get("query"), "dense_http_requests_total") {
		values = denseMetricValues(q, last)
	}
	if !scaleMetricValues(w, q.Get("query"), values) {
		return
	}
	result := []any{map[string]any{"metric": map[string]string{"service": service}, "values": values}}
	if service == "no-telemetry" {
		result = []any{}
	}
	jsonResponse(w, map[string]any{"status": "success", "data": map[string]any{"resultType": "matrix", "result": result}})
}

func scaleMetricValues(w http.ResponseWriter, query string, values [][]any) bool {
	if strings.HasSuffix(strings.TrimSpace(query), " * 2") {
		for i := range values {
			value, parseErr := strconv.ParseFloat(fmt.Sprint(values[i][1]), 64)
			if parseErr != nil {
				http.Error(w, "invalid fixture sample", http.StatusInternalServerError)
				return false
			}
			values[i][1] = strconv.FormatFloat(value*2, 'f', -1, 64)
		}
	}
	return true
}

func denseMetricValues(query url.Values, last float64) [][]any {
	start, end := metricRangeEnd(query.Get("start")), metricRangeEnd(query.Get("end"))
	step, err := strconv.ParseFloat(query.Get("step"), 64)
	if err != nil || step <= 0 || end <= start {
		return nil
	}
	points := min(1001, int(math.Floor((end-start)/step))+1)
	values := make([][]any, points)
	for i := range values {
		value := last + math.Sin(float64(i)/8)*12
		if i == points-1 {
			value = last
		}
		values[i] = []any{start + float64(i)*step, strconv.FormatFloat(value, 'f', -1, 64)}
	}
	return values
}

var traceServiceLiteral = regexp.MustCompile(`resource\.service\.name\s*=\s*("(?:\\.|[^"\\])*")`)

func serveTempo(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/search":
		serveTraceSearch(w, r)
	case "/api/search/tags":
		jsonResponse(w, map[string]any{"tagNames": []string{"resource.service.name", "http.method"}})
	case "/api/echo":
		if _, err := w.Write([]byte("echo")); err != nil {
			slog.Warn("write fixture echo response", "error", err)
		}
	default:
		if strings.HasPrefix(r.URL.Path, "/api/search/tag/") {
			jsonResponse(w, map[string]any{"tagValues": fixtureServices})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}
}

func serveTraceSearch(w http.ResponseWriter, r *http.Request) {
	service := fixtureServices[0]
	if match := traceServiceLiteral.FindStringSubmatch(r.URL.Query().Get("q")); len(match) > 1 {
		if err := json.Unmarshal([]byte(match[1]), &service); err != nil {
			http.Error(w, "invalid trace service", http.StatusBadRequest)
			return
		}
	}
	observed := metricRangeEnd(r.URL.Query().Get("end")) - 60
	if observed <= 0 {
		observed = float64(time.Now().Unix())
	}
	traces := []any{map[string]any{"traceID": "abc123", "rootServiceName": service, "rootTraceName": "GET /api/orders", "durationMs": 12.34, "startTimeUnixNano": strconv.FormatInt(int64(observed*1e9), 10)}}
	if service == "no-telemetry" {
		traces = []any{}
	}
	jsonResponse(w, map[string]any{"traces": traces})
}

func jsonResponse(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Warn("write fixture JSON response", "error", err)
	}
}
