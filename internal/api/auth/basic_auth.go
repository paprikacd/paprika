package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// BasicAuthConfig configures HTTP Basic authentication.
type BasicAuthConfig struct {
	// Username is the allowed username.
	Username string
	// PasswordHash is the SHA-256 hash of the allowed password, hex-encoded.
	PasswordHash string
	// Password is the plain-text password. Use only for development/testing.
	// If PasswordHash is set, it takes precedence.
	Password string
}

// BasicAuthenticator implements HTTP Basic authentication.
type BasicAuthenticator struct {
	username string
	hash     string
}

// NewBasicAuthenticator creates a new BasicAuthenticator.
func NewBasicAuthenticator(cfg BasicAuthConfig) (*BasicAuthenticator, error) {
	if cfg.Username == "" {
		return nil, errors.New("basic auth username is required")
	}
	if cfg.PasswordHash == "" && cfg.Password == "" {
		return nil, errors.New("basic auth password or passwordHash is required")
	}

	hash := cfg.PasswordHash
	if hash == "" {
		h := sha256.Sum256([]byte(cfg.Password))
		hash = hex.EncodeToString(h[:])
	}

	return &BasicAuthenticator{
		username: cfg.Username,
		hash:     hash,
	}, nil
}

// Authenticate validates the Basic auth header.
func (b *BasicAuthenticator) Authenticate(ctx context.Context) (*Principal, error) {
	req, err := requestFromContext(ctx)
	if err != nil {
		return nil, errors.Join(err, ErrUnauthenticated)
	}

	auth := req.Header().Get("Authorization")
	if auth == "" {
		return nil, ErrUnauthenticated
	}

	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Basic") {
		return nil, fmt.Errorf("invalid authorization header: %w", ErrUnauthenticated)
	}

	decoded, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errors.Join(fmt.Errorf("invalid base64: %w", err), ErrUnauthenticated)
	}

	creds := strings.SplitN(string(decoded), ":", 2)
	if len(creds) != 2 {
		return nil, fmt.Errorf("invalid credentials format: %w", ErrUnauthenticated)
	}

	username := creds[0]
	password := creds[1]

	if subtle.ConstantTimeCompare([]byte(username), []byte(b.username)) != 1 {
		return nil, ErrUnauthenticated
	}

	h := sha256.Sum256([]byte(password))
	hash := hex.EncodeToString(h[:])
	if subtle.ConstantTimeCompare([]byte(hash), []byte(b.hash)) != 1 {
		return nil, ErrUnauthenticated
	}

	return &Principal{
		Subject: username,
		Name:    username,
		Claims:  map[string]interface{}{"method": "basic"},
	}, nil
}
