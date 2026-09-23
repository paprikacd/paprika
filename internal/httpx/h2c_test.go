package httpx

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/http2"
)

// h2cTransport mirrors the cleartext half of ConnectTransport: prior-knowledge
// HTTP/2 over plain TCP.
func h2cTransport() http.RoundTripper {
	return &http2.Transport{
		AllowHTTP: true,
		DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
			return (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, addr)
		},
		ReadIdleTimeout: 30 * time.Second,
		PingTimeout:     15 * time.Second,
	}
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
	proto, header := get(t, h2cTransport(), newH2CTestServer(t).URL)

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

	proto, _ := get(t, transport, newH2CTestServer(t).URL)

	if !strings.HasPrefix(proto, "HTTP/1") {
		t.Fatalf("expected HTTP/1.1 response, got %s", proto)
	}
}

// TestWithH2CMultiplexes confirms concurrent h2 streams share one TCP
// connection — the property the connection cap relies on.
func TestWithH2CMultiplexes(t *testing.T) {
	ts := newH2CTestServer(t)
	client := &http.Client{Transport: h2cTransport()}

	const streams = 8
	done := make(chan error, streams)
	for range streams {
		go func() {
			req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, ts.URL, nil)
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
}
