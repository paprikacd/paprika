// Package mcp serves Paprika's fleet API to MCP clients.
package mcp

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
)

// internalCredentialKey is the context key carrying the short-lived,
// paprika-api-audience credential Server.mintConsoleCredential mints for the
// in-process Connect request, through to RoundTrip. See RoundTrip's doc
// comment for why this exists: without it, the in-process transport has no
// credential to attach, and the auth interceptor in the real Connect chain
// rejects every MCP tool call with CodeUnauthenticated.
//
// This deliberately does NOT carry the caller's own MCP-audience bearer
// token. Forwarding that token verbatim was the original design, and it is
// exactly what let a token minted for the MCP server's own audience
// ("paprika-mcp") authenticate directly against the console/CLI Connect API
// once that chain's self-signed authenticator started requiring
// aud=paprika-api — the console chain has no way to accept both audiences
// without accepting neither strictly. Minting a fresh, narrower-audience
// credential per request — carrying the same subject/email/name so the
// audit trail still names the real user — breaks that coupling: the console
// chain enforces aud=paprika-api on every caller, MCP-forwarded or not.
type internalCredentialKey struct{}

// withInternalCredential returns a context carrying credential for
// RoundTrip to attach to the outgoing in-process request as an Authorization
// header. Callers must pass a credential already minted for the
// paprika-api audience by the MCP server itself (Server.mintConsoleCredential)
// — RoundTrip performs no validation or minting of its own, it only forwards
// what it is given.
func withInternalCredential(ctx context.Context, credential string) context.Context {
	return context.WithValue(ctx, internalCredentialKey{}, credential)
}

// internalCredentialFromContext returns the credential stashed by
// withInternalCredential, if any.
func internalCredentialFromContext(ctx context.Context) (string, bool) {
	credential, ok := ctx.Value(internalCredentialKey{}).(string)
	if !ok || credential == "" {
		return "", false
	}
	return credential, true
}

// inProcessTransport dispatches requests directly into an http.Handler with no
// socket. Connect's HTTP semantics — status codes and headers — are
// preserved because httptest.ResponseRecorder captures both, which is what
// lets error codes survive the round trip on the unary Connect protocol
// used by this codebase (no gRPC/gRPC-Web), where the error code travels in
// the JSON response body gated on the HTTP status not being 200.
//
// Unary RPCs only. httptest.ResponseRecorder buffers the entire response
// and only becomes readable once the handler's ServeHTTP call returns.
// Routing a streaming RPC (e.g. StreamResourceLogs) through this transport
// would degrade it to fully-buffered batch delivery, use unbounded memory
// for a long-lived stream, and for a live tail may never return at all. Do
// not route streaming RPCs through this transport — the MCP tool surface
// intentionally excludes StreamResourceLogs for exactly this reason.
type inProcessTransport struct {
	handler http.Handler
}

// NewInProcessTransport returns a RoundTripper that serves unary requests
// from h with no network hop. See inProcessTransport's doc comment for the
// unary-only constraint that callers must respect.
func NewInProcessTransport(h http.Handler) http.RoundTripper {
	return &inProcessTransport{handler: h}
}

// RoundTrip serves req against the wrapped handler on a background
// goroutine and races its completion against req.Context(). If the context
// is done first, RoundTrip returns promptly with the context's error
// instead of blocking until the handler finishes.
//
// This unblocks the CALLER only. httptest.ResponseRecorder and
// http.Handler give no mechanism to forcibly stop in-flight work, so on
// cancellation the handler goroutine keeps running in the background —
// possibly forever, for a handler that never returns — even after
// RoundTrip has already returned to its caller. RoundTrip does not, and
// cannot, cancel the handler's work; it can only stop waiting for it.
func (t *inProcessTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if credential, ok := internalCredentialFromContext(req.Context()); ok {
		req = req.Clone(req.Context())
		req.Header.Set("Authorization", "Bearer "+credential)
	}

	respCh := make(chan *http.Response, 1)
	go func() {
		rec := httptest.NewRecorder()
		t.handler.ServeHTTP(rec, req)

		resp := rec.Result()
		resp.Request = req
		respCh <- resp
	}()

	select {
	case resp := <-respCh:
		return resp, nil
	case <-req.Context().Done():
		return nil, fmt.Errorf("mcp: in-process transport: %w", req.Context().Err())
	}
}
