// Package httpx holds HTTP transport plumbing shared by the paprika
// servers — the binary runs several listeners (API/UI, repo server, agent
// server) that all want the same cleartext-HTTP/2 behaviour.
package httpx

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"strings"
	"time"

	"golang.org/x/net/http2"
)

// MaxConcurrentStreams bounds the number of in-flight HTTP/2 streams per
// connection. Unbounded streams let a single h2 client pile requests into the
// handler regardless of the listener's connection cap.
const MaxConcurrentStreams = 256

// WithH2C configures srv to accept prior-knowledge cleartext HTTP/2 (h2c)
// alongside HTTP/1.1 on the same listener. h2 clients — gRPC and Connect
// alike — get multiplexed streams and header compression; plain HTTP/1.1
// requests (health probes, older pods mid-roll, h1-only upstreams) keep
// working. When the listener serves TLS instead, HTTP/2 is negotiated by
// ALPN as usual. Idle h2 connections are governed by srv.IdleTimeout.
func WithH2C(srv *http.Server) *http.Server {
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetHTTP2(true)
	protocols.SetUnencryptedHTTP2(true)
	srv.Protocols = protocols
	srv.HTTP2 = &http.HTTP2Config{MaxConcurrentStreams: MaxConcurrentStreams}
	return srv
}

// Shared singletons — both transport types pool connections per authority
// internally, so one instance serves every destination. Callers that build a
// fresh client per request (e.g. per-reconcile agent calls) still reuse the
// pooled connections.
var (
	connectH2CTransport = &http2.Transport{
		AllowHTTP: true,
		DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
			return (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, addr)
		},
		ReadIdleTimeout: 30 * time.Second,
		PingTimeout:     15 * time.Second,
	}
	connectTLSTransport = &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
)

// ConnectTransport picks the shared round-tripper for calls to another
// paprika component (repo server, remote agent). Cleartext in-cluster URLs
// speak prior-knowledge HTTP/2 (h2c — paprika listeners serve it via WithH2C)
// so concurrent calls multiplex over one connection instead of churning
// HTTP/1.1 connections; TLS URLs get an h2-capable transport with a wider idle
// pool than the stdlib default (MaxIdleConnsPerHost 2), which drops keep-alive
// connections under bursts.
//
// h2c is unconditional for http:// because servers and callers ship in the
// same image: roll the servers first (they accept both h1 and h2c) and there
// is no mixed-version window.
func ConnectTransport(baseURL string) http.RoundTripper {
	if strings.HasPrefix(baseURL, "http://") {
		return connectH2CTransport
	}
	return connectTLSTransport
}
