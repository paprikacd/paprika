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
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/rest"

	"github.com/benebsworth/paprika/internal/api/admin"
)

func TestAdminSessionExchangeValidatesReadyAndDescription(t *testing.T) {
	t.Parallel()
	token := strings.Repeat("s", 43)
	bearer := strings.Repeat("k", 32)
	expiry := time.Now().Add(10 * time.Minute).UTC()
	var sequence []string
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		mu.Lock()
		sequence = append(sequence, request.Method+" "+request.URL.Path)
		mu.Unlock()
		if request.Host != adminUpstreamHost {
			t.Errorf("Host = %q, want %q", request.Host, adminUpstreamHost)
		}
		switch request.URL.Path {
		case "/readyz":
			w.WriteHeader(http.StatusOK)
		case "/admin/session/exchange":
			if request.Header.Get("Authorization") != "Bearer "+bearer {
				t.Error("exchange did not use the production credential wrapper")
			}
			if request.Header.Get("Origin") != adminUpstreamOrigin {
				t.Errorf("exchange Origin = %q", request.Header.Get("Origin"))
			}
			writeAdminSessionTestJSON(t, w, http.StatusCreated, map[string]any{
				"token": token,
				"session": map[string]any{
					"subject":           "alice@example.com",
					"accessMode":        admin.AccessMode,
					"idleExpiresAt":     expiry,
					"absoluteExpiresAt": expiry.Add(20 * time.Minute),
				},
			})
		case "/admin/session":
			if request.Header.Get(admin.AdminSessionHeader) != token {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			writeAdminSessionTestJSON(t, w, http.StatusOK, map[string]any{
				"subject":           "alice@example.com",
				"accessMode":        admin.AccessMode,
				"idleExpiresAt":     expiry,
				"absoluteExpiresAt": expiry.Add(20 * time.Minute),
			})
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()

	selected := adminSessionTestPod("paprika", "api-1", "pod-uid-1")
	client := newAdminSessionClient(
		&rest.Config{Host: "https://cluster.invalid", BearerToken: bearer},
		adminSessionTestPort(t, server.URL),
		adminCredentialRoundTripper,
		adminSessionTestGetter(selected),
	)
	state, err := client.AwaitAndExchange(
		t.Context(),
		selected,
	)
	if err != nil {
		t.Fatalf("AwaitAndExchange() error = %v", err)
	}
	if state.token != token ||
		state.description.Subject != "alice@example.com" ||
		state.description.AccessMode != admin.AccessMode ||
		!state.description.IdleExpires.Equal(expiry) {
		t.Fatalf("state = %#v, want validated reviewed session", state)
	}
	mu.Lock()
	gotSequence := append([]string(nil), sequence...)
	mu.Unlock()
	wantSequence := "GET /readyz|POST /admin/session/exchange|GET /admin/session"
	if strings.Join(gotSequence, "|") != wantSequence {
		t.Fatalf("request sequence = %q, want %q", gotSequence, wantSequence)
	}
}

func TestAdminSessionFailsClosed(t *testing.T) {
	t.Parallel()
	expiry := time.Now().Add(10 * time.Minute).UTC()
	validExchange := func(token string) map[string]any {
		return map[string]any{
			"token": token,
			"session": map[string]any{
				"subject":           "alice@example.com",
				"accessMode":        admin.AccessMode,
				"idleExpiresAt":     expiry,
				"absoluteExpiresAt": expiry.Add(20 * time.Minute),
			},
		}
	}
	tests := []struct {
		name    string
		pod     *corev1.Pod
		handler http.Handler
		want    string
		timeout time.Duration
	}{
		{
			name: "disabled listener",
			pod:  adminSessionTestPod("paprika", "api-1", "uid"),
			handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				http.NotFound(w, request)
			}),
			want:    "readiness",
			timeout: 15 * time.Millisecond,
		},
		{
			name: "TokenReview denial is unauthorized",
			pod:  adminSessionTestPod("paprika", "api-1", "uid"),
			handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/readyz" {
					w.WriteHeader(http.StatusOK)
					return
				}
				http.Error(w, "unauthorized", http.StatusUnauthorized)
			}),
			want: "401",
		},
		{
			name: "SubjectAccessReview denial is forbidden",
			pod:  adminSessionTestPod("paprika", "api-1", "uid"),
			handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/readyz" {
					w.WriteHeader(http.StatusOK)
					return
				}
				http.Error(w, "forbidden", http.StatusForbidden)
			}),
			want: "403",
		},
		{
			name: "malformed exchange",
			pod:  adminSessionTestPod("paprika", "api-1", "uid"),
			handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/readyz" {
					w.WriteHeader(http.StatusOK)
					return
				}
				w.WriteHeader(http.StatusCreated)
				_, _ = io.WriteString(w, `{"token":`)
			}),
			want: "decode",
		},
		{
			name: "description subject differs from reviewed exchange",
			pod:  adminSessionTestPod("paprika", "api-1", "uid"),
			handler: adminSessionTestHandler(t, validExchange("session"), map[string]any{
				"subject":           "mallory@example.com",
				"accessMode":        admin.AccessMode,
				"idleExpiresAt":     expiry,
				"absoluteExpiresAt": expiry.Add(20 * time.Minute),
			}),
			want: "subject",
		},
		{
			name: "wrong access mode",
			pod:  adminSessionTestPod("paprika", "api-1", "uid"),
			handler: adminSessionTestHandler(t, validExchange("session"), map[string]any{
				"subject":           "alice@example.com",
				"accessMode":        "ordinary",
				"idleExpiresAt":     expiry,
				"absoluteExpiresAt": expiry.Add(20 * time.Minute),
			}),
			want: "access mode",
		},
		{
			name: "selected pod identity incomplete",
			pod:  adminSessionTestPod("paprika", "api-1", ""),
			handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				t.Error("HTTP request made with an incomplete selected pod identity")
				w.WriteHeader(http.StatusOK)
			}),
			want: "pod identity",
		},
		{
			name: "timeout",
			pod:  adminSessionTestPod("paprika", "api-1", "uid"),
			handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				http.Error(w, "not ready", http.StatusServiceUnavailable)
			}),
			want:    "deadline",
			timeout: 15 * time.Millisecond,
		},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(tt.handler)
			defer server.Close()
			ctx := t.Context()
			if tt.timeout > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, tt.timeout)
				defer cancel()
			}
			client := newAdminSessionClient(
				&rest.Config{Host: "https://cluster.invalid", BearerToken: strings.Repeat("k", 32)},
				adminSessionTestPort(t, server.URL),
				adminCredentialRoundTripper,
				adminSessionTestGetter(tt.pod),
			)
			_, err := client.AwaitAndExchange(ctx, tt.pod)
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tt.want)) {
				t.Fatalf("AwaitAndExchange() error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestAdminSessionDisabledListenerConnectionRefusalTimesOut(t *testing.T) {
	t.Parallel()
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve loopback port: %v", err)
	}
	_, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatalf("split reserved listener address: %v", err)
	}
	var port uint16
	if _, err = fmt.Sscanf(portText, "%d", &port); err != nil {
		t.Fatalf("parse reserved listener port: %v", err)
	}
	if closeErr := listener.Close(); closeErr != nil {
		t.Fatalf("close reserved listener: %v", closeErr)
	}
	selected := adminSessionTestPod("paprika", "api-1", "uid")
	client := newAdminSessionClient(
		&rest.Config{Host: "https://cluster.invalid", BearerToken: strings.Repeat("k", 32)},
		port,
		adminCredentialRoundTripper,
		adminSessionTestGetter(selected),
	)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	_, err = client.AwaitAndExchange(ctx, selected)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "deadline") {
		t.Fatalf("AwaitAndExchange() error = %v, want bounded disabled-listener deadline", err)
	}
}

func TestAdminSessionRevokesMintedTokenWhenValidationFails(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		current string
	}{
		{name: "initial exchange"},
		{name: "rotation invalidates old and cleans replacement", current: strings.Repeat("o", 43)},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			minted := strings.Repeat("n", 43)
			expiry := time.Now().Add(10 * time.Minute).UTC()
			revoked := make(chan string, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				switch {
				case request.URL.Path == "/readyz":
					w.WriteHeader(http.StatusOK)
				case request.Method == http.MethodPost:
					if request.Header.Get(admin.AdminSessionHeader) != tt.current {
						t.Errorf("current session header = %q", request.Header.Get(admin.AdminSessionHeader))
					}
					writeAdminSessionTestJSON(t, w, http.StatusCreated, map[string]any{
						"token": minted,
						"session": map[string]any{
							"subject":           "alice@example.com",
							"accessMode":        admin.AccessMode,
							"idleExpiresAt":     expiry,
							"absoluteExpiresAt": expiry.Add(20 * time.Minute),
						},
					})
				case request.Method == http.MethodGet:
					writeAdminSessionTestJSON(t, w, http.StatusOK, map[string]any{
						"subject":           "mallory@example.com",
						"accessMode":        admin.AccessMode,
						"idleExpiresAt":     expiry,
						"absoluteExpiresAt": expiry.Add(20 * time.Minute),
					})
				case request.Method == http.MethodDelete:
					revoked <- request.Header.Get(admin.AdminSessionHeader)
					w.WriteHeader(http.StatusNoContent)
				}
			}))
			defer server.Close()
			selected := adminSessionTestPod("paprika", "api-1", "uid")
			client := newAdminSessionClient(
				&rest.Config{Host: "https://cluster.invalid", BearerToken: strings.Repeat("k", 32)},
				adminSessionTestPort(t, server.URL),
				adminCredentialRoundTripper,
				adminSessionTestGetter(selected),
			)
			var exchangeErr error
			if tt.current == "" {
				_, exchangeErr = client.AwaitAndExchange(t.Context(), selected)
			} else {
				_, exchangeErr = client.Rotate(t.Context(), selected, tt.current)
			}
			if exchangeErr == nil || !strings.Contains(exchangeErr.Error(), "subject") {
				t.Fatalf("exchange error = %v, want validation failure", exchangeErr)
			}
			select {
			case got := <-revoked:
				if got != minted {
					t.Fatal("cleanup did not revoke the newly minted token")
				}
			case <-time.After(time.Second):
				t.Fatal("validation failure did not attempt minted-token cleanup")
			}
		})
	}
}

func TestAdminSessionReportsMintedTokenCleanupFailureWithoutSecret(t *testing.T) {
	t.Parallel()
	minted := strings.Repeat("private-minted-token", 3)
	expiry := time.Now().Add(10 * time.Minute).UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/readyz":
			w.WriteHeader(http.StatusOK)
		case request.Method == http.MethodPost:
			writeAdminSessionTestJSON(t, w, http.StatusCreated, map[string]any{
				"token": minted,
				"session": map[string]any{
					"subject":           "alice@example.com",
					"accessMode":        admin.AccessMode,
					"idleExpiresAt":     expiry,
					"absoluteExpiresAt": expiry.Add(20 * time.Minute),
				},
			})
		case request.Method == http.MethodGet:
			http.Error(w, "unknown", http.StatusInternalServerError)
		case request.Method == http.MethodDelete:
			http.Error(w, "failed", http.StatusInternalServerError)
		}
	}))
	defer server.Close()
	selected := adminSessionTestPod("paprika", "api-1", "uid")
	client := newAdminSessionClient(
		&rest.Config{Host: "https://cluster.invalid", BearerToken: strings.Repeat("k", 32)},
		adminSessionTestPort(t, server.URL),
		adminCredentialRoundTripper,
		adminSessionTestGetter(selected),
	)
	_, err := client.AwaitAndExchange(t.Context(), selected)
	if err == nil ||
		!strings.Contains(err.Error(), "description returned HTTP 500") ||
		!strings.Contains(err.Error(), "revoke minted admin session") {
		t.Fatalf("AwaitAndExchange() error = %v, want validation and cleanup failures", err)
	}
	if strings.Contains(err.Error(), minted) {
		t.Fatal("minted-token cleanup error exposed the token")
	}
}

func TestAdminSessionMintedCleanupSurvivesCancelledParent(t *testing.T) {
	t.Parallel()
	minted := strings.Repeat("n", 43)
	revoked := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodDelete ||
			request.Header.Get(admin.AdminSessionHeader) != minted {
			t.Errorf("cleanup request = %s with unexpected session", request.Method)
		}
		close(revoked)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	selected := adminSessionTestPod("paprika", "api-1", "uid")
	client := newAdminSessionClient(
		&rest.Config{Host: "https://cluster.invalid"},
		adminSessionTestPort(t, server.URL),
		adminCredentialRoundTripper,
		adminSessionTestGetter(selected),
	)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	primary := errors.New("description validation failed")
	err := client.cleanupMintedSession(ctx, minted, primary)
	if !errors.Is(err, primary) {
		t.Fatalf("cleanup error = %v, want original validation failure", err)
	}
	select {
	case <-revoked:
	case <-time.After(time.Second):
		t.Fatal("cancelled parent prevented WithoutCancel minted-token cleanup")
	}
}

func TestAdminSessionRevalidatesExactReadyPodBeforeEveryExchange(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		mutate func(*corev1.Pod)
	}{
		{name: "terminating", mutate: func(pod *corev1.Pod) {
			now := metav1.Now()
			pod.DeletionTimestamp = &now
		}},
		{name: "unready", mutate: func(pod *corev1.Pod) {
			pod.Status.Conditions[0].Status = corev1.ConditionFalse
		}},
		{name: "wrong UID", mutate: func(pod *corev1.Pod) { pod.UID = "other-uid" }},
		{name: "wrong name", mutate: func(pod *corev1.Pod) { pod.Name = "other-pod" }},
		{name: "wrong namespace", mutate: func(pod *corev1.Pod) { pod.Namespace = "other" }},
		{name: "ineligible component", mutate: func(pod *corev1.Pod) {
			delete(pod.Labels, "app.kubernetes.io/component")
		}},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			exchanges := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if request.URL.Path == "/readyz" {
					w.WriteHeader(http.StatusOK)
					return
				}
				exchanges++
				t.Error("exchange ran after selected pod identity or readiness changed")
				http.Error(w, "unexpected", http.StatusInternalServerError)
			}))
			defer server.Close()
			expected := adminSessionTestPod("paprika", "api-1", "uid")
			current := expected.DeepCopy()
			tt.mutate(current)
			client := newAdminSessionClient(
				&rest.Config{Host: "https://cluster.invalid", BearerToken: strings.Repeat("k", 32)},
				adminSessionTestPort(t, server.URL),
				adminCredentialRoundTripper,
				adminSessionTestGetter(current),
			)
			_, initialErr := client.AwaitAndExchange(t.Context(), expected)
			if initialErr == nil || !strings.Contains(initialErr.Error(), "pod") {
				t.Fatalf("initial exchange error = %v, want selected pod rejection", initialErr)
			}
			_, rotationErr := client.Rotate(t.Context(), expected, strings.Repeat("o", 43))
			if rotationErr == nil || !strings.Contains(rotationErr.Error(), "pod") {
				t.Fatalf("rotation error = %v, want selected pod rejection", rotationErr)
			}
			if exchanges != 0 {
				t.Fatalf("exchange count = %d, want 0", exchanges)
			}
		})
	}
}

func TestAdminSessionRotationUsesCurrentSessionAndRevokesReplacement(t *testing.T) {
	t.Parallel()
	oldToken := strings.Repeat("o", 43)
	newToken := strings.Repeat("n", 43)
	expiry := time.Now().Add(10 * time.Minute).UTC()
	var rotated, revoked bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodPost:
			rotated = request.Header.Get(admin.AdminSessionHeader) == oldToken
			writeAdminSessionTestJSON(t, w, http.StatusCreated, map[string]any{
				"token": newToken,
				"session": map[string]any{
					"subject":           "alice@example.com",
					"accessMode":        admin.AccessMode,
					"idleExpiresAt":     expiry,
					"absoluteExpiresAt": expiry.Add(20 * time.Minute),
				},
			})
		case request.Method == http.MethodGet:
			writeAdminSessionTestJSON(t, w, http.StatusOK, map[string]any{
				"subject":           "alice@example.com",
				"accessMode":        admin.AccessMode,
				"idleExpiresAt":     expiry,
				"absoluteExpiresAt": expiry.Add(20 * time.Minute),
			})
		case request.Method == http.MethodDelete:
			revoked = request.Header.Get(admin.AdminSessionHeader) == newToken &&
				request.Header.Get("Origin") == adminUpstreamOrigin
			http.Error(w, "revoke failed", http.StatusInternalServerError)
		}
	}))
	defer server.Close()
	client := newAdminSessionClient(
		&rest.Config{Host: "https://cluster.invalid", BearerToken: strings.Repeat("k", 32)},
		adminSessionTestPort(t, server.URL),
		adminCredentialRoundTripper,
		adminSessionTestGetter(adminSessionTestPod("paprika", "api-1", "uid")),
	)
	state, err := client.Rotate(
		t.Context(),
		adminSessionTestPod("paprika", "api-1", "uid"),
		oldToken,
	)
	if err != nil {
		t.Fatalf("Rotate() error = %v", err)
	}
	if !rotated || state.token != newToken {
		t.Fatalf("rotation current header = %v, state token updated = %v", rotated, state.token == newToken)
	}
	err = client.Revoke(t.Context(), state.token)
	if err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("Revoke() error = %v, want surfaced best-effort failure", err)
	}
	if !revoked {
		t.Fatal("Revoke() did not attempt authenticated deletion")
	}
}

func TestAdminSessionNormalizesMissingResponsesAndBodies(t *testing.T) {
	t.Parallel()
	token := strings.Repeat("s", 43)
	tests := []struct {
		name      string
		response  *http.Response
		invoke    func(*adminSessionClient) error
		wantError string
	}{
		{
			name: "revoke nil response",
			invoke: func(client *adminSessionClient) error {
				return client.Revoke(t.Context(), token)
			},
			wantError: "no response",
		},
		{
			name:      "ready nil response",
			invoke:    func(client *adminSessionClient) error { _, err := client.readyStatus(t.Context()); return err },
			wantError: "no response",
		},
		{
			name: "describe nil response",
			invoke: func(client *adminSessionClient) error {
				_, err := client.describe(t.Context(), token)
				return err
			},
			wantError: "no response",
		},
		{
			name:     "revoke nil body",
			response: &http.Response{StatusCode: http.StatusNoContent, Header: make(http.Header)},
			invoke: func(client *adminSessionClient) error {
				return client.Revoke(t.Context(), token)
			},
		},
		{
			name:     "ready nil body",
			response: &http.Response{StatusCode: http.StatusOK, Header: make(http.Header)},
			invoke:   func(client *adminSessionClient) error { _, err := client.readyStatus(t.Context()); return err },
		},
		{
			name:     "describe nil body",
			response: &http.Response{StatusCode: http.StatusOK, Header: make(http.Header)},
			invoke: func(client *adminSessionClient) error {
				_, err := client.describe(t.Context(), token)
				return err
			},
			wantError: "empty",
		},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			client := &adminSessionClient{
				endpoint: "http://127.0.0.1:43123",
				transport: adminRoundTripperFunc(func(*http.Request) (*http.Response, error) {
					return tt.response, nil
				}),
			}
			var err error
			func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						t.Fatalf("admin response handling panicked: %v", recovered)
					}
				}()
				err = tt.invoke(client)
			}()
			if tt.wantError == "" {
				if err != nil {
					t.Fatalf("operation error = %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantError) {
				t.Fatalf("operation error = %v, want %q", err, tt.wantError)
			}
		})
	}
}

func TestAdminSessionValidationUsesInjectedExpiryBoundary(t *testing.T) {
	t.Parallel()
	fixedNow := time.Date(2030, time.January, 2, 3, 4, 5, 0, time.UTC)
	token := strings.Repeat("s", 43)
	revoked := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/readyz":
			w.WriteHeader(http.StatusOK)
		case request.Method == http.MethodPost:
			writeAdminSessionTestJSON(t, w, http.StatusCreated, map[string]any{
				"token": token,
				"session": map[string]any{
					"subject":           "alice@example.com",
					"accessMode":        admin.AccessMode,
					"idleExpiresAt":     fixedNow,
					"absoluteExpiresAt": fixedNow.Add(time.Minute),
				},
			})
		case request.Method == http.MethodGet:
			writeAdminSessionTestJSON(t, w, http.StatusOK, map[string]any{
				"subject":           "alice@example.com",
				"accessMode":        admin.AccessMode,
				"idleExpiresAt":     fixedNow,
				"absoluteExpiresAt": fixedNow.Add(time.Minute),
			})
		case request.Method == http.MethodDelete:
			revoked = true
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()
	selected := adminSessionTestPod("paprika", "api-1", "uid")
	client := newAdminSessionClient(
		&rest.Config{Host: "https://cluster.invalid", BearerToken: strings.Repeat("k", 32)},
		adminSessionTestPort(t, server.URL),
		adminCredentialRoundTripper,
		adminSessionTestGetter(selected),
	)
	client.now = func() time.Time { return fixedNow }
	_, err := client.AwaitAndExchange(t.Context(), selected)
	if err == nil || !strings.Contains(err.Error(), "expiry") {
		t.Fatalf("AwaitAndExchange() error = %v, want injected boundary expiry rejection", err)
	}
	if !revoked {
		t.Fatal("injected boundary validation did not clean up the minted session")
	}
}

func adminSessionTestHandler(
	t *testing.T,
	exchange, description map[string]any,
) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/readyz":
			w.WriteHeader(http.StatusOK)
		case "/admin/session/exchange":
			writeAdminSessionTestJSON(t, w, http.StatusCreated, exchange)
		case "/admin/session":
			writeAdminSessionTestJSON(t, w, http.StatusOK, description)
		default:
			http.NotFound(w, request)
		}
	})
}

func writeAdminSessionTestJSON(t *testing.T, w http.ResponseWriter, status int, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Errorf("encode response: %v", err)
	}
}

func adminSessionTestPort(t *testing.T, rawURL string) uint16 {
	t.Helper()
	host := strings.TrimPrefix(rawURL, "http://")
	_, portText, err := net.SplitHostPort(host)
	if err != nil {
		t.Fatalf("SplitHostPort(%q): %v", host, err)
	}
	var port uint16
	if _, err := fmt.Sscanf(portText, "%d", &port); err != nil {
		t.Fatalf("parse port %q: %v", portText, err)
	}
	return port
}

func adminSessionTestPod(namespace, name, uid string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: namespace,
			Name:      name,
			UID:       types.UID(uid),
			Labels: map[string]string{
				"app.kubernetes.io/component": "api-server",
			},
		},
		Status: corev1.PodStatus{Conditions: []corev1.PodCondition{{
			Type: corev1.PodReady, Status: corev1.ConditionTrue,
		}}},
	}
}

func adminSessionTestGetter(pod *corev1.Pod) adminSelectedPodGetter {
	return func(context.Context, string, string) (*corev1.Pod, error) {
		return pod.DeepCopy(), nil
	}
}
