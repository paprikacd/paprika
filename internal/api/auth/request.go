package auth

import (
	"context"
	"errors"
	"net/http"
)

// HTTPRequest is a minimal interface for extracting headers.
type HTTPRequest interface {
	Header() http.Header
}

// requestAdapter adapts *http.Request to the HTTPRequest interface.
type requestAdapter struct {
	r *http.Request
}

func (a *requestAdapter) Header() http.Header {
	return a.r.Header
}

// requestContextKey stores the HTTP request in context.
type requestContextKey struct{}

// WithRequest adds an HTTP request to context.
func WithRequest(ctx context.Context, r *http.Request) context.Context {
	return context.WithValue(ctx, requestContextKey{}, &requestAdapter{r: r})
}

func requestFromContext(ctx context.Context) (HTTPRequest, error) {
	if r, ok := ctx.Value(requestContextKey{}).(HTTPRequest); ok {
		return r, nil
	}
	return nil, errors.New("no HTTP request in context")
}
