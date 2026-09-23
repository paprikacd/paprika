package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/sync/singleflight"
)

// BasicAuthConfig configures HTTP Basic authentication.
type BasicAuthConfig struct {
	// Username is the allowed username.
	Username string
	// PasswordHash is the bcrypt hash of the allowed password.
	PasswordHash string
}

// bcrypt verification costs ~100ms on a full core (~1s at the e2e apiServer's
// 100m limit) and runs per request — a DoS amplifier where unauthenticated
// floods burn CPU proportional to request rate. Basic-auth clients resend the
// same credential on every request, so verified results are cached briefly:
// repeat requests hit the cache and floods of an identical credential share
// one verification via singleflight. The TTL bounds how long a rotated
// password stays accepted.
const (
	basicAuthCacheTTL = time.Minute
	basicAuthCacheCap = 1024
)

// authResult is a cached verification outcome for one credential.
type authResult struct {
	ok      bool
	expires time.Time
}

// BasicAuthenticator implements HTTP Basic authentication.
type BasicAuthenticator struct {
	username string
	hash     string

	mu    sync.Mutex
	cache map[[32]byte]authResult
	group singleflight.Group
}

// NewBasicAuthenticator creates a new BasicAuthenticator.
func NewBasicAuthenticator(cfg BasicAuthConfig) (*BasicAuthenticator, error) {
	if cfg.Username == "" {
		return nil, errors.New("basic auth username is required")
	}
	if cfg.PasswordHash == "" {
		return nil, errors.New("basic auth passwordHash is required")
	}

	return &BasicAuthenticator{
		username: cfg.Username,
		hash:     cfg.PasswordHash,
		cache:    make(map[[32]byte]authResult),
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

	key := sha256.Sum256(decoded)
	if !b.verifyCredential(key, password) {
		return nil, ErrUnauthenticated
	}

	return b.principal(), nil
}

// verifyCredential checks the password against the bcrypt hash. A cached
// result serves repeat requests; on a miss, singleflight shares one bcrypt
// verification across concurrent requests carrying the same credential, and
// the outcome is stored for basicAuthCacheTTL.
func (b *BasicAuthenticator) verifyCredential(key [32]byte, password string) bool {
	if ok, hit := b.lookup(key); hit {
		return ok
	}
	v, err, _ := b.group.Do(string(key[:]), func() (interface{}, error) {
		ok := bcrypt.CompareHashAndPassword([]byte(b.hash), []byte(password)) == nil
		b.store(key, ok)
		return ok, nil
	})
	if err != nil {
		return false
	}
	verified, ok := v.(bool)
	if !ok {
		return false
	}
	return verified
}

func (b *BasicAuthenticator) principal() *Principal {
	return &Principal{
		Subject: b.username,
		Name:    b.username,
		Claims:  map[string]interface{}{"method": "basic"},
	}
}

// lookup returns a cached verification result if one exists and has not
// expired.
func (b *BasicAuthenticator) lookup(key [32]byte) (ok, hit bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	e, hit := b.cache[key]
	if !hit {
		return false, false
	}
	if time.Now().After(e.expires) {
		delete(b.cache, key)
		return false, false
	}
	return e.ok, true
}

// store records a verification result, evicting expired entries (or an
// arbitrary entry if still at capacity) so a flood of unique credentials
// cannot grow the cache without bound.
func (b *BasicAuthenticator) store(key [32]byte, ok bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.cache) >= basicAuthCacheCap {
		now := time.Now()
		for k, e := range b.cache {
			if now.After(e.expires) {
				delete(b.cache, k)
			}
		}
		if len(b.cache) >= basicAuthCacheCap {
			for k := range b.cache {
				delete(b.cache, k)
				break
			}
		}
	}
	b.cache[key] = authResult{ok: ok, expires: time.Now().Add(basicAuthCacheTTL)}
}
