package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"connectrpc.com/connect"

	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

const (
	maxConnectMessageBytes = 10 * 1024 * 1024
	shutdownTimeout        = 5 * time.Second
)

func newFixtureHandler(fixture *fixtureData, assetsDir string) (http.Handler, error) {
	if fixture == nil || fixture.client == nil || fixture.index == nil {
		return nil, errors.New("complete fixture data is required")
	}
	static, err := newStaticHandler(assetsDir)
	if err != nil {
		return nil, err
	}

	// The fixture is intentionally same-origin and auth-disabled. Omitting an
	// authorizer and auth interceptor is explicit here: smoke tests exercise the
	// real PaprikaServer and fleet authorization boundary's unauthenticated-dev
	// behavior without inventing browser credentials.
	server := apiserver.NewPaprikaServer(
		fixture.client,
		nil,
		apiserver.WithFleetIndex(fixture.index),
	)
	procedurePrefix, connectHandler := v1connect.NewPaprikaServiceHandler(
		server,
		connect.WithReadMaxBytes(maxConnectMessageBytes),
	)

	mux := http.NewServeMux()
	mux.Handle(procedurePrefix, connectHandler)
	// Keep this exact legacy stream route fail-closed so the UI fallback cannot
	// turn an unsupported EventSource request into a misleading 200 response.
	mux.Handle("/events", http.NotFoundHandler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		if _, writeErr := io.WriteString(w, "ok\n"); writeErr != nil {
			return
		}
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if readyErr := fixture.index.CheckReady(); readyErr != nil {
			http.Error(w, readyErr.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		if _, writeErr := io.WriteString(w, "ready\n"); writeErr != nil {
			return
		}
	})
	mux.Handle("/", static)
	return mux, nil
}

func newHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

// serve owns the listener and returns nil after a context-driven graceful
// shutdown. A bounded forced close prevents the fixture from hanging CI when a
// browser leaves a connection open.
func serve(ctx context.Context, listener net.Listener, handler http.Handler) error {
	if ctx == nil {
		return errors.New("server context is required")
	}
	if listener == nil {
		return errors.New("listener is required")
	}
	if handler == nil {
		return errors.New("handler is required")
	}

	server := newHTTPServer(handler)
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- server.Serve(listener)
	}()

	select {
	case err := <-serveDone:
		return normalizeServeError(err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			if closeErr := server.Close(); closeErr != nil {
				return fmt.Errorf("shut down fixture server: %w", errors.Join(err, closeErr))
			}
			return fmt.Errorf("shut down fixture server: %w", err)
		}
		return normalizeServeError(<-serveDone)
	}
}

func normalizeServeError(err error) error {
	if err == nil || errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return fmt.Errorf("serve fixture: %w", err)
}

func run(ctx context.Context, cfg config) error {
	fixture, err := seedFixture(ctx, cfg.applications)
	if err != nil {
		return fmt.Errorf("seed fleet fixture: %w", err)
	}
	handler, err := newFixtureHandler(fixture, cfg.assets)
	if err != nil {
		return fmt.Errorf("build fixture handler: %w", err)
	}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", cfg.listen)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", cfg.listen, err)
	}
	return serve(ctx, listener, handler)
}
