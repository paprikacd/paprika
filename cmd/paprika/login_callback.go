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
	"net"
	"net/http"
	"sync"
	"time"
)

const (
	loginCallbackAddress        = "127.0.0.1:17632"
	loginCallbackURI            = "http://127.0.0.1:17632/callback"
	loginCallbackMaxHeaderBytes = 8 << 10
	loginCallbackIdleTimeout    = 30 * time.Second
	loginCallbackWriteTimeout   = 30 * time.Second
)

var errLoginCallbackServerStopped = errors.New("login callback server stopped unexpectedly")

type loginCallbackEvent struct {
	code string
	err  error
}

type loginCallbackResult struct {
	success bool
}

type loginCallbackServer struct {
	expectedState string
	server        *http.Server
	events        chan loginCallbackEvent
	failures      chan error
	done          chan struct{}
	serveDone     chan struct{}

	mu       sync.Mutex
	accepted bool
	result   loginCallbackResult
	once     sync.Once
}

func newLoginCallbackServer(listener net.Listener, expectedState string) *loginCallbackServer {
	callback := &loginCallbackServer{
		expectedState: expectedState,
		events:        make(chan loginCallbackEvent, 1),
		failures:      make(chan error, 1),
		done:          make(chan struct{}),
		serveDone:     make(chan struct{}),
	}
	callback.server = &http.Server{
		Handler:           http.HandlerFunc(callback.handle),
		ReadHeaderTimeout: 5 * time.Second,
		MaxHeaderBytes:    loginCallbackMaxHeaderBytes,
		IdleTimeout:       loginCallbackIdleTimeout,
		WriteTimeout:      loginCallbackWriteTimeout,
	}
	go func() {
		defer close(callback.serveDone)
		if serveErr := callback.server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			callback.failServe()
		}
	}()
	return callback
}

func (c *loginCallbackServer) handle(w http.ResponseWriter, r *http.Request) { //nolint:cyclop // Callback validation order is security-sensitive and intentionally linear.
	if r.URL.Path != "/callback" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	query := r.URL.Query()
	if query.Get("state") == "" || query.Get("state") != c.expectedState {
		writeLoginCallbackFailure(w, http.StatusBadRequest)
		return
	}

	c.mu.Lock()
	if c.accepted {
		c.mu.Unlock()
		writeLoginCallbackFailure(w, http.StatusConflict)
		return
	}
	c.accepted = true
	event := loginCallbackEvent{}
	switch {
	case query.Get("error") != "":
		event.err = errAuthenticationFailed
	case query.Get("code") == "":
		event.err = errAuthenticationFailed
	default:
		event.code = query.Get("code")
	}
	c.events <- event
	c.mu.Unlock()

	<-c.done
	c.mu.Lock()
	result := c.result
	c.mu.Unlock()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if result.success {
		w.WriteHeader(http.StatusOK)
		if _, writeErr := w.Write([]byte("<!doctype html><title>Login successful</title><h1>Login successful</h1><p>You may close this window.</p>")); writeErr != nil {
			return
		}
		return
	}
	w.WriteHeader(http.StatusBadRequest)
	writeLoginCallbackFailureBody(w)
}

func writeLoginCallbackFailure(w http.ResponseWriter, status int) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	writeLoginCallbackFailureBody(w)
}

func writeLoginCallbackFailureBody(w http.ResponseWriter) {
	if _, writeErr := w.Write([]byte("<!doctype html><title>Login failed</title><h1>Login failed</h1><p>Authentication failed; return to the terminal and try again.</p>")); writeErr != nil {
		return
	}
}

func (c *loginCallbackServer) complete(result loginCallbackResult) {
	c.once.Do(func() {
		c.mu.Lock()
		c.result = result
		c.mu.Unlock()
		close(c.done)
	})
}

func (c *loginCallbackServer) failServe() {
	c.mu.Lock()
	if c.accepted {
		c.mu.Unlock()
		return
	}
	c.accepted = true
	c.mu.Unlock()
	c.complete(loginCallbackResult{})
	c.failures <- errLoginCallbackServerStopped
}

func (c *loginCallbackServer) shutdown(parent context.Context) {
	c.complete(loginCallbackResult{})
	defer func() { <-c.serveDone }()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 2*time.Second)
	defer cancel()
	if err := c.server.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		if closeErr := c.server.Close(); closeErr != nil && !errors.Is(closeErr, http.ErrServerClosed) {
			return
		}
	}
}
