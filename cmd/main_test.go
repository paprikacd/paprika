package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-logr/logr"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/admin"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/fleet"
)

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

func TestNormalListenerAdminSessionRoutesAreExactlyNotFound(t *testing.T) {
	t.Parallel()

	standalone, err := buildAPIMux(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "ordinary auth required", http.StatusUnauthorized)
		}),
		events.NewBroker(logr.Discard()),
		logr.Discard(),
		nil,
	)
	if err != nil {
		t.Fatalf("build standalone API mux: %v", err)
	}
	operator := buildOperatorUIMux(
		http.NotFoundHandler(),
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}),
		nil,
		logr.Discard(),
	)

	for name, handler := range map[string]http.Handler{
		"standalone": standalone,
		"operator":   operator,
	} {
		for _, path := range []string{"/admin/session", "/admin/session/"} {
			request := httptest.NewRequestWithContext(
				t.Context(),
				http.MethodGet,
				path,
				http.NoBody,
			)
			request.Header.Set("X-Paprika-Admin-Session", "spoofed-session")
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusNotFound {
				t.Errorf("%s GET %s status = %d, want %d", name, path, recorder.Code, http.StatusNotFound)
			}
		}
	}
}

func TestNormalListenerSessionHeaderDoesNotInstallAdminContext(t *testing.T) {
	t.Parallel()

	connectCalled := false
	connectHandler := http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		connectCalled = true
		if _, ok := admin.SessionDescriptionFromContext(request.Context()); ok {
			t.Error("normal listener installed an admin session context")
		}
		http.Error(w, "ordinary auth required", http.StatusUnauthorized)
	})
	mux, err := buildAPIMux(
		connectHandler,
		events.NewBroker(logr.Discard()),
		logr.Discard(),
		nil,
	)
	if err != nil {
		t.Fatalf("build standalone API mux: %v", err)
	}
	request := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodPost,
		"/paprika.v1.PaprikaService/QueryFleetMap",
		http.NoBody,
	)
	request.Header.Set("X-Paprika-Admin-Session", "spoofed-session")
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	if !connectCalled {
		t.Fatal("normal Connect handler was not called")
	}
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("normal Connect status = %d, want %d", recorder.Code, http.StatusUnauthorized)
	}
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
			mode:            "api",
			k8sAPIServer:    fakeK8s.URL,
			k8sTokenFile:    tokenFile,
			uiAddr:          ":0",
			probeAddr:       ":0",
			apiCacheEnabled: false,
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
		errCh <- runRepoServerMode(ctx, ":0", ":0", t.TempDir(), ":0", newScheme(), logr.Discard(), cache.Config{Backend: "memory"}, probeAddrCh, k8sClient)
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
