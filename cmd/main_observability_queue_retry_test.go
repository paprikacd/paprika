package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/insights"
)

const (
	queueRetryProviderName = "uptime-examples"
	queueRetryOrg          = "4d0c8a2e-7c7e-4d6e-9d0f-2b9f3c1a5e11"
	queueRetryProviderID   = "observe-e669210d3e2fca76dcf6ce7b9c3981173b10097ebe9b6ca234eb05f166cf0486"
)

// queueRetryUptime answers the uptime SLO read after delay, as a slow upstream.
func queueRetryUptime(delay time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		select {
		case <-time.After(delay):
		case <-r.Context().Done():
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/GetSLODashboard") {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"services":[` +
			`{"serviceId":"7b0e7f52-0a1c-4d55-9a57-111111111111","serviceName":"api","serviceSlug":"api","slaTarget":99.9,"currentUptime":99.95,"errorBudgetTotal":43.2,"errorBudgetRemaining":21.6,"errorBudgetPercentage":50,"slaBreached":false,"totalChecks":1000,"failedChecks":1},` +
			`{"serviceId":"7b0e7f52-0a1c-4d55-9a57-222222222222","serviceName":"web","serviceSlug":"web","slaTarget":99.9,"currentUptime":99.5,"errorBudgetTotal":43.2,"errorBudgetRemaining":0,"errorBudgetPercentage":0,"slaBreached":true,"totalChecks":1000,"failedChecks":5}]}`))
	})
}

// queueRetryStack starts the production gateway (its real execution budget and
// admission pools) in front of a slow uptime upstream, and the production
// Insights server in front of the gateway. Each is served on a real listener.
func queueRetryStack(t *testing.T, upstreamDelay time.Duration) (insightsURL, insightsToken, observeToken string) {
	t.Helper()
	uptimeSrv := newQueueRetryServer(t, queueRetryUptime(upstreamDelay))
	gwLn, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	inLn, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	gatewayURL := "http://" + gwLn.Addr().String()
	insightsURL = "http://" + inLn.Addr().String()
	insightsToken = strings.Repeat("queueretry", 4)
	t.Setenv("PAPRIKA_INSIGHTS_URL", insightsURL)
	t.Setenv("PAPRIKA_INSIGHTS_TOKEN", insightsToken)

	// Insights: the production server timeouts from cmd/paprika-insights/main.go.
	store, err := insights.OpenStore(t.TempDir())
	require.NoError(t, err)
	isrv, err := insights.NewServer(insights.Config{Token: insightsToken, ObservabilityURL: gatewayURL}, store)
	require.NoError(t, err)
	insightsHTTP := &http.Server{Handler: isrv.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() { _ = insightsHTTP.Serve(inLn) }()
	t.Cleanup(func() { _ = insightsHTTP.Close() })

	// Gateway: production builders and flag defaults.
	cfg, err := parseManagerConfig([]string{"--mode=observability-gateway"}, &bytes.Buffer{})
	require.NoError(t, err)
	cfg.MCPPublicURL, cfg.AuthEnabled = usageTestIssuer, true
	capacity, err := resolveObservabilityCapacity(cfg)
	require.NoError(t, err)
	secret := []byte("queue-retry-test-secret-0123456789abcdef")
	authCfg := auth.Config{Enabled: true, TokenSecret: secret, RBACRules: []auth.RBACRule{{Subjects: []string{"*"}, Actions: []string{"*"}, Resources: []string{"*"}, Namespaces: []string{"*"}}}}

	scheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(scheme))
	require.NoError(t, observabilityv1alpha1.AddToScheme(scheme))
	cr := &observabilityv1alpha1.ObservabilityProvider{
		ObjectMeta: metav1.ObjectMeta{Name: queueRetryProviderName, Namespace: "observability"},
		Spec: observabilityv1alpha1.ObservabilityProviderSpec{
			Type:                 "uptime",
			Config:               runtime.RawExtension{Raw: []byte(`{"endpoint":"` + uptimeSrv + `","orgId":"` + queueRetryOrg + `"}`)},
			CredentialsSecretRef: &observabilityv1alpha1.CredentialsSecretRef{Name: "uptime-creds"},
		},
	}
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "uptime-creds", Namespace: "observability", Labels: map[string]string{observabilityv1alpha1.CredentialsSecretLabel: "true"}},
		Data:       map[string][]byte{"credentials": []byte("queue-retry-static-bearer-token")},
	}
	k8s := fake.NewClientBuilder().WithScheme(scheme).WithObjects(cr, sec).Build()
	memCache, err := cache.New(t.Context(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	t.Cleanup(func() { _ = memCache.Close() })
	srv, authenticator, usage, backend, err := buildObservabilityServer(context.Background(), cfg, authCfg, k8s, memCache, capacity.Budget)
	require.NoError(t, err)
	mux := buildObservabilityMux(srv, authenticator, cfg.MCPPublicURL, usage, backend)
	gwHTTP := &http.Server{
		Handler:           limitObservabilityProtocolRequestsWith(mux, capacity.Pools),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       observabilityReadTimeout,
		WriteTimeout:      observabilityWriteTimeout,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    apiServerMaxHeaderBytes,
	}
	go func() { _ = gwHTTP.Serve(gwLn) }()
	t.Cleanup(func() { _ = gwHTTP.Close() })

	return insightsURL, insightsToken, usageTestToken(t, secret, string(mcp.ScopeObserve))
}

// newQueueRetryServer serves handler on a loopback listener and returns its URL.
func newQueueRetryServer(t *testing.T, handler http.Handler) string {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return "http://" + ln.Addr().String()
}

// queueRetryQuery posts one widget query to Insights /api/query, as the browser does.
func queueRetryQuery(t *testing.T, insightsURL, insightsToken, observeToken string) (status int, retryAfter string, elapsed time.Duration) {
	t.Helper()
	now := float64(time.Now().Unix())
	body, err := json.Marshal(map[string]any{
		"providerId": queueRetryProviderID,
		"kind":       "metrics",
		"query":      `{"operation":"slo_summary","args":{"windowDays":30},"projection":{"value":"averageUptime"}}`,
		"start":      now - 6*3600,
		"end":        now,
		"step":       72,
	})
	require.NoError(t, err)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, insightsURL+"/api/query", bytes.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+insightsToken)
	req.Header.Set("X-Paprika-Observe-Token", observeToken)
	req.Header.Set("Content-Type", "application/json")
	started := time.Now()
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, resp.Header.Get("Retry-After"), time.Since(started)
}

// Scenario G from the live investigation, through the production gateway and
// Insights: four parallel widget queries share one provider, which runs two at a
// time, and each upstream read takes 6 s. The two queued past the 5 s queue wait
// must come back as 429 with Retry-After: 1 before the upstream finishes, not as
// a 504 timeout. The two that ran must succeed.
func TestQueueWaitExpiryReachesInsightsAsRetryable(t *testing.T) {
	insightsURL, insightsToken, observeToken := queueRetryStack(t, 6*time.Second)
	type outcome struct {
		status     int
		retryAfter string
		elapsed    time.Duration
	}
	results := make([]outcome, 4)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, retryAfter, elapsed := queueRetryQuery(t, insightsURL, insightsToken, observeToken)
			results[i] = outcome{status: status, retryAfter: retryAfter, elapsed: elapsed}
		}()
	}
	wg.Wait()

	var succeeded, busy int
	for _, r := range results {
		switch r.status {
		case http.StatusOK:
			succeeded++
		case http.StatusTooManyRequests:
			busy++
			require.Equal(t, "1", r.retryAfter, "a queue-wait expiry names a one-second retry")
			require.Less(t, r.elapsed, 5900*time.Millisecond, "the queue wait ends before the 6 s upstream read")
		default:
			t.Fatalf("unexpected status %d after %s; want 200 or 429, never a timeout", r.status, r.elapsed)
		}
	}
	require.Equal(t, 2, succeeded, "two queries run within the per-provider limit")
	require.Equal(t, 2, busy, "the two queued past the queue wait are answered 429")
}
