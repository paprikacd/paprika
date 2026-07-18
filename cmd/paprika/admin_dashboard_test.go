/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"

	"github.com/benebsworth/paprika/internal/api/admin"
)

func TestAdminDashboardFlags(t *testing.T) {
	t.Run("defaults", func(t *testing.T) {
		var got adminDashboardOptions
		cmd := newAdminCmd(t.Context(), func(
			_ context.Context,
			opts *adminDashboardOptions,
			_, _ adminDashboardOutput,
		) error {
			got = *opts
			return nil
		})
		cmd.SetArgs([]string{"dashboard"})

		if err := cmd.ExecuteContext(t.Context()); err != nil {
			t.Fatalf("ExecuteContext() error = %v", err)
		}
		if got.LocalPort != 0 {
			t.Errorf("LocalPort = %d, want 0", got.LocalPort)
		}
		if got.Timeout != 30*time.Second {
			t.Errorf("Timeout = %s, want 30s", got.Timeout)
		}
	})

	t.Run("all supported overrides", func(t *testing.T) {
		var got adminDashboardOptions
		cmd := newAdminCmd(t.Context(), func(
			_ context.Context,
			opts *adminDashboardOptions,
			_, _ adminDashboardOutput,
		) error {
			got = *opts
			return nil
		})
		cmd.SetArgs([]string{
			"dashboard",
			"--kubeconfig=/tmp/cluster.yaml",
			"--context=omega",
			"--namespace=paprika-system",
			"--release=paprika-e2e",
			"--port=43821",
			"--no-open",
			"--timeout=45s",
			"--output=json",
		})

		if err := cmd.ExecuteContext(t.Context()); err != nil {
			t.Fatalf("ExecuteContext() error = %v", err)
		}
		if got.Kubeconfig != "/tmp/cluster.yaml" ||
			got.Context != "omega" ||
			got.Namespace != "paprika-system" ||
			got.Release != "paprika-e2e" ||
			got.LocalPort != 43821 ||
			!got.NoOpen ||
			got.Timeout != 45*time.Second ||
			got.Output != outputJSON {
			t.Fatalf("options = %#v, want all flag overrides", got)
		}
	})
}

func TestAdminDashboardFlagsUseExecuteContext(t *testing.T) {
	type contextKey struct{}
	constructorCtx := context.WithValue(t.Context(), contextKey{}, "constructor")
	executeCtx := context.WithValue(t.Context(), contextKey{}, "execute")
	var got string
	cmd := newAdminCmd(constructorCtx, func(
		ctx context.Context,
		_ *adminDashboardOptions,
		_, _ adminDashboardOutput,
	) error {
		got, _ = ctx.Value(contextKey{}).(string)
		return nil
	})
	cmd.SetArgs([]string{"dashboard"})

	if err := cmd.ExecuteContext(executeCtx); err != nil {
		t.Fatalf("ExecuteContext() error = %v", err)
	}
	if got != "execute" {
		t.Fatalf("runner context value = %q, want ExecuteContext value", got)
	}
}

func TestAdminDashboardFlagsExplainNamespaceTrustBoundary(t *testing.T) {
	var stdout bytes.Buffer
	cmd := newAdminCmd(t.Context(), func(
		context.Context,
		*adminDashboardOptions,
		adminDashboardOutput,
		adminDashboardOutput,
	) error {
		return nil
	})
	cmd.SetOut(&stdout)
	cmd.SetArgs([]string{"dashboard", "--help"})

	if err := cmd.ExecuteContext(t.Context()); err != nil {
		t.Fatalf("ExecuteContext() error = %v", err)
	}
	for _, want := range []string{
		"namespace pod-creation boundary",
		"trusted platform operators",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("help output does not contain %q:\n%s", want, stdout.String())
		}
	}
}

func TestAdminDashboardWarnsAboutFixedBrowserOriginReuse(t *testing.T) {
	t.Parallel()
	deps := testAdminDashboardDependencies(nil)
	deps.newPodLister = func(*rest.Config) (adminPodLister, error) {
		return nil, errors.New("stop after warnings")
	}
	var progress bytes.Buffer
	err := runAdminDashboardWithDependencies(
		t.Context(),
		&adminDashboardOptions{
			LocalPort: 43821,
			Timeout:   time.Second,
			Output:    outputJSON,
		},
		adminDashboardOutput{writer: io.Discard},
		adminDashboardOutput{writer: &progress},
		deps,
	)
	if err == nil || !strings.Contains(err.Error(), "stop after warnings") {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v", err)
	}
	for _, want := range []string{"fixed --port", "stable browser origin", "service-worker"} {
		if !strings.Contains(progress.String(), want) {
			t.Fatalf("fixed-port warning missing %q: %q", want, progress.String())
		}
	}
}

func TestAdminDashboardFlagsRejectYAMLBeforeKubernetesAccess(t *testing.T) {
	called := false
	cmd := newAdminCmd(t.Context(), func(
		_ context.Context,
		_ *adminDashboardOptions,
		_, _ adminDashboardOutput,
	) error {
		called = true
		return nil
	})
	cmd.SetArgs([]string{"dashboard", "--output=yaml"})

	err := cmd.ExecuteContext(t.Context())
	if err == nil || !strings.Contains(err.Error(), "YAML") {
		t.Fatalf("ExecuteContext() error = %v, want actionable YAML rejection", err)
	}
	if called {
		t.Fatal("Kubernetes runner called for rejected YAML output")
	}
}

func TestAdminDashboardFlagsJSONWritesOneReadinessObject(t *testing.T) {
	var stdout, stderr bytes.Buffer
	cmd := newAdminCmd(t.Context(), func(
		_ context.Context,
		_ *adminDashboardOptions,
		out, progress adminDashboardOutput,
	) error {
		if err := progress.WriteProgress("discovering pods"); err != nil {
			return err
		}
		return out.WriteReady(adminDashboardReady{
			Context:       "omega",
			Namespace:     "paprika-system",
			Pod:           "paprika-api-2",
			URL:           "http://127.0.0.1:43123/dashboard/",
			Subject:       "alice@example.com",
			SessionExpiry: time.Unix(4_102_444_800, 0).UTC(),
			AccessMode:    "kubernetes-port-forward-admin",
		}, outputJSON)
	})
	cmd.SetOut(&stdout)
	cmd.SetErr(&stderr)
	cmd.SetArgs([]string{"dashboard", "--output=json", "--no-open"})

	if err := cmd.ExecuteContext(t.Context()); err != nil {
		t.Fatalf("ExecuteContext() error = %v", err)
	}

	dec := json.NewDecoder(&stdout)
	var ready adminDashboardReady
	if err := dec.Decode(&ready); err != nil {
		t.Fatalf("decode readiness: %v; stdout=%q", err, stdout.String())
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err == nil {
		t.Fatalf("stdout contains more than one JSON value: %q", stdout.String())
	}
	if strings.Contains(stdout.String(), "discovering") {
		t.Fatalf("progress leaked to stdout: %q", stdout.String())
	}
	if !strings.Contains(stderr.String(), "discovering") {
		t.Fatalf("stderr = %q, want progress", stderr.String())
	}
	if ready.Pod != "paprika-api-2" {
		t.Errorf("ready.Pod = %q, want paprika-api-2", ready.Pod)
	}
	if ready.Subject != "alice@example.com" ||
		ready.AccessMode != "kubernetes-port-forward-admin" ||
		ready.SessionExpiry.IsZero() {
		t.Errorf("ready = %#v, want reviewed subject, expiry, and access mode", ready)
	}
}

func TestAdminOutputNeverIncludesCredentialsOrSessions(t *testing.T) {
	kubernetesBearer := strings.Repeat("kubernetes-bearer-", 3)
	adminSession := strings.Repeat("admin-session-", 4)
	var output bytes.Buffer
	err := (adminDashboardOutput{writer: &output}).WriteReady(adminDashboardReady{
		Context:       "omega",
		Namespace:     "paprika",
		Pod:           "api-1",
		URL:           "http://127.0.0.1:43123/dashboard/",
		Subject:       "alice@example.com",
		SessionExpiry: time.Unix(4_102_444_800, 0).UTC(),
		AccessMode:    "kubernetes-port-forward-admin",
	}, outputJSON)
	if err != nil {
		t.Fatalf("WriteReady() error = %v", err)
	}
	for _, secret := range []string{kubernetesBearer, adminSession, "Authorization", "X-Paprika-Admin-Session"} {
		if strings.Contains(output.String(), secret) {
			t.Fatalf("readiness output leaked %q: %q", secret, output.String())
		}
	}
	for _, field := range []string{
		`"context"`, `"namespace"`, `"pod"`, `"url"`,
		`"subject"`, `"sessionExpiry"`, `"accessMode"`,
	} {
		if !strings.Contains(output.String(), field) {
			t.Errorf("readiness output missing %s: %q", field, output.String())
		}
	}
}

func TestAdminRotationRefreshesAtFiveMinutesAndBrowserFailureIsNonFatal(t *testing.T) {
	var mu sync.Mutex
	tokens := []string{strings.Repeat("a", 43), strings.Repeat("b", 43)}
	current := 0
	exchanges := 0
	revoked := make(chan string, 1)
	expiry := time.Now().Add(10 * time.Minute).UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch request.URL.Path {
		case "/readyz":
			w.WriteHeader(http.StatusOK)
		case "/admin/session/exchange":
			if exchanges == 1 && request.Header.Get("X-Paprika-Admin-Session") != tokens[0] {
				t.Errorf("rotation did not present current session")
			}
			if exchanges > 0 {
				current = 1
			}
			exchanges++
			writeAdminSessionTestJSON(t, w, http.StatusCreated, map[string]any{
				"token": tokens[current],
				"session": map[string]any{
					"subject":           "alice@example.com",
					"accessMode":        "kubernetes-port-forward-admin",
					"idleExpiresAt":     expiry,
					"absoluteExpiresAt": expiry.Add(20 * time.Minute),
				},
			})
		case "/admin/session":
			if request.Method == http.MethodDelete {
				revoked <- request.Header.Get("X-Paprika-Admin-Session")
				w.WriteHeader(http.StatusNoContent)
				return
			}
			writeAdminSessionTestJSON(t, w, http.StatusOK, map[string]any{
				"subject":           "alice@example.com",
				"accessMode":        "kubernetes-port-forward-admin",
				"idleExpiresAt":     expiry,
				"absoluteExpiresAt": expiry.Add(20 * time.Minute),
			})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(t.Context())
	rotation := make(chan time.Time, 1)
	ready := make(chan struct{})
	var readyOnce sync.Once
	var stdout, stderr bytes.Buffer
	deps := testAdminDashboardDependencies(adminDashboardTestForward(
		adminSessionTestPort(t, server.URL),
	))
	useProductionAdminDashboardSession(&deps)
	deps.rotation = func(context.Context, time.Duration) adminRotationSchedule {
		return testAdminRotationSchedule(rotation)
	}
	deps.openURL = func(string) error {
		return errors.New("browser unavailable")
	}
	result := make(chan error, 1)
	go func() {
		result <- runAdminDashboardWithDependencies(
			ctx,
			&adminDashboardOptions{Timeout: time.Second, Output: outputJSON},
			adminDashboardOutput{writer: notifyWriter{
				writer: &stdout,
				notify: func() { readyOnce.Do(func() { close(ready) }) },
			}},
			adminDashboardOutput{writer: &stderr},
			deps,
		)
	}()
	<-ready
	var readiness adminDashboardReady
	if err := json.Unmarshal(stdout.Bytes(), &readiness); err != nil {
		t.Fatalf("decode printed readiness: %v", err)
	}
	liveRequest, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		readiness.URL,
		http.NoBody,
	)
	if err != nil {
		t.Fatalf("build printed URL request: %v", err)
	}
	liveResponse, err := http.DefaultClient.Do(liveRequest)
	if err != nil {
		t.Fatalf("printed URL was unusable after non-fatal browser failure: %v", err)
	}
	_ = liveResponse.Body.Close()
	rotation <- time.Now().Add(5 * time.Minute)
	deadline := time.After(time.Second)
	for {
		mu.Lock()
		count := exchanges
		mu.Unlock()
		if count == 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("five-minute refresh did not exchange a replacement session")
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	if resultErr := <-result; resultErr != nil {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v", resultErr)
	}
	if got := <-revoked; got != tokens[1] {
		t.Fatalf("revoked token was not the rotated replacement")
	}
	if !strings.Contains(stderr.String(), "browser") {
		t.Fatalf("browser launch failure was not reported non-fatally: %q", stderr.String())
	}
	closedRequest, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		readiness.URL,
		http.NoBody,
	)
	if err != nil {
		t.Fatalf("build closed proxy request: %v", err)
	}
	response, err := http.DefaultClient.Do(closedRequest)
	if err == nil {
		_ = response.Body.Close()
		t.Fatal("printed proxy URL remained reachable after shutdown")
	}
}

func TestAdminRotationFailureClosesProxyRevokesAndJoinsTunnel(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	rotation := make(chan time.Time, 1)
	ready := make(chan struct{})
	revoked := make(chan string, 1)
	tunnelJoined := make(chan struct{})
	token := strings.Repeat("s", 43)
	expiry := time.Now().Add(10 * time.Minute)
	session := &testAdminDashboardSession{
		state: adminSessionState{
			token: token,
			description: admin.SessionDescription{
				Subject:      "alice@example.com",
				AccessMode:   admin.AccessMode,
				IdleExpires:  expiry,
				AbsoluteEnds: expiry.Add(20 * time.Minute),
			},
		},
		rotateErr: errors.New("review denied"),
		revoked:   revoked,
	}
	var startedProxy *testAdminDashboardProxy
	deps := testAdminDashboardDependencies(func(
		forwardCtx context.Context,
		_ *rest.Config,
		_, _ string,
	) (adminPortForward, error) {
		done := make(chan error, 1)
		go func() {
			<-forwardCtx.Done()
			done <- nil
			close(done)
			close(tunnelJoined)
		}()
		return adminPortForward{LocalPort: 43123, Done: done, Joined: tunnelJoined}, nil
	})
	deps.newSession = func(
		*rest.Config,
		uint16,
		adminCredentialRoundTripperFactory,
		adminSelectedPodGetter,
		func() time.Time,
	) adminDashboardSession {
		return session
	}
	deps.startProxy = func(
		context.Context,
		int,
		uint16,
		*adminTokenHolder,
	) (adminDashboardProxy, error) {
		startedProxy = &testAdminDashboardProxy{done: make(chan struct{})}
		return startedProxy, nil
	}
	deps.rotation = func(context.Context, time.Duration) adminRotationSchedule {
		return testAdminRotationSchedule(rotation)
	}
	result := make(chan error, 1)
	go func() {
		result <- runAdminDashboardWithDependencies(
			ctx,
			&adminDashboardOptions{Timeout: time.Second, Output: outputJSON, NoOpen: true},
			adminDashboardOutput{writer: notifyWriter{
				writer: io.Discard,
				notify: func() { close(ready) },
			}},
			adminDashboardOutput{writer: io.Discard},
			deps,
		)
	}()
	<-ready
	rotation <- time.Now().Add(adminSessionRotationInterval)
	err := <-result
	if err == nil || !strings.Contains(err.Error(), "review denied") {
		t.Fatalf("refresh failure error = %v", err)
	}
	if got := <-revoked; got != token {
		t.Fatalf("revoked token = %q, want current token", got)
	}
	select {
	case <-startedProxy.Done():
	default:
		t.Fatal("refresh failure did not close and join the browser proxy")
	}
	select {
	case <-tunnelJoined:
	default:
		t.Fatal("refresh failure did not join the hidden tunnel")
	}
}

func TestAdminRotationValidationFailureRevokesMintedThenCurrentSession(t *testing.T) {
	oldToken := strings.Repeat("o", 43)
	newToken := strings.Repeat("n", 43)
	expiry := time.Now().Add(10 * time.Minute).UTC()
	revoked := make(chan string, 2)
	var exchanges int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/readyz":
			w.WriteHeader(http.StatusOK)
		case request.Method == http.MethodPost:
			token := oldToken
			if exchanges != 0 {
				token = newToken
				if request.Header.Get(admin.AdminSessionHeader) != oldToken {
					t.Error("rotation did not use current in-memory session")
				}
			}
			exchanges++
			writeAdminSessionTestJSON(t, w, http.StatusCreated, map[string]any{
				"token": token,
				"session": map[string]any{
					"subject":           "alice@example.com",
					"accessMode":        admin.AccessMode,
					"idleExpiresAt":     expiry,
					"absoluteExpiresAt": expiry.Add(20 * time.Minute),
				},
			})
		case request.Method == http.MethodDelete:
			token := request.Header.Get(admin.AdminSessionHeader)
			revoked <- token
			if token == oldToken {
				http.Error(w, "already invalidated", http.StatusUnauthorized)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case request.Method == http.MethodGet:
			subject := "alice@example.com"
			if request.Header.Get(admin.AdminSessionHeader) == newToken {
				subject = "unexpected@example.com"
			}
			writeAdminSessionTestJSON(t, w, http.StatusOK, map[string]any{
				"subject":           subject,
				"accessMode":        admin.AccessMode,
				"idleExpiresAt":     expiry,
				"absoluteExpiresAt": expiry.Add(20 * time.Minute),
			})
		}
	}))
	defer server.Close()
	rotation := make(chan time.Time, 1)
	ready := make(chan struct{})
	deps := testAdminDashboardDependencies(adminDashboardTestForward(
		adminSessionTestPort(t, server.URL),
	))
	useProductionAdminDashboardSession(&deps)
	deps.rotation = func(context.Context, time.Duration) adminRotationSchedule {
		return testAdminRotationSchedule(rotation)
	}
	result := make(chan error, 1)
	go func() {
		result <- runAdminDashboardWithDependencies(
			t.Context(),
			&adminDashboardOptions{Timeout: time.Second, Output: outputJSON, NoOpen: true},
			adminDashboardOutput{writer: notifyWriter{
				writer: io.Discard,
				notify: func() { close(ready) },
			}},
			adminDashboardOutput{writer: io.Discard},
			deps,
		)
	}()
	<-ready
	rotation <- time.Now().Add(adminSessionRotationInterval)
	err := <-result
	if err == nil ||
		!strings.Contains(err.Error(), "subject") ||
		!strings.Contains(err.Error(), "revoke admin session returned HTTP 401") {
		t.Fatalf("rotation failure error = %v, want validation and old-token cleanup failures", err)
	}
	if strings.Contains(err.Error(), oldToken) || strings.Contains(err.Error(), newToken) {
		t.Fatal("rotation cleanup error exposed a session token")
	}
	if first, second := <-revoked, <-revoked; first != newToken || second != oldToken {
		t.Fatalf("revocation order = [%q %q], want minted then current", first, second)
	}
}

func TestAdminShutdownRevokesBeforeTunnelAndSurfacesFailure(t *testing.T) {
	revokeAttempted := make(chan struct{})
	expiry := time.Now().Add(10 * time.Minute).UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/readyz":
			w.WriteHeader(http.StatusOK)
		case "/admin/session/exchange":
			writeAdminSessionTestJSON(t, w, http.StatusCreated, map[string]any{
				"token": strings.Repeat("s", 43),
				"session": map[string]any{
					"subject":           "alice@example.com",
					"accessMode":        "kubernetes-port-forward-admin",
					"idleExpiresAt":     expiry,
					"absoluteExpiresAt": expiry.Add(20 * time.Minute),
				},
			})
		case "/admin/session":
			if request.Method == http.MethodDelete {
				close(revokeAttempted)
				http.Error(w, "failed", http.StatusInternalServerError)
				return
			}
			writeAdminSessionTestJSON(t, w, http.StatusOK, map[string]any{
				"subject":           "alice@example.com",
				"accessMode":        "kubernetes-port-forward-admin",
				"idleExpiresAt":     expiry,
				"absoluteExpiresAt": expiry.Add(20 * time.Minute),
			})
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(t.Context())
	var stdout bytes.Buffer
	ready := make(chan struct{})
	tunnelStopped := make(chan struct{})
	deps := testAdminDashboardDependencies(func(
		forwardCtx context.Context,
		_ *rest.Config,
		_, _ string,
	) (adminPortForward, error) {
		done := make(chan error, 1)
		joined := make(chan struct{})
		go func() {
			<-forwardCtx.Done()
			select {
			case <-revokeAttempted:
			default:
				t.Error("tunnel was cancelled before revocation was attempted")
			}
			close(tunnelStopped)
			done <- nil
			close(done)
			close(joined)
		}()
		return adminPortForward{
			LocalPort: adminSessionTestPort(t, server.URL),
			Done:      done,
			Joined:    joined,
		}, nil
	})
	useProductionAdminDashboardSession(&deps)
	deps.rotation = func(context.Context, time.Duration) adminRotationSchedule {
		return testAdminRotationSchedule(make(chan time.Time))
	}
	result := make(chan error, 1)
	go func() {
		result <- runAdminDashboardWithDependencies(
			ctx,
			&adminDashboardOptions{Timeout: time.Second, Output: outputJSON, NoOpen: true},
			adminDashboardOutput{writer: notifyWriter{
				writer: &stdout,
				notify: func() { close(ready) },
			}},
			adminDashboardOutput{writer: io.Discard},
			deps,
		)
	}()
	<-ready
	cancel()
	err := <-result
	if err == nil || !strings.Contains(err.Error(), "revoke") {
		t.Fatalf("shutdown error = %v, want surfaced best-effort revoke failure", err)
	}
	select {
	case <-tunnelStopped:
	default:
		t.Fatal("dashboard returned before tunnel goroutine joined")
	}
}

func TestAdminShutdownRotationSchedulerJoins(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	schedule := adminRotationTicks(ctx, time.Hour)
	cancel()
	schedule.Stop()
	select {
	case _, ok := <-schedule.C():
		if ok {
			t.Fatal("rotation scheduler emitted after shutdown")
		}
	default:
		t.Fatal("rotation scheduler Stop returned before its goroutine joined")
	}
}

func TestAdminShutdownSignalsCancelContext(t *testing.T) {
	t.Parallel()
	for _, shutdownSignal := range []os.Signal{os.Interrupt, syscall.SIGTERM} {
		shutdownSignal := shutdownSignal
		t.Run(shutdownSignal.String(), func(t *testing.T) {
			t.Parallel()
			delivered := make(chan os.Signal, 1)
			var requested []os.Signal
			notify := func(
				parent context.Context,
				signals ...os.Signal,
			) (context.Context, context.CancelFunc) {
				requested = append([]os.Signal(nil), signals...)
				ctx, cancel := context.WithCancel(parent)
				go func() {
					select {
					case <-delivered:
						cancel()
					case <-ctx.Done():
					}
				}()
				return ctx, cancel
			}
			ctx, stop := adminDashboardSignalContext(t.Context(), notify)
			defer stop()
			delivered <- shutdownSignal
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
				t.Fatalf("%s did not cancel the dashboard context", shutdownSignal)
			}
			if len(requested) != 2 ||
				requested[0] != os.Interrupt ||
				requested[1] != syscall.SIGTERM {
				t.Fatalf("registered signals = %v, want SIGINT and SIGTERM", requested)
			}
		})
	}
}

func TestAdminKubeconfigFailurePrecedesDiscoveryAndReadiness(t *testing.T) {
	tests := []struct {
		name string
		auth clientcmdapi.AuthInfo
	}{
		{
			name: "client certificate only",
			auth: clientcmdapi.AuthInfo{
				ClientCertificateData: []byte("certificate"),
				ClientKeyData:         []byte("key"),
			},
		},
		{
			name: "request signing only",
			auth: clientcmdapi.AuthInfo{
				AuthProvider: &clientcmdapi.AuthProviderConfig{Name: "gcp"},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			kubeconfigPath := filepath.Join(t.TempDir(), "config")
			err := clientcmd.WriteToFile(clientcmdapi.Config{
				Clusters: map[string]*clientcmdapi.Cluster{
					"cluster": {Server: "https://cluster.invalid"},
				},
				AuthInfos: map[string]*clientcmdapi.AuthInfo{
					"user": &tt.auth,
				},
				Contexts: map[string]*clientcmdapi.Context{
					"omega": {Cluster: "cluster", AuthInfo: "user", Namespace: "paprika"},
				},
				CurrentContext: "omega",
			}, kubeconfigPath)
			if err != nil {
				t.Fatalf("write kubeconfig: %v", err)
			}

			var stdout, stderr bytes.Buffer
			discovered := false
			deps := testAdminDashboardDependencies(nil)
			deps.loadKubeconfig = loadAdminKubeconfig
			deps.newPodLister = func(*rest.Config) (adminPodLister, error) {
				discovered = true
				return nil, errors.New("must not discover")
			}

			err = runAdminDashboardWithDependencies(
				t.Context(),
				&adminDashboardOptions{
					Kubeconfig: kubeconfigPath,
					Timeout:    time.Second,
					Output:     outputJSON,
				},
				adminDashboardOutput{writer: &stdout},
				adminDashboardOutput{writer: &stderr},
				deps,
			)
			if err == nil || !strings.Contains(err.Error(), "OIDC") {
				t.Fatalf("runAdminDashboardWithDependencies() error = %v", err)
			}
			if discovered {
				t.Fatal("pod discovery ran after unsupported credentials")
			}
			if stdout.Len() != 0 {
				t.Fatalf("readiness output emitted after unsupported credentials: %q", stdout.String())
			}
		})
	}
}

func TestAdminKubeconfigCredentialFactoryFailsClosedAndRedacts(t *testing.T) {
	credential := strings.Repeat("s", 43)
	var stdout, stderr bytes.Buffer
	discovered := false
	deps := testAdminDashboardDependencies(nil)
	deps.loadKubeconfig = func(
		context.Context,
		*adminDashboardOptions,
	) (*adminKubeconfig, error) {
		return &adminKubeconfig{
			RESTConfig: &rest.Config{Host: "https://cluster.invalid", BearerToken: credential},
			Context:    "omega",
			Namespace:  "paprika",
		}, nil
	}
	deps.credentials = func(*rest.Config, http.RoundTripper) (http.RoundTripper, error) {
		return nil, fmt.Errorf("credential wrapper unavailable for %s", credential)
	}
	deps.newPodLister = func(*rest.Config) (adminPodLister, error) {
		discovered = true
		return nil, errors.New("must not discover")
	}

	err := runAdminDashboardWithDependencies(
		t.Context(),
		&adminDashboardOptions{Timeout: time.Second, Output: outputJSON},
		adminDashboardOutput{writer: &stdout},
		adminDashboardOutput{writer: &stderr},
		deps,
	)
	if err == nil || !strings.Contains(err.Error(), "credential wrapper unavailable") {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v", err)
	}
	if discovered {
		t.Fatal("pod discovery ran after credential transport failure")
	}
	for name, value := range map[string]string{
		"error":  err.Error(),
		"stdout": stdout.String(),
		"stderr": stderr.String(),
	} {
		if strings.Contains(value, credential) || strings.Contains(value, "Authorization") {
			t.Fatalf("%s leaked credential material: %q", name, value)
		}
	}
	if !strings.Contains(err.Error(), "[REDACTED]") {
		t.Fatalf("credential failure was not visibly redacted: %v", err)
	}
}

func TestAdminSessionTrustWarningPrecedesCredentialExchange(t *testing.T) {
	var progress bytes.Buffer
	deps := testAdminDashboardDependencies(nil)
	deps.credentials = func(*rest.Config, http.RoundTripper) (http.RoundTripper, error) {
		for _, warning := range []string{
			"namespace pod-creation boundary",
			"trusted platform operators",
		} {
			if !strings.Contains(progress.String(), warning) {
				t.Errorf("credential exchange began before %q was emitted: %q", warning, progress.String())
			}
		}
		return nil, errors.New("stop after ordering assertion")
	}
	err := runAdminDashboardWithDependencies(
		t.Context(),
		&adminDashboardOptions{Timeout: time.Second, Output: outputJSON},
		adminDashboardOutput{writer: io.Discard},
		adminDashboardOutput{writer: &progress},
		deps,
	)
	if err == nil || !strings.Contains(err.Error(), "stop after ordering assertion") {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v", err)
	}
}

func TestAdminShutdownSignalsRevokeAndJoin(t *testing.T) {
	for _, shutdownSignal := range []os.Signal{os.Interrupt, syscall.SIGTERM} {
		shutdownSignal := shutdownSignal
		t.Run(shutdownSignal.String(), func(t *testing.T) {
			delivered := make(chan os.Signal, 1)
			notify := func(
				parent context.Context,
				_ ...os.Signal,
			) (context.Context, context.CancelFunc) {
				ctx, cancel := context.WithCancel(parent)
				go func() {
					select {
					case <-delivered:
						cancel()
					case <-ctx.Done():
					}
				}()
				return ctx, cancel
			}
			signalCtx, stopSignals := adminDashboardSignalContext(t.Context(), notify)
			defer stopSignals()
			ready := make(chan struct{})
			tunnelJoined := make(chan struct{})
			revoked := make(chan string, 1)
			token := strings.Repeat("s", 43)
			expiry := time.Now().Add(10 * time.Minute)
			session := &testAdminDashboardSession{
				state: adminSessionState{
					token: token,
					description: admin.SessionDescription{
						Subject:      "alice@example.com",
						AccessMode:   admin.AccessMode,
						IdleExpires:  expiry,
						AbsoluteEnds: expiry.Add(20 * time.Minute),
					},
				},
				revoked: revoked,
			}
			deps := testAdminDashboardDependencies(func(
				forwardCtx context.Context,
				_ *rest.Config,
				_, _ string,
			) (adminPortForward, error) {
				done := make(chan error, 1)
				go func() {
					<-forwardCtx.Done()
					done <- nil
					close(done)
					close(tunnelJoined)
				}()
				return adminPortForward{
					LocalPort: 43123,
					Done:      done,
					Joined:    tunnelJoined,
				}, nil
			})
			deps.newSession = func(
				*rest.Config,
				uint16,
				adminCredentialRoundTripperFactory,
				adminSelectedPodGetter,
				func() time.Time,
			) adminDashboardSession {
				return session
			}
			result := make(chan error, 1)
			go func() {
				result <- runAdminDashboardWithDependencies(
					signalCtx,
					&adminDashboardOptions{
						Timeout: time.Second,
						Output:  outputJSON,
						NoOpen:  true,
					},
					adminDashboardOutput{writer: notifyWriter{
						writer: io.Discard,
						notify: func() { close(ready) },
					}},
					adminDashboardOutput{writer: io.Discard},
					deps,
				)
			}()
			<-ready
			delivered <- shutdownSignal
			if err := <-result; err != nil {
				t.Fatalf("%s shutdown error = %v", shutdownSignal, err)
			}
			if got := <-revoked; got != token {
				t.Fatal("signal shutdown did not revoke the current session")
			}
			select {
			case <-tunnelJoined:
			default:
				t.Fatal("signal shutdown returned before the tunnel joined")
			}
		})
	}
}

func TestAdminSIGINTShutdownBoundsStuckProxyAndTunnel(t *testing.T) {
	t.Parallel()
	delivered := make(chan os.Signal, 1)
	notify := func(
		parent context.Context,
		_ ...os.Signal,
	) (context.Context, context.CancelFunc) {
		ctx, cancel := context.WithCancel(parent)
		go func() {
			select {
			case <-delivered:
				cancel()
			case <-ctx.Done():
			}
		}()
		return ctx, cancel
	}
	signalCtx, stopSignals := adminDashboardSignalContext(t.Context(), notify)
	defer stopSignals()
	token := strings.Repeat("s", 43)
	expiry := time.Now().Add(10 * time.Minute)
	session := &testAdminDashboardSession{state: adminSessionState{
		token: token,
		description: admin.SessionDescription{
			Subject:      "alice@example.com",
			AccessMode:   admin.AccessMode,
			IdleExpires:  expiry,
			AbsoluteEnds: expiry.Add(20 * time.Minute),
		},
	}}
	forwardCancelled := make(chan struct{})
	deps := testAdminDashboardDependencies(func(
		forwardCtx context.Context,
		_ *rest.Config,
		_, _ string,
	) (adminPortForward, error) {
		go func() {
			<-forwardCtx.Done()
			close(forwardCancelled)
		}()
		return adminPortForward{
			LocalPort: 43123,
			Done:      make(chan error),
			Joined:    make(chan struct{}),
		}, nil
	})
	deps.newSession = func(
		*rest.Config,
		uint16,
		adminCredentialRoundTripperFactory,
		adminSelectedPodGetter,
		func() time.Time,
	) adminDashboardSession {
		return session
	}
	var holder *adminTokenHolder
	proxy := &deadlineAdminDashboardProxy{done: make(chan struct{})}
	deps.startProxy = func(
		_ context.Context,
		_ int,
		_ uint16,
		gotHolder *adminTokenHolder,
	) (adminDashboardProxy, error) {
		holder = gotHolder
		return proxy, nil
	}
	ready := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- runAdminDashboardWithDependencies(
			signalCtx,
			&adminDashboardOptions{Timeout: 20 * time.Millisecond, Output: outputJSON, NoOpen: true},
			adminDashboardOutput{writer: notifyWriter{
				writer: io.Discard,
				notify: func() { close(ready) },
			}},
			adminDashboardOutput{writer: io.Discard},
			deps,
		)
	}()
	<-ready
	delivered <- os.Interrupt
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) ||
			!strings.Contains(err.Error(), "proxy") ||
			!strings.Contains(err.Error(), "completion") {
			t.Fatalf("SIGINT shutdown error = %v, want bounded joined cleanup errors", err)
		}
	case <-time.After(time.Second):
		t.Fatal("SIGINT shutdown blocked on stuck proxy or tunnel")
	}
	if holder == nil || holder.Current() != "" {
		t.Fatal("SIGINT timeout returned before clearing the holder credential")
	}
	if !proxy.forced {
		t.Fatal("SIGINT timeout did not force-close the proxy")
	}
	select {
	case <-forwardCancelled:
	case <-time.After(time.Second):
		t.Fatal("SIGINT timeout did not cancel the forwarding tunnel")
	}
}

func TestAdminShutdownOrdersAdmissionRevokeClearProxyAndTunnel(t *testing.T) {
	tests := []struct {
		name       string
		revokeMode string
		wantError  bool
	}{
		{name: "success"},
		{name: "revoke error", revokeMode: "error", wantError: true},
		{name: "revoke timeout", revokeMode: "timeout", wantError: true},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			token := strings.Repeat("s", 43)
			holder := newAdminTokenHolder(token)
			_, releaseActive, err := holder.Acquire(t.Context())
			if err != nil {
				t.Fatalf("Acquire() error = %v", err)
			}
			defer releaseActive()
			events := make(chan string, 3)
			session := &orderedAdminDashboardSession{
				revoke: func(ctx context.Context, gotToken string) error {
					events <- "revoke"
					if gotToken != token || holder.Current() != token {
						t.Error("shutdown cleared or changed the retained token before DELETE")
					}
					admissionCtx, cancelAdmission := context.WithTimeout(
						ctx,
						50*time.Millisecond,
					)
					defer cancelAdmission()
					started := time.Now()
					if _, release, acquireErr := holder.Acquire(admissionCtx); acquireErr == nil {
						release()
						t.Error("new browser request admitted after shutdown began")
					}
					if time.Since(started) > 20*time.Millisecond {
						t.Error("shutdown admission rejection waited instead of failing immediately")
					}
					switch tt.revokeMode {
					case "error":
						return errors.New("delete failed")
					case "timeout":
						<-ctx.Done()
						return ctx.Err()
					default:
						return nil
					}
				},
			}
			proxy := &orderedAdminDashboardProxy{
				close: func(context.Context) error {
					events <- "proxy"
					if holder.Current() != "" {
						t.Error("proxy closed before the local token was cleared")
					}
					return nil
				},
				done: make(chan struct{}),
			}
			forwardCtx, cancelForward := context.WithCancel(t.Context())
			done := make(chan error, 1)
			joined := make(chan struct{})
			go func() {
				<-forwardCtx.Done()
				events <- "tunnel"
				done <- nil
				close(done)
				close(joined)
			}()
			err = shutdownAdminDashboard(
				t.Context(),
				10*time.Millisecond,
				session,
				holder,
				proxy,
				func() {},
				cancelForward,
				adminPortForward{LocalPort: 43123, Done: done, Joined: joined},
				false,
				nil,
				nil,
			)
			if (err != nil) != tt.wantError {
				t.Fatalf("shutdown error = %v, wantError %v", err, tt.wantError)
			}
			gotEvents := []string{<-events, <-events, <-events}
			if strings.Join(gotEvents, ",") != "revoke,proxy,tunnel" {
				t.Fatalf("shutdown order = %v, want revoke, proxy, tunnel", gotEvents)
			}
		})
	}
}

func TestAdminOrphanReplacementCleanupIsBoundedAndRedacted(t *testing.T) {
	t.Parallel()
	token := strings.Repeat("private-orphan-session-", 2)
	revokeStarted := make(chan struct{})
	session := &orderedAdminDashboardSession{
		revoke: func(ctx context.Context, gotToken string) error {
			if gotToken != token {
				t.Fatal("orphan cleanup received the wrong replacement")
			}
			close(revokeStarted)
			<-ctx.Done()
			return ctx.Err()
		},
	}
	cleanup := boundedAdminOrphanCleanup(t.Context(), 20*time.Millisecond, session)
	started := time.Now()
	err := cleanup(token)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("orphan cleanup error = %v, want bounded deadline", err)
	}
	if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
		t.Fatalf("orphan cleanup exceeded its deadline by blocking for %s", elapsed)
	}
	select {
	case <-revokeStarted:
	default:
		t.Fatal("orphan cleanup did not attempt authenticated DELETE")
	}
	if strings.Contains(err.Error(), token) {
		t.Fatal("orphan cleanup error leaked the replacement token")
	}
}

func TestAdminProxyValidationUsesInjectedExpiryBoundary(t *testing.T) {
	t.Parallel()
	fixedNow := time.Date(2031, time.February, 3, 4, 5, 6, 0, time.UTC)
	description := admin.SessionDescription{
		Subject:      "alice@example.com",
		AccessMode:   admin.AccessMode,
		IdleExpires:  fixedNow,
		AbsoluteEnds: fixedNow.Add(time.Minute),
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeAdminSessionTestJSON(t, w, http.StatusOK, map[string]any{
			"subject":           description.Subject,
			"accessMode":        description.AccessMode,
			"idleExpiresAt":     description.IdleExpires,
			"absoluteExpiresAt": description.AbsoluteEnds,
		})
	}))
	defer server.Close()

	err := validateAdminProxySession(t.Context(), server.URL, description, fixedNow)
	if err == nil || !strings.Contains(err.Error(), "expiry") {
		t.Fatalf("validateAdminProxySession() error = %v, want deterministic boundary rejection", err)
	}
}

func TestAdminShutdownBoundsTunnelCompletionAndJoin(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		tunnel adminPortForward
		want   string
	}{
		{
			name:   "completion",
			tunnel: adminPortForward{Done: make(chan error)},
			want:   "completion",
		},
		{
			name: "join",
			tunnel: adminPortForward{
				Done:   func() <-chan error { result := make(chan error, 1); result <- nil; return result }(),
				Joined: make(chan struct{}),
			},
			want: "join",
		},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			cancelled := false
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
			defer cancel()
			started := time.Now()
			err := finishAdminForwardForShutdown(
				ctx,
				func() { cancelled = true },
				tt.tunnel,
				false,
				nil,
				nil,
			)
			if !cancelled {
				t.Fatal("shutdown did not force-cancel the forwarding tunnel")
			}
			if !errors.Is(err, context.DeadlineExceeded) ||
				!strings.Contains(err.Error(), tt.want) {
				t.Fatalf("finishAdminForwardForShutdown() error = %v, want bounded %s timeout", err, tt.want)
			}
			if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
				t.Fatalf("tunnel shutdown blocked for %s after deadline", elapsed)
			}
		})
	}
}

func TestAdminShutdownDeadlineClearsHolderAndContinuesForcedCleanup(t *testing.T) {
	t.Parallel()
	holder := newAdminTokenHolder(strings.Repeat("s", 43))
	proxy := &deadlineAdminDashboardProxy{done: make(chan struct{})}
	forwardCancelled := false
	err := shutdownAdminDashboard(
		t.Context(),
		20*time.Millisecond,
		&testAdminDashboardSession{},
		holder,
		proxy,
		func() {},
		func() { forwardCancelled = true },
		adminPortForward{LocalPort: 43123, Done: make(chan error)},
		false,
		nil,
		nil,
	)
	if !errors.Is(err, context.DeadlineExceeded) ||
		!strings.Contains(err.Error(), "proxy") ||
		!strings.Contains(err.Error(), "completion") {
		t.Fatalf("shutdownAdminDashboard() error = %v, want joined proxy and tunnel deadlines", err)
	}
	if holder.Current() != "" {
		t.Fatal("shutdown deadline returned while the session credential remained retained")
	}
	if !proxy.forced {
		t.Fatal("proxy deadline did not invoke the forced close path")
	}
	if !forwardCancelled {
		t.Fatal("proxy timeout prevented forwarding tunnel cancellation")
	}
}

func TestAdminPortForwardWorkflowJoinsSetupTimeout(t *testing.T) {
	joined := make(chan struct{})
	deps := testAdminDashboardDependencies(func(
		ctx context.Context,
		_ *rest.Config,
		_, _ string,
	) (adminPortForward, error) {
		<-ctx.Done()
		close(joined)
		return adminPortForward{}, errors.New("forward setup cleanup failed")
	})

	err := runAdminDashboardWithDependencies(
		t.Context(),
		&adminDashboardOptions{Timeout: 10 * time.Millisecond, Output: outputJSON},
		adminDashboardOutput{writer: io.Discard},
		adminDashboardOutput{writer: io.Discard},
		deps,
	)
	select {
	case <-joined:
	default:
		t.Fatal("dashboard returned before the in-flight forwarding setup completed")
	}
	if err == nil ||
		!strings.Contains(err.Error(), context.DeadlineExceeded.Error()) ||
		!strings.Contains(err.Error(), "forward setup cleanup failed") {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v, want timeout and joined setup error", err)
	}
}

func TestAdminPortForwardWorkflowJoinsOutputFailure(t *testing.T) {
	joined := make(chan struct{})
	deps := testAdminDashboardDependencies(func(
		ctx context.Context,
		_ *rest.Config,
		_, _ string,
	) (adminPortForward, error) {
		done := make(chan error, 1)
		go func() {
			<-ctx.Done()
			close(joined)
			done <- errors.New("tunnel cleanup failed")
			close(done)
		}()
		return adminPortForward{LocalPort: 43123, Done: done}, nil
	})

	err := runAdminDashboardWithDependencies(
		t.Context(),
		&adminDashboardOptions{Timeout: time.Second, Output: outputJSON},
		adminDashboardOutput{writer: errorWriter{err: errors.New("readiness write failed")}},
		adminDashboardOutput{writer: io.Discard},
		deps,
	)
	select {
	case <-joined:
	default:
		t.Fatal("dashboard returned before the active tunnel completed")
	}
	if err == nil ||
		!strings.Contains(err.Error(), "readiness write failed") ||
		!strings.Contains(err.Error(), "tunnel cleanup failed") {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v, want output and joined tunnel errors", err)
	}
}

func TestAdminPortForwardWorkflowWaitsForTunnelGoroutineAfterDone(t *testing.T) {
	release := make(chan struct{})
	joined := make(chan struct{})
	cancelled := make(chan struct{})
	deps := testAdminDashboardDependencies(func(
		ctx context.Context,
		_ *rest.Config,
		_, _ string,
	) (adminPortForward, error) {
		done := make(chan error, 1)
		go func() {
			<-ctx.Done()
			close(cancelled)
			done <- errors.New("tunnel stopped")
			close(done)
			<-release
			close(joined)
		}()
		return adminPortForward{LocalPort: 43123, Done: done, Joined: joined}, nil
	})
	result := make(chan error, 1)
	go func() {
		result <- runAdminDashboardWithDependencies(
			t.Context(),
			&adminDashboardOptions{Timeout: time.Second, Output: outputJSON},
			adminDashboardOutput{writer: errorWriter{err: errors.New("readiness write failed")}},
			adminDashboardOutput{writer: io.Discard},
			deps,
		)
	}()
	<-cancelled
	select {
	case err := <-result:
		close(release)
		t.Fatalf("dashboard returned before tunnel goroutine joined: %v", err)
	default:
	}
	close(release)
	err := <-result
	if err == nil ||
		!strings.Contains(err.Error(), "readiness write failed") ||
		!strings.Contains(err.Error(), "tunnel stopped") {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v", err)
	}
}

func TestAdminPortForwardWorkflowJoinsSpontaneousTunnelFailure(t *testing.T) {
	release := make(chan struct{})
	joined := make(chan struct{})
	doneSent := make(chan struct{})
	deps := testAdminDashboardDependencies(func(
		context.Context,
		*rest.Config,
		string,
		string,
	) (adminPortForward, error) {
		done := make(chan error, 1)
		go func() {
			done <- errors.New("pod connection lost")
			close(done)
			close(doneSent)
			<-release
			close(joined)
		}()
		return adminPortForward{LocalPort: 43123, Done: done, Joined: joined}, nil
	})
	result := make(chan error, 1)
	go func() {
		result <- runAdminDashboardWithDependencies(
			t.Context(),
			&adminDashboardOptions{Timeout: time.Second, Output: outputJSON},
			adminDashboardOutput{writer: io.Discard},
			adminDashboardOutput{writer: io.Discard},
			deps,
		)
	}()
	<-doneSent
	select {
	case err := <-result:
		close(release)
		t.Fatalf("dashboard returned before failed tunnel goroutine joined: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	err := <-result
	if err == nil || !strings.Contains(err.Error(), "pod connection lost") {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v", err)
	}
}

func TestAdminPortForwardWorkflowJoinsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	joined := make(chan struct{})
	deps := testAdminDashboardDependencies(func(
		forwardCtx context.Context,
		_ *rest.Config,
		_, _ string,
	) (adminPortForward, error) {
		done := make(chan error, 1)
		go func() {
			<-forwardCtx.Done()
			close(joined)
			done <- nil
			close(done)
		}()
		return adminPortForward{LocalPort: 43123, Done: done}, nil
	})
	var stdout, progress bytes.Buffer

	err := runAdminDashboardWithDependencies(
		ctx,
		&adminDashboardOptions{Timeout: time.Second, Output: outputJSON},
		adminDashboardOutput{writer: cancelWriter{writer: &stdout, cancel: cancel}},
		adminDashboardOutput{writer: &progress},
		deps,
	)
	if err != nil {
		t.Fatalf("runAdminDashboardWithDependencies() error = %v", err)
	}
	select {
	case <-joined:
	default:
		t.Fatal("dashboard returned before the cancelled tunnel completed")
	}
	if lines := strings.Count(strings.TrimSpace(stdout.String()), "\n") + 1; lines != 1 {
		t.Fatalf("stdout contains %d readiness lines: %q", lines, stdout.String())
	}
	for _, want := range []string{
		"namespace pod-creation boundary",
		"trusted platform operators",
	} {
		if !strings.Contains(progress.String(), want) {
			t.Errorf("runtime warning does not contain %q: %q", want, progress.String())
		}
	}
}

type errorWriter struct {
	err error
}

func (w errorWriter) Write([]byte) (int, error) {
	return 0, w.err
}

type cancelWriter struct {
	writer io.Writer
	cancel context.CancelFunc
}

type notifyWriter struct {
	writer io.Writer
	notify func()
}

type testAdminDashboardSession struct {
	state     adminSessionState
	rotateErr error
	revokeErr error
	revoked   chan string
}

type orderedAdminDashboardSession struct {
	revoke func(context.Context, string) error
}

func (*orderedAdminDashboardSession) AwaitAndExchange(
	context.Context,
	*corev1.Pod,
) (adminSessionState, error) {
	return adminSessionState{}, errors.New("not used")
}

func (*orderedAdminDashboardSession) Rotate(
	context.Context,
	*corev1.Pod,
	string,
) (adminSessionState, error) {
	return adminSessionState{}, errors.New("not used")
}

func (session *orderedAdminDashboardSession) Revoke(
	ctx context.Context,
	token string,
) error {
	return session.revoke(ctx, token)
}

type orderedAdminDashboardProxy struct {
	close func(context.Context) error
	done  chan struct{}
}

type deadlineAdminDashboardProxy struct {
	done   chan struct{}
	forced bool
}

func (*deadlineAdminDashboardProxy) URL() string {
	return "http://127.0.0.1:43124"
}

func (proxy *deadlineAdminDashboardProxy) Done() <-chan struct{} {
	return proxy.done
}

func (proxy *deadlineAdminDashboardProxy) Close(ctx context.Context) error {
	<-ctx.Done()
	proxy.forced = true
	return fmt.Errorf("force close browser proxy: %w", ctx.Err())
}

func (*orderedAdminDashboardProxy) URL() string {
	return "http://127.0.0.1:43124"
}

func (proxy *orderedAdminDashboardProxy) Done() <-chan struct{} {
	return proxy.done
}

func (proxy *orderedAdminDashboardProxy) Close(ctx context.Context) error {
	return proxy.close(ctx)
}

func (session *testAdminDashboardSession) AwaitAndExchange(
	context.Context,
	*corev1.Pod,
) (adminSessionState, error) {
	return session.state, nil
}

func (session *testAdminDashboardSession) Rotate(
	context.Context,
	*corev1.Pod,
	string,
) (adminSessionState, error) {
	if session.rotateErr != nil {
		return adminSessionState{}, session.rotateErr
	}
	return session.state, nil
}

func (session *testAdminDashboardSession) Revoke(_ context.Context, token string) error {
	if session.revoked != nil {
		session.revoked <- token
	}
	return session.revokeErr
}

type testAdminDashboardProxy struct {
	done chan struct{}
	once sync.Once
}

func (proxy *testAdminDashboardProxy) URL() string {
	return "http://127.0.0.1:43124"
}

func (proxy *testAdminDashboardProxy) Done() <-chan struct{} {
	return proxy.done
}

func (proxy *testAdminDashboardProxy) Close(context.Context) error {
	proxy.once.Do(func() { close(proxy.done) })
	return nil
}

func (w notifyWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	if w.notify != nil {
		w.notify()
	}
	return n, err
}

func adminDashboardTestForward(
	port uint16,
) func(context.Context, *rest.Config, string, string) (adminPortForward, error) {
	return func(
		ctx context.Context,
		_ *rest.Config,
		_, _ string,
	) (adminPortForward, error) {
		done := make(chan error, 1)
		joined := make(chan struct{})
		go func() {
			<-ctx.Done()
			done <- nil
			close(done)
			close(joined)
		}()
		return adminPortForward{LocalPort: port, Done: done, Joined: joined}, nil
	}
}

func useProductionAdminDashboardSession(deps *adminDashboardDependencies) {
	deps.newSession = func(
		config *rest.Config,
		port uint16,
		credentials adminCredentialRoundTripperFactory,
		pods adminSelectedPodGetter,
		now func() time.Time,
	) adminDashboardSession {
		client := newAdminSessionClient(config, port, credentials, pods)
		client.now = now
		return client
	}
	deps.startProxy = func(
		ctx context.Context,
		localPort int,
		upstreamPort uint16,
		holder *adminTokenHolder,
	) (adminDashboardProxy, error) {
		return startAdminProxy(ctx, localPort, upstreamPort, holder)
	}
	deps.validateProxy = validateAdminProxySession
}

func testAdminRotationSchedule(ticks <-chan time.Time) adminRotationSchedule {
	return adminRotationSchedule{
		ticks: ticks,
		stop:  func() {},
	}
}

func (w cancelWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	w.cancel()
	return n, err
}

func testAdminDashboardDependencies(
	forward func(context.Context, *rest.Config, string, string) (adminPortForward, error),
) adminDashboardDependencies {
	if forward == nil {
		forward = func(
			context.Context,
			*rest.Config,
			string,
			string,
		) (adminPortForward, error) {
			return adminPortForward{}, errors.New("forward must not run")
		}
	}
	return adminDashboardDependencies{
		loadKubeconfig: func(
			context.Context,
			*adminDashboardOptions,
		) (*adminKubeconfig, error) {
			return &adminKubeconfig{
				RESTConfig: &rest.Config{
					Host:        "https://cluster.invalid",
					BearerToken: strings.Repeat("k", 32),
				},
				Context:   "omega",
				Namespace: "paprika",
			}, nil
		},
		newPodLister: func(*rest.Config) (adminPodLister, error) {
			return func(
				context.Context,
				string,
				metav1.ListOptions,
			) (*corev1.PodList, error) {
				return &corev1.PodList{Items: []corev1.Pod{{
					ObjectMeta: metav1.ObjectMeta{
						Namespace: "paprika",
						Name:      "api-1",
						UID:       "api-1-uid",
						Labels: map[string]string{
							"app.kubernetes.io/name":       "paprika",
							"app.kubernetes.io/managed-by": "Helm",
							"app.kubernetes.io/instance":   "paprika",
							"app.kubernetes.io/component":  "api-server",
						},
					},
					Status: corev1.PodStatus{Conditions: []corev1.PodCondition{{
						Type: corev1.PodReady, Status: corev1.ConditionTrue,
					}}},
				}}}, nil
			}, nil
		},
		newReviewer: func(*rest.Config) (adminAccessReviewer, error) {
			return func(
				context.Context,
				*authorizationv1.SelfSubjectAccessReview,
			) (*authorizationv1.SelfSubjectAccessReview, error) {
				return &authorizationv1.SelfSubjectAccessReview{
					Status: authorizationv1.SubjectAccessReviewStatus{Allowed: true},
				}, nil
			}, nil
		},
		forward:     forward,
		credentials: adminCredentialRoundTripper,
		now:         time.Now,
		newSession: func(
			_ *rest.Config,
			_ uint16,
			_ adminCredentialRoundTripperFactory,
			_ adminSelectedPodGetter,
			now func() time.Time,
		) adminDashboardSession {
			expiry := now().Add(10 * time.Minute)
			return &testAdminDashboardSession{state: adminSessionState{
				token: strings.Repeat("s", 43),
				description: admin.SessionDescription{
					Subject:      "alice@example.com",
					AccessMode:   admin.AccessMode,
					IdleExpires:  expiry,
					AbsoluteEnds: expiry.Add(20 * time.Minute),
				},
			}}
		},
		startProxy: func(
			context.Context,
			int,
			uint16,
			*adminTokenHolder,
		) (adminDashboardProxy, error) {
			return &testAdminDashboardProxy{done: make(chan struct{})}, nil
		},
		validateProxy: func(
			context.Context,
			string,
			admin.SessionDescription,
			time.Time,
		) error {
			return nil
		},
		rotation: func(context.Context, time.Duration) adminRotationSchedule {
			return testAdminRotationSchedule(make(chan time.Time))
		},
		openURL: func(string) error { return nil },
	}
}
