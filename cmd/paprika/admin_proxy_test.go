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
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/benebsworth/paprika/internal/api/admin"
)

func TestAdminProxyInjectsOnlyMemoryTokenAndSanitizesForwarding(t *testing.T) {
	t.Parallel()
	memoryToken := strings.Repeat("m", 43)
	callerToken := strings.Repeat("c", 43)
	seen := make(chan *http.Request, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		seen <- request.Clone(request.Context())
		_, _ = io.WriteString(w, "proxied")
	}))
	defer upstream.Close()

	holder := newAdminTokenHolder(memoryToken)
	proxy, err := startAdminProxy(
		t.Context(),
		0,
		adminSessionTestPort(t, upstream.URL),
		holder,
	)
	if err != nil {
		t.Fatalf("startAdminProxy() error = %v", err)
	}
	t.Cleanup(func() { _ = proxy.Close(t.Context()) })
	if !strings.HasPrefix(proxy.URL(), "http://127.0.0.1:") {
		t.Fatalf("proxy URL = %q, want literal loopback", proxy.URL())
	}

	request, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		proxy.URL()+"/dashboard/",
		http.NoBody,
	)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	request.Header.Set(admin.AdminSessionHeader, callerToken)
	request.Header.Set("Forwarded", "for=203.0.113.8")
	request.Header.Set("X-Forwarded-For", "203.0.113.8")
	request.Header.Set("X-Forwarded-Host", "attacker.example")
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("X-Forwarded-Port", "8443")
	request.Header["x-FoRwArDeD-Arbitrary"] = []string{"spoofed"}
	request.Header.Set("X-Original-Host", "attacker.example")
	request.Header.Set("Connection", "X-Hop, "+admin.AdminSessionHeader)
	request.Header.Set("X-Hop", "secret")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("proxy request error = %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("proxy status = %d", response.StatusCode)
	}
	got := <-seen
	if got.Host != adminUpstreamHost {
		t.Errorf("upstream Host = %q, want %q", got.Host, adminUpstreamHost)
	}
	if got.Header.Get(admin.AdminSessionHeader) != memoryToken {
		t.Fatal("proxy did not replace caller session with in-memory token")
	}
	for _, header := range []string{"Forwarded", "X-Original-Host", "Connection", "X-Hop"} {
		if got.Header.Get(header) != "" {
			t.Errorf("upstream received spoofed/hop-by-hop %s=%q", header, got.Header.Get(header))
		}
	}
	for header := range got.Header {
		if strings.HasPrefix(strings.ToLower(header), "x-forwarded-") {
			t.Errorf("upstream received arbitrary forwarding header %s=%q", header, got.Header.Values(header))
		}
	}
}

func TestAdminProxyRejectsHostAndCrossOriginMutation(t *testing.T) {
	t.Parallel()
	seenOrigin := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		seenOrigin <- request.Header.Get("Origin")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	proxy, err := startAdminProxy(
		t.Context(),
		0,
		adminSessionTestPort(t, upstream.URL),
		newAdminTokenHolder(strings.Repeat("m", 43)),
	)
	if err != nil {
		t.Fatalf("startAdminProxy() error = %v", err)
	}
	t.Cleanup(func() { _ = proxy.Close(t.Context()) })

	crossOrigin, err := http.NewRequestWithContext(
		t.Context(), http.MethodPost, proxy.URL()+"/mutate", http.NoBody,
	)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	crossOrigin.Header.Set("Origin", "http://attacker.example")
	response, err := http.DefaultClient.Do(crossOrigin)
	if err != nil {
		t.Fatalf("cross-origin request error = %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin status = %d, want 403", response.StatusCode)
	}

	hostileHost, err := http.NewRequestWithContext(
		t.Context(), http.MethodGet, proxy.URL()+"/dashboard/", http.NoBody,
	)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	hostileHost.Host = "localhost:1234"
	response, err = http.DefaultClient.Do(hostileHost)
	if err != nil {
		t.Fatalf("hostile-host request error = %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("hostile Host status = %d, want 400", response.StatusCode)
	}

	accepted, err := http.NewRequestWithContext(
		t.Context(), http.MethodDelete, proxy.URL()+"/mutate", http.NoBody,
	)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	accepted.Header.Set("Origin", proxy.URL())
	accepted.Header.Set("Connection", "Origin")
	response, err = http.DefaultClient.Do(accepted)
	if err != nil {
		t.Fatalf("same-origin request error = %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("same-origin status = %d, want 204", response.StatusCode)
	}
	if origin := <-seenOrigin; origin != adminUpstreamOrigin {
		t.Fatalf("upstream Origin = %q, want %q", origin, adminUpstreamOrigin)
	}
}

func TestAdminProxyMethodGateFailsClosedBeforeSessionAcquisition(t *testing.T) {
	t.Parallel()
	holder := newAdminTokenHolder(strings.Repeat("m", 43))
	proxy, err := startAdminProxy(t.Context(), 0, 1, holder)
	if err != nil {
		t.Fatalf("startAdminProxy() error = %v", err)
	}
	t.Cleanup(func() { _ = proxy.Close(t.Context()) })
	if _, err := holder.Clear(t.Context()); err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	authority := strings.TrimPrefix(proxy.URL(), "http://")

	tests := []struct {
		method string
		origin string
		want   int
	}{
		{method: http.MethodGet, want: http.StatusServiceUnavailable},
		{method: http.MethodHead, want: http.StatusServiceUnavailable},
		{method: http.MethodPost, origin: proxy.URL(), want: http.StatusServiceUnavailable},
		{method: http.MethodPut, origin: proxy.URL(), want: http.StatusServiceUnavailable},
		{method: http.MethodPatch, origin: proxy.URL(), want: http.StatusServiceUnavailable},
		{method: http.MethodDelete, origin: proxy.URL(), want: http.StatusServiceUnavailable},
		{method: http.MethodPost, origin: "http://attacker.invalid", want: http.StatusForbidden},
		{method: http.MethodOptions, want: http.StatusMethodNotAllowed},
		{method: http.MethodTrace, want: http.StatusMethodNotAllowed},
		{method: http.MethodConnect, want: http.StatusMethodNotAllowed},
		{method: "PROPFIND", want: http.StatusMethodNotAllowed},
		{method: "PURGE", want: http.StatusMethodNotAllowed},
		{method: "", want: http.StatusMethodNotAllowed},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.method+" "+tt.origin, func(t *testing.T) {
			request := httptest.NewRequestWithContext(
				t.Context(),
				http.MethodGet,
				proxy.URL()+"/resource",
				http.NoBody,
			)
			request.Method = tt.method
			request.Host = authority
			if tt.origin != "" {
				request.Header.Set("Origin", tt.origin)
			}
			response := httptest.NewRecorder()
			proxy.server.Handler.ServeHTTP(response, request)
			if response.Code != tt.want {
				t.Fatalf("%q status = %d, want %d", tt.method, response.Code, tt.want)
			}
			holder.mu.Lock()
			active := holder.active
			holder.mu.Unlock()
			if active != 0 {
				t.Fatalf("%q acquired a session token despite rejection", tt.method)
			}
		})
	}
}

func TestAdminProxyHardensUpstreamCORSAndRedirectResponses(t *testing.T) {
	t.Parallel()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/redirect":
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Expose-Headers", admin.AdminSessionHeader)
			w.Header().Set("Set-Cookie", "paprika_ui=state; Path=/; HttpOnly; SameSite=Strict")
			w.Header().Set("Location", adminUpstreamOrigin+"/landing")
			w.WriteHeader(http.StatusFound)
		case "/external":
			w.Header().Set("Location", "https://attacker.invalid/collect")
			w.WriteHeader(http.StatusFound)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer upstream.Close()
	proxy, err := startAdminProxy(
		t.Context(),
		0,
		adminSessionTestPort(t, upstream.URL),
		newAdminTokenHolder(strings.Repeat("m", 43)),
	)
	if err != nil {
		t.Fatalf("startAdminProxy() error = %v", err)
	}
	t.Cleanup(func() { _ = proxy.Close(t.Context()) })
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	redirectRequest, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		proxy.URL()+"/redirect",
		http.NoBody,
	)
	if err != nil {
		t.Fatalf("build redirect request: %v", err)
	}
	response, err := client.Do(redirectRequest)
	if err != nil {
		t.Fatalf("GET redirect: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusFound {
		t.Fatalf("redirect status = %d, want 302", response.StatusCode)
	}
	for name := range response.Header {
		if strings.HasPrefix(strings.ToLower(name), "access-control-") {
			t.Fatalf("proxy retained upstream cross-origin response header %q", name)
		}
	}
	if location := response.Header.Get("Location"); location != proxy.URL()+"/landing" {
		t.Fatalf("Location = %q, want browser-facing loopback origin", location)
	}
	if cookie := response.Header.Get("Set-Cookie"); !strings.Contains(cookie, "paprika_ui=state") {
		t.Fatal("proxy unexpectedly removed the UI state cookie")
	}

	externalRequest, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		proxy.URL()+"/external",
		http.NoBody,
	)
	if err != nil {
		t.Fatalf("build external redirect request: %v", err)
	}
	response, err = client.Do(externalRequest)
	if err != nil {
		t.Fatalf("GET external redirect: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("external redirect status = %d, want 502", response.StatusCode)
	}
	if location := response.Header.Get("Location"); location != "" {
		t.Fatalf("external redirect leaked Location %q", location)
	}
}

func TestAdminRotationPausesRequestsAndAtomicallySwapsToken(t *testing.T) {
	t.Parallel()
	oldToken := strings.Repeat("o", 43)
	newToken := strings.Repeat("n", 43)
	holder := newAdminTokenHolder(oldToken)
	rotationEntered := make(chan struct{})
	releaseRotation := make(chan struct{})
	rotationDone := make(chan error, 1)
	go func() {
		rotationDone <- holder.Rotate(
			t.Context(),
			func(_ context.Context, current string) (string, error) {
				if current != oldToken {
					return "", errors.New("rotation did not receive current token")
				}
				close(rotationEntered)
				<-releaseRotation
				return newToken, nil
			},
			adminTestOrphanCleanup,
		)
	}()
	<-rotationEntered

	acquired := make(chan string, 1)
	go func() {
		token, release, err := holder.Acquire(t.Context())
		if err == nil {
			acquired <- token
			release()
		}
	}()
	select {
	case token := <-acquired:
		t.Fatalf("request acquired token %q while rotation was paused", token)
	case <-time.After(20 * time.Millisecond):
	}
	close(releaseRotation)
	if err := <-rotationDone; err != nil {
		t.Fatalf("Rotate() error = %v", err)
	}
	select {
	case token := <-acquired:
		if token != newToken {
			t.Fatalf("request token after rotation = %q, want replacement", token)
		}
	case <-time.After(time.Second):
		t.Fatal("paused request did not resume")
	}
	if _, err := holder.Clear(t.Context()); err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	if token, release, err := holder.Acquire(t.Context()); err == nil || token != "" {
		release()
		t.Fatalf("Acquire() after Clear = %q, %v", token, err)
	}
}

func TestAdminRotationFailureClearsAndClosesProxy(t *testing.T) {
	t.Parallel()
	holder := newAdminTokenHolder(strings.Repeat("o", 43))
	proxy, err := startAdminProxy(t.Context(), 0, 1, holder)
	if err != nil {
		t.Fatalf("startAdminProxy() error = %v", err)
	}
	refreshErr := holder.Rotate(
		t.Context(),
		func(context.Context, string) (string, error) {
			return "", errors.New("review denied")
		},
		adminTestOrphanCleanup,
	)
	if refreshErr == nil {
		t.Fatal("Rotate() error = nil")
	}
	if _, err := holder.Clear(t.Context()); err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	if err := proxy.Close(t.Context()); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	select {
	case <-proxy.Done():
	case <-time.After(time.Second):
		t.Fatal("proxy goroutine did not join after refresh failure")
	}
}

func TestAdminRotationDeadlineAfterSuccessfulRefreshOwnsReplacement(t *testing.T) {
	t.Parallel()
	oldToken := strings.Repeat("o", 43)
	newToken := strings.Repeat("n", 43)
	holder := newAdminTokenHolder(oldToken)
	ctx, cancel := context.WithCancel(t.Context())
	err := holder.Rotate(
		ctx,
		func(_ context.Context, current string) (string, error) {
			if current != oldToken {
				t.Fatalf("refresh current token was not the owned old token")
			}
			cancel()
			return newToken, nil
		},
		adminTestOrphanCleanup,
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Rotate() error = %v, want post-success context cancellation", err)
	}
	if got := holder.Current(); got != newToken {
		t.Fatalf("Current() = %q, want successfully minted replacement ownership", got)
	}
	shutdownToken, shutdownErr := holder.BeginShutdown(t.Context())
	if shutdownErr != nil {
		t.Fatalf("BeginShutdown() error = %v", shutdownErr)
	}
	if shutdownToken != newToken {
		t.Fatal("shutdown retained the old token instead of the replacement")
	}
	if _, release, acquireErr := holder.Acquire(t.Context()); acquireErr == nil {
		release()
		t.Fatal("BeginShutdown did not stop new request admissions")
	}
	revoked := make(chan string, 1)
	session := &testAdminDashboardSession{revoked: revoked}
	if revokeErr := bestEffortAdminRevoke(t.Context(), session, shutdownToken); revokeErr != nil {
		t.Fatalf("bestEffortAdminRevoke() error = %v", revokeErr)
	}
	if got := <-revoked; got != newToken {
		t.Fatal("cleanup DELETE targeted only the invalidated old token")
	}
}

func TestAdminBeginShutdownDuringRefreshCleansReplacementAndReturnsCurrent(t *testing.T) {
	t.Parallel()
	oldToken := strings.Repeat("o", 43)
	newToken := strings.Repeat("n", 43)
	holder := newAdminTokenHolder(oldToken)
	refreshEntered := make(chan struct{})
	releaseRefresh := make(chan struct{})
	cleaned := make(chan string, 1)
	rotationDone := make(chan error, 1)
	go func() {
		rotationDone <- holder.Rotate(
			t.Context(),
			func(refreshCtx context.Context, current string) (string, error) {
				if current != oldToken {
					return "", errors.New("refresh did not receive the owned token")
				}
				close(refreshEntered)
				<-refreshCtx.Done()
				<-releaseRefresh
				return newToken, nil
			},
			func(token string) error {
				cleaned <- token
				return nil
			},
		)
	}()
	<-refreshEntered

	shutdownDone := make(chan struct {
		token string
		err   error
	}, 1)
	go func() {
		token, err := holder.BeginShutdown(t.Context())
		shutdownDone <- struct {
			token string
			err   error
		}{token: token, err: err}
	}()
	select {
	case result := <-shutdownDone:
		t.Fatalf("BeginShutdown() returned before refresh handed off: %#v", result)
	case <-time.After(20 * time.Millisecond):
	}
	close(releaseRefresh)

	result := <-shutdownDone
	if result.err != nil {
		t.Fatalf("BeginShutdown() error = %v", result.err)
	}
	if result.token != oldToken || holder.Current() != oldToken {
		t.Fatal("shutdown did not retain ownership of the current session")
	}
	if got := <-cleaned; got != newToken {
		t.Fatal("shutdown-boundary replacement was not handed to cleanup")
	}
	if err := <-rotationDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("Rotate() error = %v, want cancellation after replacement cleanup", err)
	}
	if _, release, err := holder.Acquire(t.Context()); err == nil {
		release()
		t.Fatal("shutdown admitted a request while refresh ownership was handed off")
	}
	cleared, err := holder.Clear(t.Context())
	if err != nil || cleared != oldToken || holder.Current() != "" {
		t.Fatalf("Clear() = %q, %v, want cleared current ownership", cleared, err)
	}
}

func TestAdminClearDuringRefreshCleansReplacementAndReturnsCurrent(t *testing.T) {
	t.Parallel()
	current := strings.Repeat("o", 43)
	holder := newAdminTokenHolder(current)
	replacement := strings.Repeat("n", 43)
	refreshEntered := make(chan struct{})
	cleaned := make(chan string, 1)
	rotationDone := make(chan error, 1)
	go func() {
		rotationDone <- holder.Rotate(
			t.Context(),
			func(refreshCtx context.Context, _ string) (string, error) {
				close(refreshEntered)
				<-refreshCtx.Done()
				return replacement, nil
			},
			func(token string) error {
				cleaned <- token
				return nil
			},
		)
	}()
	<-refreshEntered

	clearedToken, err := holder.Clear(t.Context())
	if err != nil {
		t.Fatalf("Clear() error = %v", err)
	}
	if clearedToken != current {
		t.Fatal("Clear() did not return ownership of the current session")
	}
	if got := <-cleaned; got != replacement {
		t.Fatal("Clear() did not hand the shutdown-boundary replacement to cleanup")
	}
	if got := holder.Current(); got != "" {
		t.Fatalf("Current() after Clear = %q, want no retained credential", got)
	}
	if err := <-rotationDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("Rotate() error = %v, want cancellation after replacement handoff", err)
	}
}

func TestAdminLateRefreshAfterShutdownTimeoutIsCleanedAndHolderCleared(t *testing.T) {
	t.Parallel()
	cleanupFailure := errors.New("cleanup transport failed")
	tests := []struct {
		name       string
		cleanupErr error
	}{
		{name: "cleanup success"},
		{name: "cleanup failure", cleanupErr: cleanupFailure},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			oldToken := strings.Repeat("o", 43)
			replacement := strings.Repeat("private-late-replacement-", 2)
			holder := newAdminTokenHolder(oldToken)
			refreshEntered := make(chan struct{})
			releaseRefresh := make(chan struct{})
			cleaned := make(chan string, 1)
			rotationDone := make(chan error, 1)
			go func() {
				rotationDone <- holder.Rotate(
					t.Context(),
					func(_ context.Context, _ string) (string, error) {
						close(refreshEntered)
						<-releaseRefresh
						return replacement, nil
					},
					func(token string) error {
						cleaned <- token
						return tt.cleanupErr
					},
				)
			}()
			<-refreshEntered

			handoffCtx, cancelHandoff := context.WithTimeout(t.Context(), 20*time.Millisecond)
			defer cancelHandoff()
			token, handoffErr := holder.BeginShutdown(handoffCtx)
			if !errors.Is(handoffErr, context.DeadlineExceeded) || token != oldToken {
				t.Fatalf(
					"BeginShutdown() = %q, %v, want bounded ownership of current token",
					token,
					handoffErr,
				)
			}
			clearedToken, clearErr := holder.Clear(handoffCtx)
			if !errors.Is(clearErr, context.DeadlineExceeded) || clearedToken != oldToken {
				t.Fatalf("Clear() = %q, %v, want forced clear with current ownership", clearedToken, clearErr)
			}
			if holder.Current() != "" {
				t.Fatal("timed-out handoff left the holder credential populated")
			}

			close(releaseRefresh)
			if got := <-cleaned; got != replacement {
				t.Fatal("late replacement was not delivered to the cleanup recipient")
			}
			rotationErr := <-rotationDone
			if !errors.Is(rotationErr, context.Canceled) {
				t.Fatalf("Rotate() error = %v, want shutdown cancellation", rotationErr)
			}
			if !errors.Is(rotationErr, tt.cleanupErr) && tt.cleanupErr != nil {
				t.Fatalf("Rotate() error = %v, want cleanup failure", rotationErr)
			}
			if strings.Contains(rotationErr.Error(), replacement) {
				t.Fatal("late replacement leaked through the cleanup error")
			}
			if holder.Current() != "" || !holder.cleared {
				t.Fatal("late refresh repopulated or reopened the cleared holder")
			}
		})
	}
}

func TestAdminRotationRejectsMissingOrphanCleanup(t *testing.T) {
	t.Parallel()
	holder := newAdminTokenHolder(strings.Repeat("o", 43))
	refreshCalled := false
	err := holder.Rotate(
		t.Context(),
		func(context.Context, string) (string, error) {
			refreshCalled = true
			return strings.Repeat("n", 43), nil
		},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "cleanup") {
		t.Fatalf("Rotate() error = %v, want missing cleanup rejection", err)
	}
	if refreshCalled {
		t.Fatal("rotation minted a replacement without an orphan cleanup recipient")
	}
	cleared, clearErr := holder.Clear(t.Context())
	if clearErr != nil || cleared == "" || holder.Current() != "" {
		t.Fatalf("Clear() = %q, %v after rejected rotation", cleared, clearErr)
	}
}

func TestAdminRotationConcurrentRequestStress(t *testing.T) {
	t.Parallel()
	holder := newAdminTokenHolder("token-0")
	const rotations = 100
	const readers = 16
	stop := make(chan struct{})
	var readersJoined sync.WaitGroup
	readersJoined.Add(readers)
	for range readers {
		go func() {
			defer readersJoined.Done()
			for {
				select {
				case <-stop:
					return
				default:
					token, release, err := holder.Acquire(t.Context())
					if err != nil || token == "" {
						t.Error("request observed an empty token during rotation")
						return
					}
					release()
				}
			}
		}()
	}
	for index := 1; index <= rotations; index++ {
		replacement := fmt.Sprintf("token-%d", index)
		if err := holder.Rotate(
			t.Context(),
			func(_ context.Context, current string) (string, error) {
				if current == "" {
					return "", errors.New("rotation observed empty current token")
				}
				return replacement, nil
			},
			adminTestOrphanCleanup,
		); err != nil {
			t.Fatalf("Rotate(%d) error = %v", index, err)
		}
	}
	close(stop)
	readersJoined.Wait()
	if got := holder.Current(); got != "token-100" {
		t.Fatalf("final token = %q, want token-100", got)
	}
}

func TestAdminRotationLongResponseTimesOutAndUnpausesRequests(t *testing.T) {
	t.Parallel()
	longStarted := make(chan struct{})
	releaseLong := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/long" {
			w.WriteHeader(http.StatusOK)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			close(longStarted)
			select {
			case <-releaseLong:
			case <-request.Context().Done():
			}
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	holder := newAdminTokenHolder("current-token")
	proxy, err := startAdminProxy(
		t.Context(),
		0,
		adminSessionTestPort(t, upstream.URL),
		holder,
	)
	if err != nil {
		t.Fatalf("startAdminProxy() error = %v", err)
	}
	t.Cleanup(func() { _ = proxy.Close(t.Context()) })
	request, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		proxy.URL()+"/long",
		http.NoBody,
	)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("long proxy request error = %v", err)
	}
	defer response.Body.Close()
	<-longStarted

	rotateCtx, cancelRotate := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancelRotate()
	err = holder.Rotate(
		rotateCtx,
		func(context.Context, string) (string, error) {
			t.Fatal("refresh ran before the long request drained")
			return "", nil
		},
		adminTestOrphanCleanup,
	)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Rotate() error = %v, want bounded deadline", err)
	}
	fastRequest, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		proxy.URL()+"/fast",
		http.NoBody,
	)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	fastResponse, err := http.DefaultClient.Do(fastRequest)
	if err != nil {
		t.Fatalf("request remained paused after timed-out rotation: %v", err)
	}
	_ = fastResponse.Body.Close()
	if fastResponse.StatusCode != http.StatusNoContent {
		t.Fatalf("fast response status = %d", fastResponse.StatusCode)
	}
	close(releaseLong)
}

func TestAdminShutdownLongResponseClearsTokenAndJoinsProxyWatcher(t *testing.T) {
	t.Parallel()
	longStarted := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		close(longStarted)
		<-request.Context().Done()
	}))
	defer upstream.Close()
	proxyCtx, cancelProxy := context.WithCancel(t.Context())
	holder := newAdminTokenHolder("current-token")
	proxy, err := startAdminProxy(
		proxyCtx,
		0,
		adminSessionTestPort(t, upstream.URL),
		holder,
	)
	if err != nil {
		t.Fatalf("startAdminProxy() error = %v", err)
	}
	request, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		proxy.URL()+"/long",
		http.NoBody,
	)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("long proxy request error = %v", err)
	}
	defer response.Body.Close()
	<-longStarted

	clearDone := make(chan struct{})
	go func() {
		_, _ = holder.Clear(t.Context())
		close(clearDone)
	}()
	select {
	case <-clearDone:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Clear blocked on a long-lived response")
	}
	cancelProxy()
	closeDone := make(chan error, 1)
	go func() { closeDone <- proxy.Close(t.Context()) }()
	select {
	case closeErr := <-closeDone:
		if closeErr != nil {
			t.Fatalf("Close() error = %v", closeErr)
		}
	case <-time.After(time.Second):
		t.Fatal("proxy shutdown hung on a long-lived response or context watcher")
	}
	select {
	case <-proxy.watchJoined:
	default:
		t.Fatal("Close returned before the proxy context watcher joined")
	}
}

func TestAdminShutdownProxyCloseIsIdempotent(t *testing.T) {
	t.Parallel()
	proxy, err := startAdminProxy(
		context.Background(), 0, 1, newAdminTokenHolder(strings.Repeat("m", 43)),
	)
	if err != nil {
		t.Fatalf("startAdminProxy() error = %v", err)
	}
	if err := proxy.Close(t.Context()); err != nil {
		t.Fatalf("first Close() error = %v", err)
	}
	if err := proxy.Close(t.Context()); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}
	select {
	case <-proxy.Done():
	case <-time.After(time.Second):
		t.Fatal("proxy did not join")
	}
}

func TestAdminProxyCloseBoundsStuckHandlerAndRejectsLateAdmission(t *testing.T) {
	t.Parallel()
	handlerStarted := make(chan struct{})
	releaseHandler := make(chan struct{})
	var releaseHandlerOnce sync.Once
	release := func() { releaseHandlerOnce.Do(func() { close(releaseHandler) }) }
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(handlerStarted)
		<-releaseHandler
	}))
	defer func() {
		release()
		upstream.Close()
	}()
	holder := newAdminTokenHolder(strings.Repeat("m", 43))
	proxy, err := startAdminProxy(
		t.Context(),
		0,
		adminSessionTestPort(t, upstream.URL),
		holder,
	)
	if err != nil {
		t.Fatalf("startAdminProxy() error = %v", err)
	}
	forceClosed := make(chan struct{})
	proxy.forceCloseHook = func() { close(forceClosed) }
	requestDone := make(chan error, 1)
	stuckRequest, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		proxy.URL()+"/stuck",
		http.NoBody,
	)
	if err != nil {
		t.Fatalf("build stuck request: %v", err)
	}
	go func() {
		response, requestErr := http.DefaultClient.Do(stuckRequest)
		if response != nil {
			_ = response.Body.Close()
		}
		requestDone <- requestErr
	}()
	<-handlerStarted

	closeCtx, cancelClose := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancelClose()
	started := time.Now()
	closeErr := proxy.Close(closeCtx)
	if !errors.Is(closeErr, context.DeadlineExceeded) {
		t.Fatalf("Close() error = %v, want actionable deadline", closeErr)
	}
	if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
		t.Fatalf("Close() remained blocked for %s after its deadline", elapsed)
	}
	select {
	case <-forceClosed:
	default:
		t.Fatal("Close() deadline did not invoke forced server close")
	}

	request := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		proxy.URL()+"/late",
		http.NoBody,
	)
	request.Host = strings.TrimPrefix(proxy.URL(), "http://")
	response := httptest.NewRecorder()
	proxy.server.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("late handler status = %d, want closed admission gate", response.Code)
	}
	if !strings.Contains(response.Body.String(), "proxy is shutting down") {
		t.Fatalf("late handler response = %q, want request-gate rejection", response.Body.String())
	}

	release()
	select {
	case <-requestDone:
	case <-time.After(time.Second):
		t.Fatal("forced proxy close did not release the downstream request")
	}
	if err := proxy.Close(t.Context()); err != nil {
		t.Fatalf("Close() after handler release = %v", err)
	}
}

func TestAdminProxyCloseBoundsWatcherJoin(t *testing.T) {
	t.Parallel()
	done := make(chan struct{})
	close(done)
	proxy := &adminProxy{
		server:      &http.Server{ReadHeaderTimeout: time.Second},
		done:        done,
		watchStop:   make(chan struct{}),
		watchJoined: make(chan struct{}),
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	err := proxy.Close(ctx)
	if !errors.Is(err, context.DeadlineExceeded) ||
		!strings.Contains(err.Error(), "watcher") {
		t.Fatalf("Close() error = %v, want bounded watcher join timeout", err)
	}
}

func adminTestOrphanCleanup(string) error {
	return nil
}
