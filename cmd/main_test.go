package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-logr/logr"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/fleet"
)

func TestRegisterFlagsOIDCSecret(t *testing.T) {
	testConfigEnvDefaultAndOverride(
		t,
		"PAPRIKA_OIDC_CLIENT_SECRET",
		"environment-secret-marker",
		"--auth-oidc-client-secret=flag-secret-marker",
		"flag-secret-marker",
		func(cfg *cliConfig) string { return cfg.AuthOIDCClientSecret },
	)

	t.Run("explicit empty flag overrides environment", func(t *testing.T) {
		t.Setenv("PAPRIKA_OIDC_CLIENT_SECRET", "environment-secret-marker")
		cfg, err := parseManagerConfig([]string{"--auth-oidc-client-secret="}, io.Discard)
		if err != nil {
			t.Fatalf("parse config: %v", err)
		}
		if cfg.AuthOIDCClientSecret != "" {
			t.Fatalf("authOIDCClientSecret = %q, want explicit empty value", cfg.AuthOIDCClientSecret)
		}
	})
}

func TestManagerHelpDoesNotExposeSecrets(t *testing.T) {
	const secretMarker = "help-secret-marker-do-not-print"
	t.Setenv("PAPRIKA_OIDC_CLIENT_SECRET", secretMarker)

	var out bytes.Buffer
	cmd, _, _ := newManagerCommand(func(context.Context, *cliConfig) error {
		t.Error("start must not run for --help")
		return nil
	})
	cmd.SetArgs([]string{"--help"})
	cmd.SetOut(&out)
	cmd.SetErr(&out)

	require.NoError(t, cmd.Execute())
	if strings.Contains(out.String(), secretMarker) {
		t.Fatal("help output contains the OIDC client secret environment value")
	}
}

func TestRegisterFlagsOIDCRedirect(t *testing.T) {
	testConfigEnvDefaultAndOverride(
		t,
		"PAPRIKA_OIDC_REDIRECT_URL",
		"https://environment.example.com/auth/callback",
		"--auth-oidc-redirect-url=https://flag.example.com/auth/callback",
		"https://flag.example.com/auth/callback",
		func(cfg *cliConfig) string { return cfg.AuthOIDCRedirectURL },
	)
}

func testConfigEnvDefaultAndOverride(
	t *testing.T,
	envKey, envValue, flagArg, flagValue string,
	configValue func(*cliConfig) string,
) {
	t.Helper()

	t.Run("defaults from environment", func(t *testing.T) {
		t.Setenv(envKey, envValue)
		cfg, err := parseManagerConfig(nil, io.Discard)
		if err != nil {
			t.Fatalf("parse config: %v", err)
		}
		if got := configValue(cfg); got != envValue {
			t.Fatalf("config value = %q, want environment value %q", got, envValue)
		}
	})

	t.Run("explicit flag overrides environment", func(t *testing.T) {
		t.Setenv(envKey, envValue)
		cfg, err := parseManagerConfig([]string{flagArg}, io.Discard)
		if err != nil {
			t.Fatalf("parse config: %v", err)
		}
		if got := configValue(cfg); got != flagValue {
			t.Fatalf("config value = %q, want explicit flag value %q", got, flagValue)
		}
	})
}

func TestBuildAuthConfigCopiesOIDCRedirectURL(t *testing.T) {
	const redirectURL = "https://paprika.example.com/auth/callback"

	cfg := buildAuthConfig(
		true,
		"", "", "",
		"https://issuer.example.com", "client-id", "client-secret-marker", redirectURL,
		"", "", logr.Discard(),
	)
	if cfg.OIDC == nil {
		t.Fatal("OIDC config is nil")
	}
	if cfg.OIDC.RedirectURL != redirectURL {
		t.Fatalf("OIDC RedirectURL = %q, want %q", cfg.OIDC.RedirectURL, redirectURL)
	}
}

func TestStandaloneEventsRouteDisabled(t *testing.T) {
	t.Parallel()

	mux, err := buildAPIMux(
		http.NotFoundHandler(),
		events.NewBroker(logr.Discard()),
		logr.Discard(),
		nil,
	)
	if err != nil {
		t.Fatalf("build standalone API mux: %v", err)
	}
	assertEventsRouteDisabled(t, mux)
}

func TestOperatorEventsRouteDisabled(t *testing.T) {
	t.Parallel()

	mux := buildOperatorUIMux(
		http.NotFoundHandler(),
		http.NotFoundHandler(),
		nil,
		logr.Discard(),
	)
	assertEventsRouteDisabled(t, mux)
}

func assertEventsRouteDisabled(t *testing.T, handler http.Handler) {
	t.Helper()

	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/events?topic=dashboard", http.NoBody)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("GET /events status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
}

func TestFleetCacheDisabled(t *testing.T) {
	t.Parallel()

	fakeK8s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte(`{}`)); err != nil {
			t.Errorf("Failed to write fake Kubernetes response: %v", err)
		}
	}))
	defer fakeK8s.Close()

	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("fake-token"), 0o600); err != nil {
		t.Fatal(err)
	}

	probeAddrCh := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		errCh <- runAPIMode(ctx, &cliConfig{
			Mode:            "api",
			K8sAPIServer:    fakeK8s.URL,
			K8sTokenFile:    tokenFile,
			UIAddr:          ":0",
			ProbeAddr:       ":0",
			APICacheEnabled: false,
		}, newScheme(), logr.Discard(), probeAddrCh)
	}()

	var probeAddr string
	select {
	case probeAddr = <-probeAddrCh:
	case err := <-errCh:
		t.Fatalf("runAPIMode exited before binding: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for API mode to bind")
	}

	if err := waitForHealthz(ctx, probeAddr); err != nil {
		t.Fatalf("healthz probe failed: %v", err)
	}
	readyBody, err := waitForHTTPStatus(ctx, probeAddr, "/readyz", http.StatusServiceUnavailable)
	if err != nil {
		t.Fatalf("readyz probe failed: %v", err)
	}
	if !strings.Contains(readyBody, "--api-cache-enabled=false") {
		t.Fatalf("readyz response does not explain disabled cache: %q", readyBody)
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("runAPIMode returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for runAPIMode to exit")
	}
}

func TestRepoServerHealthEndpoint(t *testing.T) {
	t.Parallel()

	probeAddrCh := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	k8sClient := fake.NewClientBuilder().WithScheme(newScheme()).Build()

	errCh := make(chan error, 1)
	go func() {
		errCh <- runRepoServerMode(ctx, ":0", ":0", t.TempDir(), ":0", "", newScheme(), logr.Discard(), cache.Config{Backend: "memory"}, probeAddrCh, k8sClient)
	}()

	var probeAddr string
	select {
	case probeAddr = <-probeAddrCh:
	case err := <-errCh:
		t.Fatalf("runRepoServerMode exited before binding: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for repo server to bind")
	}

	if err := waitForHealthz(ctx, probeAddr); err != nil {
		t.Fatalf("healthz probe failed: %v", err)
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("runRepoServerMode returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for runRepoServerMode to exit")
	}
}

func TestFleetReadiness(t *testing.T) {
	t.Parallel()

	index := fleet.NewIndex()
	server := httptest.NewServer(buildHealthMux(logr.Discard(), fleetReadyChecker(index)))
	defer server.Close()
	addr := strings.TrimPrefix(server.URL, "http://")

	if _, err := waitForHTTPStatus(t.Context(), addr, "/healthz", http.StatusOK); err != nil {
		t.Fatalf("healthz before initial install: %v", err)
	}
	if _, err := waitForHTTPStatus(t.Context(), addr, "/readyz", http.StatusServiceUnavailable); err != nil {
		t.Fatalf("readyz before initial install: %v", err)
	}

	if err := index.Install(fleet.NewSnapshot(1)); err != nil {
		t.Fatalf("install initial snapshot: %v", err)
	}
	if _, err := waitForHTTPStatus(t.Context(), addr, "/readyz", http.StatusOK); err != nil {
		t.Fatalf("readyz after initial install: %v", err)
	}

	if err := index.SetHealth(fleet.HealthState{Ready: true, Degraded: true, Reason: "fleet rebuild degraded"}); err != nil {
		t.Fatalf("mark index degraded: %v", err)
	}
	if _, err := waitForHTTPStatus(t.Context(), addr, "/readyz", http.StatusServiceUnavailable); err != nil {
		t.Fatalf("readyz while degraded: %v", err)
	}
	if _, err := index.LoadSnapshot(); err != nil {
		t.Fatalf("degraded index should keep serving its prior snapshot: %v", err)
	}
}

func TestFleetCacheLifecycle(t *testing.T) {
	t.Run("waits for cache sync and initial index install before serving", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cache := newFakeAPICacheLifecycle()
		runtime := newFakeFleetRuntimeLifecycle()
		serveStarted := make(chan struct{})
		serveStopped := make(chan struct{})
		done := make(chan error, 1)

		go func() {
			done <- runFleetCacheLifecycle(ctx, cache, runtime, time.Second, func(ctx context.Context) error {
				close(serveStarted)
				defer close(serveStopped)
				<-ctx.Done()
				return nil
			})
		}()

		awaitSignal(t, cache.started, "cache start")
		awaitSignal(t, runtime.started, "runtime start")
		assertNoSignal(t, serveStarted, "API server before cache sync")
		close(cache.synced)
		assertNoSignal(t, serveStarted, "API server before initial index install")
		close(runtime.ready)
		awaitSignal(t, serveStarted, "API server start")

		cancel()
		if err := awaitLifecycleResult(t, done); err != nil {
			t.Fatalf("normal lifecycle shutdown: %v", err)
		}
		awaitSignal(t, cache.stopped, "cache shutdown")
		awaitSignal(t, runtime.stopped, "runtime shutdown")
		awaitSignal(t, serveStopped, "API server shutdown")
	})

	t.Run("component failure cancels and joins siblings", func(t *testing.T) {
		wantErr := errors.New("cache stopped")
		cache := newFakeAPICacheLifecycle()
		runtime := newFakeFleetRuntimeLifecycle()
		serveStarted := make(chan struct{})
		serveStopped := make(chan struct{})
		done := make(chan error, 1)

		go func() {
			done <- runFleetCacheLifecycle(t.Context(), cache, runtime, time.Second, func(ctx context.Context) error {
				close(serveStarted)
				defer close(serveStopped)
				<-ctx.Done()
				return nil
			})
		}()

		awaitSignal(t, cache.started, "cache start")
		awaitSignal(t, runtime.started, "runtime start")
		close(cache.synced)
		close(runtime.ready)
		awaitSignal(t, serveStarted, "API server start")
		cache.fail <- wantErr

		if err := awaitLifecycleResult(t, done); !errors.Is(err, wantErr) {
			t.Fatalf("lifecycle error = %v, want %v", err, wantErr)
		}
		awaitSignal(t, cache.stopped, "failed cache joined")
		awaitSignal(t, runtime.stopped, "runtime canceled and joined")
		awaitSignal(t, serveStopped, "API server canceled and joined")
	})
}

type fakeAPICacheLifecycle struct {
	started chan struct{}
	stopped chan struct{}
	synced  chan struct{}
	fail    chan error
}

func newFakeAPICacheLifecycle() *fakeAPICacheLifecycle {
	return &fakeAPICacheLifecycle{
		started: make(chan struct{}),
		stopped: make(chan struct{}),
		synced:  make(chan struct{}),
		fail:    make(chan error),
	}
}

func (f *fakeAPICacheLifecycle) Start(ctx context.Context) error {
	close(f.started)
	defer close(f.stopped)
	select {
	case err := <-f.fail:
		return err
	case <-ctx.Done():
		return nil
	}
}

func (f *fakeAPICacheLifecycle) WaitForCacheSync(ctx context.Context) bool {
	select {
	case <-f.synced:
		return true
	case <-ctx.Done():
		return false
	}
}

type fakeFleetRuntimeLifecycle struct {
	started chan struct{}
	stopped chan struct{}
	ready   chan struct{}
}

func newFakeFleetRuntimeLifecycle() *fakeFleetRuntimeLifecycle {
	return &fakeFleetRuntimeLifecycle{
		started: make(chan struct{}),
		stopped: make(chan struct{}),
		ready:   make(chan struct{}),
	}
}

func (f *fakeFleetRuntimeLifecycle) Start(ctx context.Context) error {
	close(f.started)
	defer close(f.stopped)
	<-ctx.Done()
	return nil
}

func (f *fakeFleetRuntimeLifecycle) WaitReady(ctx context.Context) error {
	select {
	case <-f.ready:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func awaitSignal(t *testing.T, signal <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatalf("timeout waiting for %s", name)
	}
}

func assertNoSignal(t *testing.T, signal <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-signal:
		t.Fatalf("unexpected %s", name)
	case <-time.After(25 * time.Millisecond):
	}
}

func awaitLifecycleResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for lifecycle result")
		return nil
	}
}

func TestBootstrapDefaultProjectsContinuesWhenOperatorNamespaceMissing(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	scheme := newScheme()
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "demo", Namespace: "paprika-e2e"},
	}
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app).
		WithInterceptorFuncs(interceptor.Funcs{
			Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
				if _, ok := obj.(*corev1alpha1.AppProject); ok && obj.GetNamespace() == "paprika-system" {
					return apierrors.NewNotFound(schema.GroupResource{Resource: "namespaces"}, obj.GetNamespace())
				}
				return c.Create(ctx, obj, opts...)
			},
		}).
		Build()

	bootstrapDefaultProjects(ctx, c, "paprika-system")

	var project corev1alpha1.AppProject
	if err := c.Get(context.Background(), client.ObjectKey{Name: "default", Namespace: "paprika-e2e"}, &project); err != nil {
		t.Fatalf("expected default AppProject in application namespace: %v", err)
	}
}

func waitForHealthz(ctx context.Context, probeAddr string) error {
	_, err := waitForHTTPStatus(ctx, probeAddr, "/healthz", http.StatusOK)
	return err
}

func waitForHTTPStatus(ctx context.Context, addr, path string, wantStatus int) (string, error) {
	url := "http://" + addr + path
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	var lastErr error
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
		if err != nil {
			return "", err
		}
		// #nosec G704 -- tests issue requests only to loopback listeners they create.
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			body, readErr := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if readErr != nil {
				return "", fmt.Errorf("read %s response: %w", path, readErr)
			}
			if resp.StatusCode == wantStatus {
				return string(body), nil
			}
			lastErr = fmt.Errorf("%s returned status %d, want %d", path, resp.StatusCode, wantStatus)
		} else {
			lastErr = err
		}

		select {
		case <-ctx.Done():
			return "", fmt.Errorf("%w: %w", ctx.Err(), lastErr)
		case <-ticker.C:
		}
	}
}

// --- Task 15: MCP wiring -----------------------------------------------
//
// These tests cover the base task (the four given in task-15-brief.md) plus
// carry-forwards CF1 and CF2 from Task 13's review (progress.md). CF3, CF4,
// and CF5 are addressed elsewhere:
//   - CF3 (nil-principal guard in negotiateScope) has its own white-box test
//     in internal/api/mcp/task15_carryforward_test.go, since negotiateScope
//     is unexported.
//   - CF4 (the /mcp/authorize browser dead-end) and CF5 (the redirect/
//     client_id enumeration oracle) are documented in task-15-report.md;
//     CF5's client_id/redirect_uri half has its own test alongside CF3's,
//     in the same file.

func TestMCPDisabledByDefault(t *testing.T) {
	cfg, err := parseManagerConfig(nil, io.Discard)
	require.NoError(t, err)
	assert.False(t, cfg.MCPEnabled, "MCP must be opt-in")
}

func TestMCPFlagsParse(t *testing.T) {
	cfg, err := parseManagerConfig(
		[]string{"--mcp-enabled", "--mcp-bind-address=:9999", "--mcp-access-token-ttl=1h"},
		io.Discard)
	require.NoError(t, err)
	assert.True(t, cfg.MCPEnabled)
	assert.Equal(t, ":9999", cfg.MCPBindAddress)
	assert.Equal(t, time.Hour, cfg.MCPAccessTokenTTL)
}

func TestMCPRedirectURIsParseFromFlagAndEnv(t *testing.T) {
	cfg, err := parseManagerConfig(
		[]string{"--mcp-oauth-redirect-uris=https://a.example/cb,https://b.example/cb"},
		io.Discard)
	require.NoError(t, err)
	assert.Equal(t, []string{"https://a.example/cb", "https://b.example/cb"}, cfg.MCPOAuthRedirectURIs)

	t.Setenv("PAPRIKA_MCP_OAUTH_REDIRECT_URIS", "https://env.example/cb, https://env2.example/cb")
	cfg, err = parseManagerConfig(nil, io.Discard)
	require.NoError(t, err)
	assert.Equal(t, []string{"https://env.example/cb", "https://env2.example/cb"}, cfg.MCPOAuthRedirectURIs)
}

func TestAPIMaxConnsFlag(t *testing.T) {
	cfg, err := parseManagerConfig(nil, io.Discard)
	require.NoError(t, err)
	assert.Equal(t, 128, cfg.APIMaxConns)

	cfg, err = parseManagerConfig([]string{"--api-max-conns=0"}, io.Discard)
	require.NoError(t, err)
	assert.Equal(t, 0, cfg.APIMaxConns)
}

func TestRunHTTPServerMaxConns(t *testing.T) {
	t.Parallel()

	release := make(chan struct{})
	srv := &http.Server{
		Addr:              "127.0.0.1:0",
		ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-release:
			case <-r.Context().Done():
			}
			w.WriteHeader(http.StatusNoContent)
		}),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	boundCh := make(chan string, 1)
	errCh := make(chan error, 1)
	go func() {
		errCh <- runHTTPServer(ctx, srv, "test server", logr.Discard(), boundCh, false, 1)
	}()

	var addr string
	select {
	case addr = <-boundCh:
	case err := <-errCh:
		t.Fatalf("runHTTPServer exited before binding: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for test server to bind")
	}

	dial := func(t *testing.T) net.Conn {
		t.Helper()
		conn, err := (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "tcp", addr)
		require.NoError(t, err)
		t.Cleanup(func() { _ = conn.Close() })
		_, err = fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: %s\r\n\r\n", addr)
		require.NoError(t, err)
		return conn
	}

	// conn1 occupies the only slot: its handler blocks until release closes.
	conn1 := dial(t)

	// conn2 connects at TCP level but is never Accept()ed while the slot is held.
	conn2 := dial(t)
	require.NoError(t, conn2.SetReadDeadline(time.Now().Add(500*time.Millisecond)))
	_, err := conn2.Read(make([]byte, 64))
	require.Error(t, err, "second connection must not be served while the limit is held")

	close(release)
	require.NoError(t, conn1.SetReadDeadline(time.Now().Add(5*time.Second)))
	code := make([]byte, 64)
	n, err := conn1.Read(code)
	require.NoError(t, err)
	assert.Contains(t, string(code[:n]), "204")

	// Freeing the slot lets the queued connection through.
	require.NoError(t, conn1.Close())
	require.NoError(t, conn2.SetReadDeadline(time.Now().Add(5*time.Second)))
	n, err = conn2.Read(code)
	require.NoError(t, err)
	assert.Contains(t, string(code[:n]), "204")

	cancel()
	select {
	case <-errCh:
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for test server to exit")
	}
}

func TestBuildMCPHandlersReturnsNothingWhenDisabled(t *testing.T) {
	handlers, err := buildMCPHandlers(context.Background(),
		&cliConfig{MCPEnabled: false}, nil, auth.Config{}, nil)
	require.NoError(t, err)
	assert.Empty(t, handlers)
}

func TestBuildMCPHandlersRequiresAuthEnabled(t *testing.T) {
	_, err := buildMCPHandlers(context.Background(),
		&cliConfig{MCPEnabled: true}, http.NewServeMux(),
		auth.Config{Enabled: false}, nil)
	require.Error(t, err,
		"MCP must refuse to start without authentication")
}

// TestBuildMCPHandlersRequiresTokenSecret guards CF2 (progress.md, Task 13's
// review): nothing enforces that mcp.ServerConfig.Secret is the same secret
// auth.Config.TokenSecret uses. If MCP is enabled with auth enabled via
// OIDC/basic auth alone and no token secret configured, buildAuthnAuthz
// never builds a self-signed authenticator, and every MCP token would be
// unverifiable. buildMCPHandlers must refuse to start in that shape too, not
// just when auth is fully disabled.
func TestBuildMCPHandlersRequiresTokenSecret(t *testing.T) {
	_, err := buildMCPHandlers(context.Background(),
		&cliConfig{
			MCPEnabled:           true,
			MCPOAuthClientID:     "test-client",
			MCPOAuthRedirectURIs: []string{"https://claude.ai/api/mcp/auth_callback"},
		},
		http.NewServeMux(),
		auth.Config{Enabled: true, TokenSecret: nil},
		nil,
	)
	require.Error(t, err,
		"MCP must refuse to start when auth is enabled but no token secret is configured")
}

// TestMCPPublicURLHasNoDefault guards Fix round 1, Finding 2
// (task-15-report.md): mcpPublicURL used to default to
// "http://localhost"+bindAddress when PAPRIKA_MCP_PUBLIC_URL was unset, so
// a misconfigured production deployment would silently advertise a
// localhost authorization server in RFC 9728/8414 discovery metadata and
// mint tokens claiming to be issued by it. There must be no default now —
// an unset env var must leave mcpPublicURL empty, so validateMCPConfig can
// fail closed instead.
func TestMCPPublicURLHasNoDefault(t *testing.T) {
	cfg, err := parseManagerConfig(nil, io.Discard)
	require.NoError(t, err)
	assert.Empty(t, cfg.MCPPublicURL, "mcpPublicURL must not default to a loopback address")
}

func TestMCPPublicURLFromEnvironment(t *testing.T) {
	t.Setenv("PAPRIKA_MCP_PUBLIC_URL", "https://paprika.example")
	cfg, err := parseManagerConfig(nil, io.Discard)
	require.NoError(t, err)
	assert.Equal(t, "https://paprika.example", cfg.MCPPublicURL)
}

// TestBuildMCPHandlersRequiresPublicURL guards Fix round 1, Finding 2
// (task-15-report.md): --mcp-enabled=true must fail at startup when
// PAPRIKA_MCP_PUBLIC_URL was never set, rather than silently running with a
// localhost authorization server identity — every other MCP precondition
// (auth enabled, token secret, client ID) already fails closed this way.
func TestBuildMCPHandlersRequiresPublicURL(t *testing.T) {
	secret := []byte("test-token-secret-test-token-sec")
	_, err := buildMCPHandlers(context.Background(),
		&cliConfig{
			MCPEnabled:           true,
			MCPOAuthClientID:     "test-client",
			MCPOAuthRedirectURIs: []string{"https://claude.ai/api/mcp/auth_callback"},
			MCPPublicURL:         "",
		},
		http.NewServeMux(),
		auth.Config{Enabled: true, TokenSecret: secret},
		&cache.Cache{},
	)
	require.Error(t, err,
		"MCP must refuse to start without an explicitly configured public URL")
}

// TestBuildMCPHandlersWiresRealClient guards CF1 (progress.md, Task 13's
// review): mcp.ServerConfig.Client is deliberately not part of
// mcp.NewServer's own required-field validation, so a production server
// built without one would start cleanly and fail every tools/call with an
// internal error. This proves buildMCPHandlers always constructs a real
// Client wired over connectHandler: a tools/call for fleet_status (which
// needs no request fields) reaches the stub PaprikaService handler and
// receives its CodeUnimplemented response, rather than the
// "no Connect client configured" error a nil Client would produce.
func TestBuildMCPHandlersWiresRealClient(t *testing.T) {
	ctx := context.Background()

	// A stub PaprikaService that only needs to prove requests actually
	// reach it — it doesn't need to implement anything for real, since
	// CF1 only tests that Server.Client is wired, not the full request
	// pipeline (that's covered by Task 13's own tests).
	_, handler := v1connect.NewPaprikaServiceHandler(v1connect.UnimplementedPaprikaServiceHandler{})

	secret := []byte("test-token-secret-test-token-sec")
	store, err := cache.New(ctx, cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)

	handlers, err := buildMCPHandlers(ctx,
		&cliConfig{
			MCPEnabled:           true,
			MCPOAuthClientID:     "test-client",
			MCPOAuthRedirectURIs: []string{"https://claude.ai/api/mcp/auth_callback"},
			MCPPublicURL:         "https://paprika.example",
			MCPAccessTokenTTL:    time.Hour,
			MCPRefreshTokenTTL:   24 * time.Hour,
		},
		handler,
		auth.Config{Enabled: true, TokenSecret: secret},
		store,
	)
	require.NoError(t, err)
	require.Len(t, handlers, 2, "buildMCPHandlers must register /mcp plus the OAuth routes")

	mux := http.NewServeMux()
	for _, h := range handlers {
		h(mux)
	}

	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject:  "task15-test",
		Audience: mcp.MCPTokenAudience,
		Scope:    string(mcp.ScopeRead),
		TTL:      time.Hour,
		Secret:   secret,
	})
	require.NoError(t, err)

	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fleet_status","arguments":{}}}`
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "the JSON-RPC envelope itself is 200 even when the tool call errors")
	respBody := rec.Body.String()
	assert.NotContains(t, respBody, "no Connect client configured",
		"buildMCPHandlers must always wire a real Client (CF1); this error string indicates a nil one")
}

// TestBuildMCPHandlersAuthorizeAcceptsAConsoleToken proves the real fix, at
// the actual production wiring level: GET /mcp/authorize must authenticate
// as a console user, not require a pre-existing MCP-audience token (the
// circular requirement this whole change exists to break). A console token
// minted with aud=paprika-api — exactly what /auth/basic-login issues, and
// what the console chain now requires strictly (see auth.ConsoleAPIAudience)
// — must be accepted here, never rejected with the 401 an MCP-audience-only
// authenticator would produce.
func TestBuildMCPHandlersAuthorizeAcceptsAConsoleToken(t *testing.T) {
	ctx := context.Background()

	_, handler := v1connect.NewPaprikaServiceHandler(v1connect.UnimplementedPaprikaServiceHandler{})

	secret := []byte("test-token-secret-test-token-sec")
	store, err := cache.New(ctx, cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)

	const redirect = "https://claude.ai/api/mcp/auth_callback"
	handlers, err := buildMCPHandlers(ctx,
		&cliConfig{
			MCPEnabled:           true,
			MCPOAuthClientID:     "test-client",
			MCPOAuthRedirectURIs: []string{redirect},
			MCPPublicURL:         "https://paprika.example",
			MCPAccessTokenTTL:    time.Hour,
			MCPRefreshTokenTTL:   24 * time.Hour,
		},
		handler,
		auth.Config{Enabled: true, TokenSecret: secret},
		store,
	)
	require.NoError(t, err)

	mux := http.NewServeMux()
	for _, h := range handlers {
		h(mux)
	}

	// A console token: aud=paprika-api, no scope claim — exactly what
	// /auth/basic-login issues, never an MCP access token.
	consoleToken, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject:  "console-user",
		Email:    "console-user@example.com",
		Name:     "Console User",
		Audience: auth.ConsoleAPIAudience,
		Secret:   secret,
	})
	require.NoError(t, err)

	query := url.Values{
		"client_id":             {"test-client"},
		"response_type":         {"code"},
		"redirect_uri":          {redirect},
		"code_challenge":        {"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"},
		"code_challenge_method": {"S256"},
	}
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/mcp/authorize?"+query.Encode(), nil)
	req.Header.Set("Authorization", "Bearer "+consoleToken)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusUnauthorized, rec.Code,
		"a console token must authenticate GET /mcp/authorize; requiring an MCP-audience token here is exactly the circular flow this fix closes")
	assert.Equal(t, http.StatusFound, rec.Code)
}

func TestWithAPIRateLimits(t *testing.T) {
	t.Parallel()

	cfg := withAPIRateLimits(&rest.Config{})
	assert.Equal(t, float32(apiClientQPS), cfg.QPS)
	assert.Equal(t, apiClientBurst, cfg.Burst)
}

func TestValidateControllerTuning(t *testing.T) {
	valid := func() *cliConfig {
		return &cliConfig{
			AppMaxConcurrentReconciles:      8,
			ReleaseMaxConcurrentReconciles:  5,
			StageMaxConcurrentReconciles:    3,
			PipelineMaxConcurrentReconciles: 3,
			AppTransientRequeue:             5 * time.Second,
			CacheResyncPeriod:               time.Hour,
			ReconcileGlobalRate:             100,
			ReconcileGlobalBurst:            200,
			ReconcileAppRate:                10,
			ReconcileAppBurst:               20,
		}
	}

	t.Run("defaults pass", func(t *testing.T) {
		require.NoError(t, validateControllerTuning(valid()))
	})

	t.Run("zero concurrency rejected", func(t *testing.T) {
		cfg := valid()
		cfg.AppMaxConcurrentReconciles = 0
		require.Error(t, validateControllerTuning(cfg))
	})

	t.Run("sub-second transient requeue rejected", func(t *testing.T) {
		cfg := valid()
		cfg.AppTransientRequeue = 100 * time.Millisecond
		require.Error(t, validateControllerTuning(cfg))
	})

	t.Run("global rate <= 0 disables limiting and relaxes app rate", func(t *testing.T) {
		cfg := valid()
		cfg.ReconcileGlobalRate = 0
		cfg.ReconcileAppRate = 0
		require.NoError(t, validateControllerTuning(cfg))
	})

	t.Run("app rate <= 0 with limiting enabled rejected", func(t *testing.T) {
		cfg := valid()
		cfg.ReconcileAppRate = 0
		require.Error(t, validateControllerTuning(cfg))
	})

	t.Run("zero burst rejected", func(t *testing.T) {
		cfg := valid()
		cfg.ReconcileGlobalBurst = 0
		require.Error(t, validateControllerTuning(cfg))
	})
}

func TestControllerTuningFlags(t *testing.T) {
	cfg, err := parseManagerConfig([]string{
		"--application-transient-requeue=15s",
		"--application-max-concurrent-reconciles=16",
		"--reconcile-global-rate=0",
		"--cache-resync-period=30m",
	}, io.Discard)
	require.NoError(t, err)
	assert.Equal(t, 15*time.Second, cfg.AppTransientRequeue)
	assert.Equal(t, 16, cfg.AppMaxConcurrentReconciles)
	assert.Equal(t, 0.0, cfg.ReconcileGlobalRate)
	assert.Equal(t, 30*time.Minute, cfg.CacheResyncPeriod)
}

// TestManagerConfigFile covers the --config YAML path: file values apply
// over defaults, env beats the file, and an explicit flag beats env.
func TestManagerConfigFile(t *testing.T) {
	dir := t.TempDir()
	configFile := filepath.Join(dir, "manager.yaml")
	require.NoError(t, os.WriteFile(configFile, []byte(`metrics-bind-address: :9090
ui-bind-address: :4000
application-transient-requeue: 30s
mcp-oauth-redirect-uris:
  - https://file.example/cb
`), 0o600))

	cfg, err := parseManagerConfig([]string{"--config", configFile}, io.Discard)
	require.NoError(t, err)
	assert.Equal(t, ":9090", cfg.MetricsAddr)
	assert.Equal(t, ":4000", cfg.UIAddr)
	assert.Equal(t, 30*time.Second, cfg.AppTransientRequeue)
	assert.Equal(t, []string{"https://file.example/cb"}, cfg.MCPOAuthRedirectURIs)
	assert.Equal(t, "operator", cfg.Mode, "unset keys keep their defaults")

	t.Run("environment overrides file", func(t *testing.T) {
		t.Setenv("PAPRIKA_UI_BIND_ADDRESS", ":5000")
		cfg, err := parseManagerConfig([]string{"--config", configFile}, io.Discard)
		require.NoError(t, err)
		assert.Equal(t, ":5000", cfg.UIAddr)
		assert.Equal(t, ":9090", cfg.MetricsAddr, "file value still applies to other keys")
	})

	t.Run("flag overrides environment and file", func(t *testing.T) {
		t.Setenv("PAPRIKA_UI_BIND_ADDRESS", ":5000")
		cfg, err := parseManagerConfig(
			[]string{"--config", configFile, "--ui-bind-address=:6000"}, io.Discard)
		require.NoError(t, err)
		assert.Equal(t, ":6000", cfg.UIAddr)
	})

	t.Run("missing file errors", func(t *testing.T) {
		_, err := parseManagerConfig(
			[]string{"--config", filepath.Join(dir, "nope.yaml")}, io.Discard)
		require.Error(t, err)
	})
}

// TestModeSubcommands proves `manager <mode>` resolves cfg.Mode identically
// to `manager --mode=<mode>` — the injected start func captures the config
// the command tree would dispatch on.
func TestModeSubcommands(t *testing.T) {
	for _, mode := range []string{"operator", "api", "webhook", "repo-server", "agent"} {
		t.Run(mode, func(t *testing.T) {
			var got *cliConfig
			cmd, _, _ := newManagerCommand(func(_ context.Context, cfg *cliConfig) error {
				got = cfg
				return nil
			})
			cmd.SetArgs([]string{mode})
			cmd.SetOut(io.Discard)
			cmd.SetErr(io.Discard)
			require.NoError(t, cmd.Execute())
			require.NotNil(t, got)
			assert.Equal(t, mode, got.Mode)
		})
	}

	t.Run("--mode still works on the root command", func(t *testing.T) {
		var got *cliConfig
		cmd, _, _ := newManagerCommand(func(_ context.Context, cfg *cliConfig) error {
			got = cfg
			return nil
		})
		cmd.SetArgs([]string{"--mode=api"})
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		require.NoError(t, cmd.Execute())
		require.NotNil(t, got)
		assert.Equal(t, "api", got.Mode)
	})
}
