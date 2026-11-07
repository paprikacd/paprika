package httpx

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strings"
	"testing"
)

// h2cTransport uses a fresh production transport so tests can close their
// connections without affecting other callers of the shared transport.
func h2cTransport(t *testing.T) *http.Transport {
	t.Helper()
	transport := newConnectH2CTransport()
	t.Cleanup(transport.CloseIdleConnections)
	return transport
}

// newH2CTestServer starts a cleartext server configured like the real paprika
// listeners: HTTP/1.1 + prior-knowledge h2c on one port.
func newH2CTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-seen-proto", r.Proto)
		_, _ = io.WriteString(w, "ok")
	}))
	WithH2C(ts.Config)
	ts.Start()
	t.Cleanup(ts.Close)
	return ts
}

func get(t *testing.T, rt http.RoundTripper, url string) (proto string, header http.Header) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	resp, err := (&http.Client{Transport: rt}).Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
	return resp.Proto, resp.Header
}

// TestWithH2CServesCleartextHTTP2 confirms the server answers a
// prior-knowledge h2c request, so gRPC/Connect clients can multiplex.
func TestWithH2CServesCleartextHTTP2(t *testing.T) {
	proto, header := get(t, h2cTransport(t), newH2CTestServer(t).URL)

	if !strings.HasPrefix(proto, "HTTP/2") {
		t.Fatalf("expected HTTP/2 response, got %s", proto)
	}
	if got := header.Get("x-seen-proto"); got != "HTTP/2.0" {
		t.Fatalf("handler saw proto %q, want HTTP/2.0", got)
	}
}

// TestWithH2CPreservesHTTP1 confirms plain HTTP/1.1 clients keep working on
// the same listener (probes, older pods during a roll, h1-only upstreams).
func TestWithH2CPreservesHTTP1(t *testing.T) {
	transport := &http.Transport{Protocols: func() *http.Protocols {
		p := new(http.Protocols)
		p.SetHTTP1(true)
		return p
	}()}
	t.Cleanup(transport.CloseIdleConnections)

	proto, _ := get(t, transport, newH2CTestServer(t).URL)

	if !strings.HasPrefix(proto, "HTTP/1") {
		t.Fatalf("expected HTTP/1.1 response, got %s", proto)
	}
}

// TestWithH2CMultiplexes confirms concurrent h2 streams share one TCP
// connection — the property the connection cap relies on.
func TestWithH2CMultiplexes(t *testing.T) {
	ts := newH2CTestServer(t)
	transport := h2cTransport(t)
	client := &http.Client{Transport: transport}
	// Establish one connection before the burst so the assertion measures
	// stream multiplexing, rather than concurrent initial connection attempts.
	get(t, transport, ts.URL)

	const streams = 8
	done := make(chan error, streams)
	connections := make(chan net.Conn, streams)
	for range streams {
		go func() {
			ctx := httptrace.WithClientTrace(context.Background(), &httptrace.ClientTrace{
				GotConn: func(info httptrace.GotConnInfo) { connections <- info.Conn },
			})
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL, nil)
			if err != nil {
				done <- err
				return
			}
			resp, err := client.Do(req)
			if err != nil {
				done <- err
				return
			}
			defer resp.Body.Close()
			_, _ = io.Copy(io.Discard, resp.Body)
			done <- nil
		}()
	}
	for range streams {
		if err := <-done; err != nil {
			t.Fatalf("concurrent h2 request failed: %v", err)
		}
	}
	seen := make(map[net.Conn]bool)
	for range streams {
		seen[<-connections] = true
	}
	if len(seen) != 1 {
		t.Fatalf("concurrent h2 streams used %d TCP connections, want 1", len(seen))
	}
}
