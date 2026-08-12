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
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLoginBrowserOIDCFlow(t *testing.T) { //nolint:gocyclo // The end-to-end fixture asserts the complete browser/token/config contract.
	resetLoginGlobals(t)

	const (
		state         = "state-marker"
		verifier      = "verifier-kept-in-memory"
		code          = "authorization-code-marker"
		oldToken      = "old-token-marker"
		identity      = "developer@example.com"
		callbackURI   = "http://127.0.0.1:17632/callback"
		callbackQuery = "redirect_uri=http%3A%2F%2F127.0.0.1%3A17632%2Fcallback"
	)
	expiresAt := time.Now().Add(time.Hour).Truncate(time.Second).UTC()
	idToken := testJWT(t, map[string]any{
		"sub":                "subject-marker",
		"email":              identity,
		"preferred_username": "username-marker",
		"exp":                expiresAt.Unix(),
	})

	allowToken := make(chan struct{})
	tokenStarted := make(chan struct{})
	var tokenCalls atomic.Int32
	var fakeServer *httptest.Server
	fakeServer = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/login":
			if r.Method != http.MethodGet {
				t.Errorf("login method = %s, want GET", r.Method)
			}
			if r.URL.RawQuery != callbackQuery {
				t.Errorf("login raw query = %q, want %q", r.URL.RawQuery, callbackQuery)
			}
			writeTestJSON(t, w, map[string]any{
				"url":          fakeServer.URL + "/provider?state=" + state,
				"codeVerifier": verifier,
				"state":        state,
			})
		case "/provider":
			http.Redirect(w, r, callbackURI+"?code="+code+"&state="+state, http.StatusFound)
		case "/auth/token":
			tokenCalls.Add(1)
			defer r.Body.Close()
			var got struct {
				Code         string `json:"code"`
				CodeVerifier string `json:"codeVerifier"`
				RedirectURI  string `json:"redirectUri"`
			}
			if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
				t.Errorf("decode token request: %v", err)
			}
			if got.Code != code || got.CodeVerifier != verifier || got.RedirectURI != callbackURI {
				t.Errorf("token request = %#v", got)
			}
			close(tokenStarted)
			<-allowToken
			writeTestJSON(t, w, map[string]any{
				"idToken":   idToken,
				"expiresIn": 1,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer fakeServer.Close()

	configPath := filepath.Join(t.TempDir(), "config.yaml")
	original := &Config{
		Server:    "https://old.example.com",
		Namespace: "production",
		Username:  "basic-user",
		Password:  "basic-password-marker",
		Token:     oldToken,
	}
	if err := original.Save(configPath); err != nil {
		t.Fatalf("save original config: %v", err)
	}

	browserOutput := installFakeBrowser(t)
	var stdout, stderr strings.Builder
	done := make(chan error, 1)
	go func() {
		done <- run(context.Background(), []string{
			"--config", configPath,
			"--server", fakeServer.URL,
			"login",
		}, os.Getenv, strings.NewReader(""), &stdout, &stderr)
	}()

	select {
	case <-tokenStarted:
	case err := <-done:
		t.Fatalf("login exited before token exchange: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("token exchange did not start")
	}
	//nolint:gosec // browserOutput is rooted in t.TempDir and controlled by this test.
	if page, err := os.ReadFile(browserOutput); err == nil && strings.Contains(string(page), "Login successful") {
		t.Fatal("browser reported success before token exchange completed")
	}
	close(allowToken)

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("login returned error: %v\nstderr: %s", err, &stderr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("login did not complete")
	}

	got, err := loadConfig(configPath)
	if err != nil {
		t.Fatalf("load updated config: %v", err)
	}
	if got.Server != fakeServer.URL {
		t.Errorf("server = %q, want %q", got.Server, fakeServer.URL)
	}
	if got.Namespace != original.Namespace || got.Username != original.Username || got.Password != original.Password {
		t.Errorf("preserved config fields changed: %#v", got)
	}
	if got.Token != idToken {
		t.Errorf("token was not replaced after successful exchange")
	}
	if !got.TokenExpiresAt.Equal(expiresAt) {
		t.Errorf("token expiry = %s, want JWT exp %s", got.TokenExpiresAt, expiresAt)
	}
	if tokenCalls.Load() != 1 {
		t.Errorf("token calls = %d, want 1", tokenCalls.Load())
	}
	if !strings.Contains(stdout.String(), identity) {
		t.Errorf("stdout = %q, want identity %q", &stdout, identity)
	}
	page, err := waitForFile(browserOutput, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(page), "Login successful") {
		t.Errorf("browser page = %q, want success", page)
	}
}

func TestLoginPersistsSuppliedServerValue(t *testing.T) {
	resetLoginGlobals(t)
	exp := time.Now().Add(time.Hour).Truncate(time.Second)
	token := testJWT(t, map[string]any{"sub": "subject-marker", "exp": exp.Unix()})
	server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
		writeTestJSON(t, w, map[string]any{"idToken": token})
	})
	defer server.Close()
	path, _ := writeLoginConfig(t, &Config{Server: "https://old.example.com"})
	globalConfigPath = path
	globalServer = server.URL + "/"
	dependencies := defaultLoginDependencies()
	dependencies.callbackTimeout = time.Second
	dependencies.openBrowser = callbackBrowser("/callback?code=code-marker&state=expected-state", make(chan string, 1))

	if err := executeLogin(context.Background(), &strings.Builder{}, dependencies); err != nil {
		t.Fatalf("executeLogin() error = %v", err)
	}
	config, err := loadConfig(path)
	if err != nil {
		t.Fatalf("load saved config: %v", err)
	}
	if config.Server != globalServer {
		t.Errorf("saved server = %q, want supplied value %q", config.Server, globalServer)
	}
}

func TestLoginRequiresServerWithoutChangingConfig(t *testing.T) {
	resetLoginGlobals(t)
	path, before := writeLoginConfig(t, &Config{Namespace: "production", Token: "old-token-marker"})
	globalConfigPath = path

	err := executeLogin(context.Background(), &strings.Builder{}, defaultLoginDependencies())
	if err == nil || !strings.Contains(err.Error(), "server URL is not configured") {
		t.Fatalf("executeLogin() error = %v, want missing server error", err)
	}
	assertConfigSnapshot(t, path, before)
}

func TestLoginRejectsOccupiedCallbackPortWithoutChangingConfig(t *testing.T) {
	resetLoginGlobals(t)
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", loginCallbackAddress)
	if err != nil {
		t.Fatalf("occupy callback port: %v", err)
	}
	defer listener.Close()
	path, before := writeLoginConfig(t, &Config{Server: "http://localhost:3000", Token: "old-token-marker"})
	globalConfigPath = path

	err = executeLogin(context.Background(), &strings.Builder{}, defaultLoginDependencies())
	if err == nil || !strings.Contains(err.Error(), "callback URI "+loginCallbackURI+" is unavailable") {
		t.Fatalf("executeLogin() error = %v, want occupied port error", err)
	}
	assertNoMarkers(t, err.Error(), "bind", "listen tcp", "address already in use")
	assertConfigSnapshot(t, path, before)
}

func TestLoginCallbackValidationIsTerminalAndDoesNotExchange(t *testing.T) {
	tests := []struct {
		name  string
		query string
	}{
		{name: "missing code", query: "state=expected-state"},
		{name: "provider error", query: "error=access_denied&error_description=provider-secret-marker&state=expected-state"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetLoginGlobals(t)
			var tokenCalls atomic.Int32
			server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
				tokenCalls.Add(1)
				http.Error(w, "token-secret-marker", http.StatusUnauthorized)
			})
			defer server.Close()
			path, before := writeLoginConfig(t, &Config{Server: server.URL, Token: "old-token-marker"})
			globalConfigPath = path
			browserPage := make(chan string, 1)
			dependencies := defaultLoginDependencies()
			dependencies.callbackTimeout = time.Second
			dependencies.openBrowser = callbackBrowser("/callback?"+tt.query, browserPage)

			var output strings.Builder
			err := executeLogin(context.Background(), &output, dependencies)
			if !errors.Is(err, errAuthenticationFailed) {
				t.Fatalf("executeLogin() error = %v, want generic authentication failure", err)
			}
			if tokenCalls.Load() != 0 {
				t.Errorf("token calls = %d, want 0", tokenCalls.Load())
			}
			page := receiveString(t, browserPage)
			assertNoMarkers(t, err.Error()+output.String()+page,
				"provider-secret-marker", "token-secret-marker", "wrong-state-marker", "code-marker", "verifier-marker", "old-token-marker")
			if !strings.Contains(page, "Authentication failed") {
				t.Errorf("browser page = %q, want generic authentication failure", page)
			}
			assertConfigSnapshot(t, path, before)
		})
	}
}

func TestLoginWrongStateDoesNotClaimCallbackOrExchangeToken(t *testing.T) {
	resetLoginGlobals(t)
	var tokenCalls atomic.Int32
	server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
		tokenCalls.Add(1)
		http.Error(w, "unexpected token exchange", http.StatusInternalServerError)
	})
	defer server.Close()
	path, before := writeLoginConfig(t, &Config{Server: server.URL, Token: "old-token-marker"})
	globalConfigPath = path
	wrongResponse := make(chan callbackHTTPResponse, 1)
	dependencies := defaultLoginDependencies()
	dependencies.callbackTimeout = 50 * time.Millisecond
	dependencies.openBrowser = func(ctx context.Context, _ string) error {
		callbackCtx := context.WithoutCancel(ctx)
		go func() {
			wrongResponse <- getCallbackResponse(callbackCtx, "/callback?code=wrong-code-marker&state=wrong-state-marker")
		}()
		return nil
	}

	err := executeLogin(context.Background(), &strings.Builder{}, dependencies)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("executeLogin() error = %v, want timeout after ignored wrong state", err)
	}
	response := receiveCallbackResponse(t, wrongResponse)
	if response.status != http.StatusBadRequest {
		t.Errorf("wrong-state status = %d, want 400", response.status)
	}
	if !strings.Contains(response.body, "Authentication failed") {
		t.Errorf("wrong-state body = %q, want generic failure", response.body)
	}
	assertNoMarkers(t, response.body+err.Error(), "wrong-code-marker", "wrong-state-marker", "verifier-marker", "old-token-marker")
	if tokenCalls.Load() != 0 {
		t.Errorf("token calls = %d, want 0", tokenCalls.Load())
	}
	assertConfigSnapshot(t, path, before)
}

func TestLoginWrongStateThenValidCallbackSucceeds(t *testing.T) {
	resetLoginGlobals(t)
	exp := time.Now().Add(time.Hour).Truncate(time.Second)
	token := testJWT(t, map[string]any{"sub": "subject-marker", "exp": exp.Unix()})
	var tokenCalls atomic.Int32
	server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
		tokenCalls.Add(1)
		writeTestJSON(t, w, map[string]any{"idToken": token})
	})
	defer server.Close()
	path, _ := writeLoginConfig(t, &Config{Server: server.URL, Token: "old-token-marker"})
	globalConfigPath = path
	wrongResponse := make(chan callbackHTTPResponse, 1)
	validPage := make(chan string, 1)
	dependencies := defaultLoginDependencies()
	dependencies.callbackTimeout = time.Second
	dependencies.openBrowser = func(ctx context.Context, _ string) error {
		callbackCtx := context.WithoutCancel(ctx)
		go func() {
			wrongResponse <- getCallbackResponse(callbackCtx, "/callback?code=wrong-code-marker&state=wrong-state-marker")
			requestCallback(callbackCtx, "/callback?code=valid-code-marker&state=expected-state", validPage)
		}()
		return nil
	}

	if err := executeLogin(context.Background(), &strings.Builder{}, dependencies); err != nil {
		t.Fatalf("executeLogin() error = %v", err)
	}
	if response := receiveCallbackResponse(t, wrongResponse); response.status != http.StatusBadRequest {
		t.Errorf("wrong-state status = %d, want 400", response.status)
	}
	if page := receiveString(t, validPage); !strings.Contains(page, "Login successful") {
		t.Errorf("valid callback page = %q, want success", page)
	}
	if tokenCalls.Load() != 1 {
		t.Errorf("token calls = %d, want 1", tokenCalls.Load())
	}
}

func TestLoginWrongMethodAndPathRemainPending(t *testing.T) {
	resetLoginGlobals(t)
	exp := time.Now().Add(time.Hour).Truncate(time.Second)
	token := testJWT(t, map[string]any{"sub": "subject-marker", "exp": exp.Unix()})
	var tokenCalls atomic.Int32
	server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
		tokenCalls.Add(1)
		writeTestJSON(t, w, map[string]any{"idToken": token})
	})
	defer server.Close()
	path, _ := writeLoginConfig(t, &Config{Server: server.URL, Token: "old-token-marker"})
	globalConfigPath = path

	statuses := make(chan int, 2)
	validPage := make(chan string, 1)
	dependencies := defaultLoginDependencies()
	dependencies.callbackTimeout = time.Second
	dependencies.openBrowser = func(ctx context.Context, _ string) error {
		callbackCtx := context.WithoutCancel(ctx)
		go func() {
			statuses <- callbackStatus(callbackCtx, http.MethodGet, "/not-callback")
			statuses <- callbackStatus(callbackCtx, http.MethodPost, "/callback?code=code-marker&state=expected-state")
			requestCallback(callbackCtx, "/callback?code=code-marker&state=expected-state", validPage)
		}()
		return nil
	}
	if err := executeLogin(context.Background(), &strings.Builder{}, dependencies); err != nil {
		t.Fatalf("executeLogin() error = %v", err)
	}
	if got := <-statuses; got != http.StatusNotFound {
		t.Errorf("wrong path status = %d, want 404", got)
	}
	if got := <-statuses; got != http.StatusMethodNotAllowed {
		t.Errorf("wrong method status = %d, want 405", got)
	}
	if tokenCalls.Load() != 1 {
		t.Errorf("token calls = %d, want 1", tokenCalls.Load())
	}
	if page := receiveString(t, validPage); !strings.Contains(page, "Login successful") {
		t.Errorf("valid callback page = %q, want success", page)
	}
}

func TestLoginTokenFailureIsGenericAndLeavesConfigUnchanged(t *testing.T) {
	resetLoginGlobals(t)
	server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "token-endpoint-secret-marker", http.StatusUnauthorized)
	})
	defer server.Close()
	path, before := writeLoginConfig(t, &Config{Server: server.URL, Namespace: "prod", Token: "old-token-marker"})
	globalConfigPath = path
	browserPage := make(chan string, 1)
	dependencies := defaultLoginDependencies()
	dependencies.callbackTimeout = time.Second
	dependencies.openBrowser = callbackBrowser("/callback?code=authorization-code-marker&state=expected-state", browserPage)
	var output strings.Builder

	err := executeLogin(context.Background(), &output, dependencies)
	if !errors.Is(err, errAuthenticationFailed) {
		t.Fatalf("executeLogin() error = %v, want generic authentication failure", err)
	}
	page := receiveString(t, browserPage)
	if !strings.Contains(page, "Authentication failed") {
		t.Errorf("browser page = %q, want generic authentication failure", page)
	}
	assertNoMarkers(t, err.Error()+output.String()+page,
		"token-endpoint-secret-marker", "authorization-code-marker", "verifier-marker", "old-token-marker")
	assertConfigSnapshot(t, path, before)
}

func TestLoginTimeoutAndCancellationReleaseListenerAndLeaveConfigUnchanged(t *testing.T) {
	tests := []struct {
		name string
		run  func(loginDependencies, *strings.Builder) error
	}{
		{
			name: "timeout",
			run: func(dependencies loginDependencies, output *strings.Builder) error {
				dependencies.callbackTimeout = 20 * time.Millisecond
				dependencies.openBrowser = func(context.Context, string) error { return nil }
				return executeLogin(context.Background(), output, dependencies)
			},
		},
		{
			name: "cancellation",
			run: func(dependencies loginDependencies, output *strings.Builder) error {
				ctx, cancel := context.WithCancel(context.Background())
				dependencies.callbackTimeout = time.Second
				dependencies.openBrowser = func(context.Context, string) error {
					cancel()
					return nil
				}
				return executeLogin(ctx, output, dependencies)
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetLoginGlobals(t)
			server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
				http.Error(w, "unexpected token exchange", http.StatusInternalServerError)
			})
			defer server.Close()
			path, before := writeLoginConfig(t, &Config{Server: server.URL, Token: "old-token-marker"})
			globalConfigPath = path

			err := tt.run(defaultLoginDependencies(), &strings.Builder{})
			if err == nil {
				t.Fatal("executeLogin() error = nil, want terminal error")
			}
			assertConfigSnapshot(t, path, before)
			listener, listenErr := (&net.ListenConfig{}).Listen(context.Background(), "tcp", loginCallbackAddress)
			if listenErr != nil {
				t.Fatalf("callback listener was not released: %v", listenErr)
			}
			_ = listener.Close()
		})
	}
}

func TestLoginCallbackServeFailureReturnsPromptlyWithoutDetails(t *testing.T) {
	resetLoginGlobals(t)
	server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unexpected token exchange", http.StatusInternalServerError)
	})
	defer server.Close()
	path, before := writeLoginConfig(t, &Config{Server: server.URL, Token: "old-token-marker"})
	globalConfigPath = path
	listener := &failingLoginListener{
		failed: make(chan struct{}, 1),
		err:    errors.New("accept failed: raw-listener-secret-marker"),
	}
	dependencies := defaultLoginDependencies()
	dependencies.callbackTimeout = time.Hour
	dependencies.listen = func(string, string) (net.Listener, error) { return listener, nil }
	dependencies.openBrowser = func(context.Context, string) error { return nil }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- executeLogin(ctx, &strings.Builder{}, dependencies) }()

	select {
	case <-listener.failed:
	case <-time.After(time.Second):
		t.Fatal("callback server did not attempt to accept a connection")
	}
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "login callback server stopped unexpectedly") {
			t.Fatalf("executeLogin() error = %v, want sanitized callback server failure", err)
		}
		assertNoMarkers(t, err.Error(), "raw-listener-secret-marker", "accept failed")
	case <-time.After(time.Second):
		cancel()
		err := <-done
		t.Fatalf("executeLogin() waited after callback server failure; eventual error = %v", err)
	}
	assertConfigSnapshot(t, path, before)
}

func TestLoginCommandUsesInjectedContextCancellation(t *testing.T) {
	resetLoginGlobals(t)
	server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unexpected token exchange", http.StatusInternalServerError)
	})
	defer server.Close()
	path, before := writeLoginConfig(t, &Config{Server: server.URL, Token: "old-token-marker"})
	globalConfigPath = path
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	dependencies := defaultLoginDependencies()
	dependencies.callbackTimeout = time.Second
	cmd := newLoginCmdWithDependencies(ctx, dependencies)
	cmd.SetOut(&strings.Builder{})
	cmd.SetErr(&strings.Builder{})

	err := cmd.Execute()
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("command error = %v, want injected context cancellation", err)
	}
	assertConfigSnapshot(t, path, before)
	listener, listenErr := (&net.ListenConfig{}).Listen(context.Background(), "tcp", loginCallbackAddress)
	if listenErr != nil {
		t.Fatalf("callback listener was not released: %v", listenErr)
	}
	_ = listener.Close()
}

func TestLoginBrowserOpenFailurePrintsValidatedURLAndContinues(t *testing.T) {
	resetLoginGlobals(t)
	exp := time.Now().Add(time.Hour).Truncate(time.Second)
	token := testJWT(t, map[string]any{"sub": "subject-marker", "exp": exp.Unix()})
	server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
		writeTestJSON(t, w, map[string]any{"idToken": token})
	})
	defer server.Close()
	path, _ := writeLoginConfig(t, &Config{Server: server.URL})
	globalConfigPath = path
	var output strings.Builder
	dependencies := defaultLoginDependencies()
	dependencies.callbackTimeout = time.Second
	dependencies.openBrowser = func(ctx context.Context, providerURL string) error {
		go requestCallback(context.WithoutCancel(ctx), "/callback?code=code-marker&state=expected-state", make(chan string, 1))
		return errors.New("browser-command-secret-marker")
	}

	if err := executeLogin(context.Background(), &output, dependencies); err != nil {
		t.Fatalf("executeLogin() error = %v", err)
	}
	if !strings.Contains(output.String(), server.URL+"/provider") {
		t.Errorf("output = %q, want provider URL fallback", &output)
	}
	assertNoMarkers(t, output.String(), "browser-command-secret-marker", "verifier-marker", "code-marker")
}

func TestLoginBrowserOpenFailureIsReportedWhenCallbackArrivesFirst(t *testing.T) {
	resetLoginGlobals(t)
	exp := time.Now().Add(time.Hour).Truncate(time.Second)
	token := testJWT(t, map[string]any{"sub": "subject-marker", "exp": exp.Unix()})
	tokenStarted := make(chan struct{})
	server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
		close(tokenStarted)
		writeTestJSON(t, w, map[string]any{"idToken": token})
	})
	defer server.Close()
	path, _ := writeLoginConfig(t, &Config{Server: server.URL})
	globalConfigPath = path
	var output strings.Builder
	dependencies := defaultLoginDependencies()
	dependencies.callbackTimeout = time.Second
	dependencies.openBrowser = func(ctx context.Context, _ string) error {
		go requestCallback(context.WithoutCancel(ctx), "/callback?code=code-marker&state=expected-state", make(chan string, 1))
		<-tokenStarted
		return errors.New("browser-command-secret-marker")
	}

	if err := executeLogin(context.Background(), &output, dependencies); err != nil {
		t.Fatalf("executeLogin() error = %v", err)
	}
	if !strings.Contains(output.String(), server.URL+"/provider") {
		t.Errorf("output = %q, want provider URL fallback even when callback arrived first", &output)
	}
	assertNoMarkers(t, output.String(), "browser-command-secret-marker", "verifier-marker", "code-marker")
}

func TestLoginDuplicateValidCallbacksExchangeExactlyOnce(t *testing.T) {
	resetLoginGlobals(t)
	exp := time.Now().Add(time.Hour).Truncate(time.Second)
	token := testJWT(t, map[string]any{"sub": "subject-marker", "exp": exp.Unix()})
	var tokenCalls atomic.Int32
	tokenStarted := make(chan struct{})
	allowToken := make(chan struct{})
	server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
		if tokenCalls.Add(1) == 1 {
			close(tokenStarted)
		}
		<-allowToken
		writeTestJSON(t, w, map[string]any{"idToken": token})
	})
	defer server.Close()
	path, _ := writeLoginConfig(t, &Config{Server: server.URL})
	globalConfigPath = path
	firstPage := make(chan string, 1)
	duplicateResponse := make(chan callbackHTTPResponse, 1)
	dependencies := defaultLoginDependencies()
	dependencies.callbackTimeout = time.Second
	dependencies.openBrowser = func(ctx context.Context, _ string) error {
		callbackCtx := context.WithoutCancel(ctx)
		go requestCallback(callbackCtx, "/callback?code=first-code-marker&state=expected-state", firstPage)
		<-tokenStarted
		go func() {
			duplicateResponse <- getCallbackResponse(callbackCtx, "/callback?code=second-code-marker&state=expected-state")
		}()
		return nil
	}
	done := make(chan error, 1)
	go func() { done <- executeLogin(context.Background(), &strings.Builder{}, dependencies) }()
	select {
	case <-tokenStarted:
	case <-time.After(time.Second):
		t.Fatal("token exchange did not start")
	}
	duplicate := receiveCallbackResponse(t, duplicateResponse)
	if duplicate.status != http.StatusConflict {
		t.Errorf("duplicate status = %d, want 409", duplicate.status)
	}
	if !strings.Contains(duplicate.body, "Authentication failed") {
		t.Errorf("duplicate body = %q, want generic rejection", duplicate.body)
	}
	assertNoMarkers(t, duplicate.body, "second-code-marker", "expected-state")
	close(allowToken)
	if err := <-done; err != nil {
		t.Fatalf("executeLogin() error = %v", err)
	}
	if tokenCalls.Load() != 1 {
		t.Errorf("token calls = %d, want exactly 1", tokenCalls.Load())
	}
	if page := receiveString(t, firstPage); !strings.Contains(page, "Login successful") {
		t.Errorf("first callback page = %q, want success", page)
	}
}

func TestLoginRejectsInvalidOrExpiredIDTokenWithoutChangingConfig(t *testing.T) {
	tests := []struct {
		name  string
		token string
	}{
		{name: "malformed", token: "malformed-token-secret-marker"},
		{name: "missing exp", token: testJWT(t, map[string]any{"sub": "subject-marker"})},
		{name: "string exp", token: testJWT(t, map[string]any{"sub": "subject-marker", "exp": "4102444800"})},
		{name: "expired", token: testJWT(t, map[string]any{"sub": "subject-marker", "exp": time.Now().Add(-time.Minute).Unix()})},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetLoginGlobals(t)
			server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
				writeTestJSON(t, w, map[string]any{"idToken": tt.token, "expiresIn": 86400})
			})
			defer server.Close()
			path, before := writeLoginConfig(t, &Config{Server: server.URL, Token: "old-token-marker"})
			globalConfigPath = path
			browserPage := make(chan string, 1)
			dependencies := defaultLoginDependencies()
			dependencies.callbackTimeout = time.Second
			dependencies.openBrowser = callbackBrowser("/callback?code=code-marker&state=expected-state", browserPage)

			err := executeLogin(context.Background(), &strings.Builder{}, dependencies)
			if !errors.Is(err, errAuthenticationFailed) {
				t.Fatalf("executeLogin() error = %v, want generic failure", err)
			}
			page := receiveString(t, browserPage)
			assertNoMarkers(t, err.Error()+page, tt.token, "old-token-marker", "verifier-marker", "code-marker")
			assertConfigSnapshot(t, path, before)
		})
	}
}

func TestLoginIdentityFallback(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	tests := []struct {
		name   string
		claims map[string]any
		want   string
	}{
		{
			name:   "email",
			claims: map[string]any{"email": "email@example.com", "preferred_username": "preferred", "sub": "subject", "exp": now.Add(time.Hour).Unix()},
			want:   "email@example.com",
		},
		{
			name:   "preferred username",
			claims: map[string]any{"preferred_username": "preferred", "sub": "subject", "exp": now.Add(time.Hour).Unix()},
			want:   "preferred",
		},
		{
			name:   "subject",
			claims: map[string]any{"sub": "subject", "exp": now.Add(time.Hour).Unix()},
			want:   "subject",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, identity, err := parseLoginIDToken(testJWT(t, tt.claims), now)
			if err != nil {
				t.Fatalf("parseLoginIDToken() error = %v", err)
			}
			if identity != tt.want {
				t.Errorf("identity = %q, want %q", identity, tt.want)
			}
		})
	}
}

func TestLoginIdentityIsTerminalSafeAndBounded(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	identity := "alice@example.com\nNEWLINE_MARKER\x1b]0;OSC_MARKER\x07\u0085END" + strings.Repeat("x", 600)
	token := testJWT(t, map[string]any{"email": identity, "sub": "subject", "exp": now.Add(time.Hour).Unix()})
	_, display, err := parseLoginIDToken(token, now)
	if err != nil {
		t.Fatalf("parseLoginIDToken() error = %v", err)
	}
	for _, control := range []string{"\n", "\r", "\x1b", "\x07", "\u0085"} {
		if strings.Contains(display, control) {
			t.Errorf("display identity contains raw terminal control %q: %q", control, display)
		}
	}
	for _, escaped := range []string{`\u000A`, `\u001B`, `\u0007`, `\u0085`} {
		if !strings.Contains(display, escaped) {
			t.Errorf("display identity = %q, want visible escape %q", display, escaped)
		}
	}
	if !strings.Contains(display, "NEWLINE_MARKER") || !strings.Contains(display, "OSC_MARKER") {
		t.Errorf("display identity lost safe marker text: %q", display)
	}
	if len(display) > maxLoginIdentityDisplayBytes {
		t.Errorf("display identity length = %d, want <= %d", len(display), maxLoginIdentityDisplayBytes)
	}
	parts := strings.Split(token, ".")
	payload, decodeErr := base64.RawURLEncoding.DecodeString(parts[1])
	if decodeErr != nil || !strings.Contains(string(payload), "NEWLINE_MARKER") {
		t.Errorf("raw token payload was altered: %q, error=%v", payload, decodeErr)
	}
}

func TestLoginTimeoutAndCancelBoundedlyReapStuckBrowserOpener(t *testing.T) {
	tests := []struct {
		name string
		run  func(loginDependencies) error
	}{
		{
			name: "callback timeout",
			run: func(dependencies loginDependencies) error {
				dependencies.callbackTimeout = 30 * time.Millisecond
				return executeLogin(context.Background(), &strings.Builder{}, dependencies)
			},
		},
		{
			name: "cancellation",
			run: func(dependencies loginDependencies) error {
				ctx, cancel := context.WithCancel(context.Background())
				time.AfterFunc(20*time.Millisecond, cancel)
				return executeLogin(ctx, &strings.Builder{}, dependencies)
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resetLoginGlobals(t)
			server := newLoginTestServer(t, "expected-state", "verifier-marker", func(w http.ResponseWriter, _ *http.Request) {
				http.Error(w, "unexpected token exchange", http.StatusInternalServerError)
			})
			defer server.Close()
			path, before := writeLoginConfig(t, &Config{Server: server.URL, Token: "old-token-marker"})
			globalConfigPath = path
			openerDone := make(chan struct{})
			dependencies := defaultLoginDependencies()
			dependencies.browserLaunchTimeout = time.Second
			dependencies.openBrowser = func(ctx context.Context, _ string) error {
				<-ctx.Done()
				close(openerDone)
				return ctx.Err()
			}

			if err := tt.run(dependencies); err == nil {
				t.Fatal("executeLogin() error = nil, want terminal error")
			}
			select {
			case <-openerDone:
			default:
				t.Fatal("login returned before reaping the canceled browser opener")
			}
			assertConfigSnapshot(t, path, before)
		})
	}
}

func TestLoginCallbackServerHasExplicitHTTPBounds(t *testing.T) {
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	callback := newLoginCallbackServer(listener, "expected-state")
	defer callback.shutdown(context.Background())
	if callback.server.MaxHeaderBytes != loginCallbackMaxHeaderBytes {
		t.Errorf("MaxHeaderBytes = %d, want %d", callback.server.MaxHeaderBytes, loginCallbackMaxHeaderBytes)
	}
	if callback.server.IdleTimeout != loginCallbackIdleTimeout {
		t.Errorf("IdleTimeout = %s, want %s", callback.server.IdleTimeout, loginCallbackIdleTimeout)
	}
	if callback.server.WriteTimeout != loginCallbackWriteTimeout {
		t.Errorf("WriteTimeout = %s, want %s", callback.server.WriteTimeout, loginCallbackWriteTimeout)
	}
}

func TestLoginCallbackShutdownWaitsForServeExit(t *testing.T) {
	previousMaxProcs := runtime.GOMAXPROCS(1)
	t.Cleanup(func() { runtime.GOMAXPROCS(previousMaxProcs) })

	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	address := listener.Addr().String()
	t.Cleanup(func() { _ = listener.Close() })
	closed := make(chan struct{}, 1)
	callback := newLoginCallbackServer(&closeTrackingListener{Listener: listener, closed: closed}, "expected-state")
	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()

	callback.shutdown(canceledCtx)

	select {
	case <-callback.serveDone:
	default:
		t.Fatal("callback shutdown returned before the Serve goroutine exited")
	}
	select {
	case err := <-callback.failures:
		t.Fatalf("intentional callback shutdown reported a Serve failure: %v", err)
	default:
	}
	select {
	case <-closed:
	default:
		t.Fatal("callback shutdown returned before the Serve goroutine closed its listener")
	}
	rebound, listenErr := (&net.ListenConfig{}).Listen(context.Background(), "tcp", address)
	if listenErr != nil {
		t.Fatalf("callback listener was not released: %v", listenErr)
	}
	_ = rebound.Close()
}

func TestLoginCallbackAcceptedBeforeServeFailureWins(t *testing.T) {
	fail := make(chan struct{})
	listener := &gatedFailingLoginListener{
		fail: fail,
		stop: make(chan struct{}, 1),
		err:  errors.New("accept failed: raw-listener-secret-marker"),
	}
	callback := newLoginCallbackServer(listener, "expected-state")
	defer callback.shutdown(context.Background())
	response := httptest.NewRecorder()
	responseDone := make(chan struct{})
	go func() {
		callback.handle(response, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
			"/callback?code=code-marker&state=expected-state", http.NoBody))
		close(responseDone)
	}()

	select {
	case event := <-callback.events:
		if event.code != "code-marker" {
			t.Fatalf("callback code = %q, want code-marker", event.code)
		}
	case <-time.After(time.Second):
		t.Fatal("callback was not accepted")
	}
	close(fail)
	select {
	case <-callback.serveDone:
	case <-time.After(time.Second):
		t.Fatal("callback Serve did not exit")
	}
	select {
	case err := <-callback.failures:
		t.Fatalf("accepted callback lost to Serve failure: %v", err)
	default:
	}
	callback.complete(loginCallbackResult{success: true})
	select {
	case <-responseDone:
	case <-time.After(time.Second):
		t.Fatal("accepted callback did not receive its result")
	}
	if response.Code != http.StatusOK {
		t.Fatalf("callback status = %d, want 200", response.Code)
	}
}

func TestLoginHTTPClientIsBoundedAndDoesNotFollowRedirects(t *testing.T) {
	client := newLoginHTTPClient()
	if client.Timeout != 15*time.Second {
		t.Fatalf("client timeout = %s, want 15s", client.Timeout)
	}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.com", http.NoBody)
	if err := client.CheckRedirect(request, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatalf("CheckRedirect() error = %v, want http.ErrUseLastResponse", err)
	}

	for _, status := range []int{http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		t.Run(fmt.Sprintf("token redirect %d", status), func(t *testing.T) {
			var forwarded atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				forwarded.Add(1)
			}))
			defer target.Close()
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Location", target.URL)
				w.WriteHeader(status)
			}))
			defer source.Close()
			_, err := exchangeLoginCode(context.Background(), client, source.URL, tokenRequest{
				Code: "code-marker", CodeVerifier: "verifier-marker", RedirectURI: loginCallbackURI,
			})
			if !errors.Is(err, errAuthenticationFailed) {
				t.Fatalf("exchangeLoginCode() error = %v, want generic failure", err)
			}
			if forwarded.Load() != 0 {
				t.Errorf("cross-origin requests = %d, want 0", forwarded.Load())
			}
		})
	}
}

func TestLoginHTTPResponsesAreClosedOnEveryPath(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   []byte
		cancel bool
	}{
		{name: "success", status: http.StatusOK, body: []byte(`{"idToken":"a.b.c"}`)},
		{name: "non-200", status: http.StatusUnauthorized, body: []byte("server-secret-marker")},
		{name: "redirect", status: http.StatusTemporaryRedirect, body: []byte("redirect-marker")},
		{name: "oversize", status: http.StatusOK, body: bytes.Repeat([]byte("x"), maxLoginResponseSize+1)},
		{name: "malformed", status: http.StatusOK, body: []byte("{")},
		{name: "cancelled read", status: http.StatusOK, cancel: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := &trackingBody{data: tt.body}
			transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if tt.cancel {
					body.ctx = req.Context()
				}
				return &http.Response{StatusCode: tt.status, Body: body, Header: make(http.Header)}, nil
			})
			client := &http.Client{Timeout: loginRequestTimeout, Transport: transport,
				CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			ctx := context.Background()
			if tt.cancel {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			_, _ = exchangeLoginCode(ctx, client, "http://localhost:3000", tokenRequest{
				Code: "code-marker", CodeVerifier: "verifier-marker", RedirectURI: loginCallbackURI,
			})
			if !body.closed.Load() {
				t.Fatal("response body was not closed")
			}
		})
	}
}

func TestLoginURLValidation(t *testing.T) {
	valid := []string{
		"https://paprika.example.com",
		"http://localhost:3000",
		"http://127.0.0.1:3000",
		"http://[::1]:3000",
	}
	for _, raw := range valid {
		if _, err := validateServerURL(raw); err != nil {
			t.Errorf("validateServerURL(%q) error = %v", raw, err)
		}
		if err := validateBrowserURL(raw + "/authorize"); err != nil {
			t.Errorf("validateBrowserURL(%q) error = %v", raw, err)
		}
	}
	invalid := []string{
		"", "relative/path", "http://paprika.example.com", "ftp://paprika.example.com",
		"javascript:alert(1)", "https://user:password@paprika.example.com", "file:///tmp/secret",
	}
	for _, raw := range invalid {
		if _, err := validateServerURL(raw); err == nil {
			t.Errorf("validateServerURL(%q) error = nil", raw)
		}
		if err := validateBrowserURL(raw); err == nil {
			t.Errorf("validateBrowserURL(%q) error = nil", raw)
		}
	}
}

func TestLoginBrowserCommandReturnsNonzeroExit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake browser executable is POSIX-only")
	}
	dir := t.TempDir()
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 1\n"), 0o700); err != nil { //nolint:gosec // executable test fixture.
		t.Fatalf("write fake browser: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := openBrowserURL(context.Background(), "https://provider.example.com/authorize"); err == nil {
		t.Fatal("openBrowserURL() error = nil, want nonzero command exit error")
	}
}

func TestLoginIDTokenExpPreservesIntegerPrecision(t *testing.T) {
	const exp int64 = 9_007_199_254_740_993
	expiresAt, _, err := parseLoginIDToken(testJWT(t, map[string]any{"sub": "subject", "exp": exp}), time.Unix(0, 0))
	if err != nil {
		t.Fatalf("parseLoginIDToken() error = %v", err)
	}
	if expiresAt.Unix() != exp {
		t.Errorf("expiry = %d, want exact integer %d", expiresAt.Unix(), exp)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

type trackingBody struct {
	data   []byte
	offset int
	ctx    context.Context
	closed atomic.Bool
}

type callbackHTTPResponse struct {
	status int
	body   string
}

type closeTrackingListener struct {
	net.Listener
	closed chan<- struct{}
}

func (l *closeTrackingListener) Close() error {
	select {
	case l.closed <- struct{}{}:
	default:
	}
	return l.Listener.Close()
}

type failingLoginListener struct {
	failed chan struct{}
	err    error
}

func (l *failingLoginListener) Accept() (net.Conn, error) {
	select {
	case l.failed <- struct{}{}:
	default:
	}
	return nil, l.err
}

func (*failingLoginListener) Close() error   { return nil }
func (*failingLoginListener) Addr() net.Addr { return &net.TCPAddr{} }

type gatedFailingLoginListener struct {
	fail <-chan struct{}
	stop chan struct{}
	err  error
}

func (l *gatedFailingLoginListener) Accept() (net.Conn, error) {
	select {
	case <-l.fail:
		return nil, l.err
	case <-l.stop:
		return nil, net.ErrClosed
	}
}

func (l *gatedFailingLoginListener) Close() error {
	select {
	case l.stop <- struct{}{}:
	default:
	}
	return nil
}

func (*gatedFailingLoginListener) Addr() net.Addr { return &net.TCPAddr{} }

func getCallbackResponse(ctx context.Context, path string) callbackHTTPResponse {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+loginCallbackAddress+path, http.NoBody)
	if err != nil {
		return callbackHTTPResponse{body: "callback request failed"}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return callbackHTTPResponse{body: "callback request failed"}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return callbackHTTPResponse{status: resp.StatusCode, body: "callback response failed"}
	}
	return callbackHTTPResponse{status: resp.StatusCode, body: string(body)}
}

func receiveCallbackResponse(t *testing.T, responses <-chan callbackHTTPResponse) callbackHTTPResponse {
	t.Helper()
	select {
	case response := <-responses:
		return response
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for callback HTTP response")
		return callbackHTTPResponse{}
	}
}

func (b *trackingBody) Read(p []byte) (int, error) {
	if b.ctx != nil {
		<-b.ctx.Done()
		return 0, b.ctx.Err()
	}
	if b.offset >= len(b.data) {
		return 0, io.EOF
	}
	n := copy(p, b.data[b.offset:])
	b.offset += n
	return n, nil
}

func (b *trackingBody) Close() error {
	b.closed.Store(true)
	return nil
}

func newLoginTestServer(t *testing.T, state, verifier string, tokenHandler http.HandlerFunc) *httptest.Server {
	t.Helper()
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/login":
			writeTestJSON(t, w, map[string]any{
				"url":          server.URL + "/provider",
				"codeVerifier": verifier,
				"state":        state,
			})
		case "/auth/token":
			tokenHandler(w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	return server
}

func callbackBrowser(path string, page chan<- string) func(context.Context, string) error {
	return func(ctx context.Context, _ string) error {
		go requestCallback(context.WithoutCancel(ctx), path, page)
		return nil
	}
}

func requestCallback(ctx context.Context, path string, result chan<- string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+loginCallbackAddress+path, http.NoBody)
	if err != nil {
		result <- "callback request failed: " + err.Error()
		return
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		result <- "callback request failed: " + err.Error()
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		result <- "callback response failed: " + err.Error()
		return
	}
	result <- string(body)
}

func callbackStatus(ctx context.Context, method, path string) int {
	req, err := http.NewRequestWithContext(ctx, method, "http://"+loginCallbackAddress+path, http.NoBody)
	if err != nil {
		return 0
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func receiveString(t *testing.T, values <-chan string) string {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for callback response")
		return ""
	}
}

func writeLoginConfig(t *testing.T, config *Config) (string, []byte) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := config.Save(path); err != nil {
		t.Fatalf("save test config: %v", err)
	}
	//nolint:gosec // path is rooted in t.TempDir and controlled by this test.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("snapshot test config: %v", err)
	}
	return path, data
}

func assertConfigSnapshot(t *testing.T, path string, want []byte) {
	t.Helper()
	//nolint:gosec // path is rooted in t.TempDir and controlled by this test.
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config after failure: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("config changed after failure:\n got: %q\nwant: %q", got, want)
	}
}

func assertNoMarkers(t *testing.T, got string, markers ...string) {
	t.Helper()
	for _, marker := range markers {
		if marker != "" && strings.Contains(got, marker) {
			t.Errorf("output exposed sensitive marker %q: %q", marker, got)
		}
	}
}

func installFakeBrowser(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake browser executable is POSIX-only")
	}
	dir := t.TempDir()
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	path := filepath.Join(dir, name)
	script := `#!/bin/sh
url=""
for arg do url="$arg"; done
/usr/bin/curl --silent --show-error --location "$url" > "$PAPRIKA_TEST_BROWSER_OUTPUT"
`
	//nolint:gosec // executable browser shim is rooted in t.TempDir and contains no secrets.
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake browser: %v", err)
	}
	output := filepath.Join(dir, "browser.html")
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("PAPRIKA_TEST_BROWSER_OUTPUT", output)
	return output
}

func testJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal JWT claims: %v", err)
	}
	encode := base64.RawURLEncoding.EncodeToString
	return encode([]byte(`{"alg":"none"}`)) + "." + encode(payload) + ".signature"
}

func writeTestJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Errorf("encode response: %v", err)
	}
}

func waitForFile(path string, timeout time.Duration) ([]byte, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		//nolint:gosec // path is rooted in t.TempDir and controlled by this test.
		data, err := os.ReadFile(path)
		if err == nil && len(data) > 0 {
			return data, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil, errors.New("timed out waiting for browser output")
}

func resetLoginGlobals(t *testing.T) {
	t.Helper()
	oldConfigPath := globalConfigPath
	oldServer := globalServer
	oldNamespace := globalNamespace
	oldUsername := globalUsername
	oldPassword := globalPassword
	oldToken := globalToken
	oldOutput := globalOutput
	t.Cleanup(func() {
		globalConfigPath = oldConfigPath
		globalServer = oldServer
		globalNamespace = oldNamespace
		globalUsername = oldUsername
		globalPassword = oldPassword
		globalToken = oldToken
		globalOutput = oldOutput
	})
	globalConfigPath = ""
	globalServer = ""
	globalNamespace = ""
	globalUsername = ""
	globalPassword = ""
	globalToken = ""
	globalOutput = ""
}
