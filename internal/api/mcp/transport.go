// Package mcp serves Paprika's fleet API to MCP clients.
package mcp

import (
	"net/http"
	"net/http/httptest"
)

// inProcessTransport dispatches requests directly into an http.Handler with no
// socket. Connect's HTTP semantics — status codes, headers, and trailers — are
// preserved because httptest.ResponseRecorder captures all three, which is what
// lets error codes survive the round trip.
type inProcessTransport struct {
	handler http.Handler
}

// NewInProcessTransport returns a RoundTripper that serves requests from h.
func NewInProcessTransport(h http.Handler) http.RoundTripper {
	return &inProcessTransport{handler: h}
}

func (t *inProcessTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	rec := httptest.NewRecorder()
	t.handler.ServeHTTP(rec, req)

	resp := rec.Result()
	resp.Request = req
	return resp, nil
}
