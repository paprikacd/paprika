package auth

import (
	"context"
	"errors"
)

// Authenticator validates credentials and returns a Principal.
type Authenticator interface {
	// Authenticate validates the request context (headers, tokens) and returns a Principal.
	Authenticate(ctx context.Context) (*Principal, error)
}

// ErrUnauthenticated is returned when authentication fails.
var ErrUnauthenticated = errors.New("unauthenticated")

// ErrUnauthorized is returned when authorization fails.
var ErrUnauthorized = errors.New("unauthorized")

// MultiAuthenticator tries multiple authenticators in order.
type MultiAuthenticator struct {
	authenticators []Authenticator
}

// NewMultiAuthenticator creates a new authenticator that tries each in order.
func NewMultiAuthenticator(authenticators ...Authenticator) *MultiAuthenticator {
	return &MultiAuthenticator{authenticators: authenticators}
}

// Authenticate tries each authenticator in order and returns the first successful principal.
func (m *MultiAuthenticator) Authenticate(ctx context.Context) (*Principal, error) {
	var lastErr error
	for _, authn := range m.authenticators {
		p, err := authn.Authenticate(ctx)
		if err == nil {
			return p, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return nil, errors.Join(lastErr, ErrUnauthenticated)
	}
	return nil, ErrUnauthenticated
}
