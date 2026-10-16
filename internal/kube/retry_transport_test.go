package kube

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// resetOnNTHRequest returns a server that hijacks and kills the connection
// for the first `kills` GET requests — reproducing the VKE-style
// "connection reset by peer" the client must ride over.
func resetOnNTHRequest(t *testing.T, kills int) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if int(hits.Add(1)) <= kills {
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Error("hijack unsupported")
				return
			}
			conn, _, err := hj.Hijack()
			if err != nil {
				return
			}
			_ = conn.Close() // client sees EOF/reset, never a response
			return
		}
		fmt.Fprintln(w, "ok")
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func TestRetryTransport_RecoversFromConnectionReset(t *testing.T) {
	srv, hits := resetOnNTHRequest(t, 2)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL+"/api", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := (&retryTransport{base: http.DefaultTransport}).RoundTrip(req)
	if err != nil {
		t.Fatalf("RoundTrip() error: %v", err)
	}
	_ = resp.Body.Close()
	if hits.Load() != 3 {
		t.Fatalf("attempts = %d, want 3", hits.Load())
	}
}

func TestRetryTransport_NonIdempotentNotRetried(t *testing.T) {
	srv, hits := resetOnNTHRequest(t, 5)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, srv.URL+"/api", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	if resp, err := (&retryTransport{base: http.DefaultTransport}).RoundTrip(req); err == nil {
		_ = resp.Body.Close()
		t.Fatal("POST should surface the transport error without retrying")
	}
	if hits.Load() != 1 {
		t.Fatalf("POST attempts = %d, want exactly 1", hits.Load())
	}
}

func TestRetryTransport_GivesUpAfterMaxAttempts(t *testing.T) {
	srv, hits := resetOnNTHRequest(t, 10)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL+"/api", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp, err := (&retryTransport{base: http.DefaultTransport}).RoundTrip(req); err == nil {
		_ = resp.Body.Close()
		t.Fatal("expected error after exhausting attempts")
	}
	if hits.Load() != retryTransportMaxAttempts {
		t.Fatalf("attempts = %d, want %d", hits.Load(), retryTransportMaxAttempts)
	}
}

func TestRetryTransport_RespectsCancellation(t *testing.T) {
	srv, _ := resetOnNTHRequest(t, 10)
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp, err := (&retryTransport{base: http.DefaultTransport}).RoundTrip(req); err == nil {
		_ = resp.Body.Close()
		t.Fatal("expected cancellation error")
	}
}

func TestRetryTransport_L4RefusedStillFailsCleanly(t *testing.T) {
	// Nothing listening — exercises the non-hijack transport error path.
	l, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://"+addr+"/api", nil)
	if err != nil {
		t.Fatal(err)
	}
	// ECONNREFUSED is deliberately not retried — the API server being down is
	// a different failure shape than a severed stream.
	resp, err := (&retryTransport{base: http.DefaultTransport}).RoundTrip(req)
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("expected connection refused")
	}
}
