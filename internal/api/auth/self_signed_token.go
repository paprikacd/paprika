package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// tokenExpiry is how long self-signed tokens are valid for.
const tokenExpiry = 24 * time.Hour

// ConsoleAPIAudience is the required "aud" claim for a Paprika self-signed
// token to authenticate against the console/CLI Connect API — the same API
// RollbackRelease and every other PaprikaService RPC live on. It is distinct
// from, and must never be confused with, the MCP server's own token
// audience (mcp.MCPTokenAudience, "paprika-mcp"): a token minted for one
// audience must not authenticate against the other surface. Before this
// audience existed, a token minted for MCP could authenticate directly
// against the console API as a full principal, bypassing the MCP layer's
// scope gate and two-phase confirmation entirely — see
// NewSelfSignedAuthenticatorForAudience and middleware.go's BuildAuthenticator.
const ConsoleAPIAudience = "paprika-api"

// jwtHeader is the fixed JWT header for HS256 tokens.
var jwtHeader = base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))

// selfSignedClaims are the claims embedded in a self-signed token.
type selfSignedClaims struct {
	Subject  string `json:"sub"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	Issuer   string `json:"iss,omitempty"`
	Audience string `json:"aud,omitempty"`
	Scope    string `json:"scope,omitempty"`
	IAT      int64  `json:"iat"`
	Exp      int64  `json:"exp"`
}

// SelfSignedAuthenticator validates self-signed HMAC-SHA256 tokens.
type SelfSignedAuthenticator struct {
	secret   []byte
	audience string // when non-empty, aud must match exactly
	issuer   string // when non-empty, iss must match exactly

	// Verified principals are cached by token hash until the token's exp —
	// the per-request unmarshal + claims-map build dominated request allocs
	// under MCP load. Tokens are bearer secrets, so the map key is a SHA-256
	// digest, not the raw token.
	mu    sync.Mutex
	cache map[[32]byte]cachedPrincipal
}

// cachedPrincipal is a verified principal plus the token expiry it was
// verified under. Principals are treated as read-only downstream.
type cachedPrincipal struct {
	principal *Principal
	exp       int64
}

const principalCacheCap = 4096

// NewSelfSignedAuthenticator creates an authenticator for self-signed tokens.
func NewSelfSignedAuthenticator(secret []byte) *SelfSignedAuthenticator {
	return &SelfSignedAuthenticator{secret: secret, cache: map[[32]byte]cachedPrincipal{}}
}

// NewSelfSignedAuthenticatorForAudience requires an exact aud match. An empty
// aud (a legacy token) is rejected, which is what stops console tokens being
// replayed against MCP during the 24h migration window. audience is
// mandatory: an empty value would silently disable the check, so
// construction fails loudly instead. issuer is optional — pass "" to skip
// the iss check.
func NewSelfSignedAuthenticatorForAudience(secret []byte, audience, issuer string) (*SelfSignedAuthenticator, error) {
	if audience == "" {
		return nil, errors.New("self-signed authenticator: audience is required")
	}
	return &SelfSignedAuthenticator{secret: secret, audience: audience, issuer: issuer, cache: map[[32]byte]cachedPrincipal{}}, nil
}

// Authenticate validates a Bearer token signed with the server's secret.
func (s *SelfSignedAuthenticator) Authenticate(ctx context.Context) (*Principal, error) {
	req, err := requestFromContext(ctx)
	if err != nil {
		return nil, errors.Join(err, ErrUnauthenticated)
	}

	rawToken, err := bearerToken(req)
	if err != nil {
		return nil, err
	}
	key := sha256.Sum256([]byte(rawToken))
	if p := s.cachedPrincipal(key); p != nil {
		return p, nil
	}

	claims, err := verifySelfSigned(rawToken, s.secret)
	if err != nil {
		return nil, errors.Join(err, ErrUnauthenticated)
	}

	if s.audience != "" && claims.Audience != s.audience {
		return nil, fmt.Errorf("%w: audience mismatch", ErrUnauthenticated)
	}

	if s.issuer != "" && claims.Issuer != s.issuer {
		return nil, fmt.Errorf("%w: issuer mismatch", ErrUnauthenticated)
	}

	p := principalFromClaims(claims)
	s.storePrincipal(key, p, claims.Exp)
	return p, nil
}

// principalFromClaims materializes the immutable Principal cached on a
// verified token.
func principalFromClaims(claims *selfSignedClaims) *Principal {
	return &Principal{
		Subject: claims.Subject,
		Email:   claims.Email,
		Name:    claims.Name,
		Groups:  []string{"users"},
		Scopes:  strings.Fields(claims.Scope),
		Claims: map[string]interface{}{
			"sub":    claims.Subject,
			"email":  claims.Email,
			"name":   claims.Name,
			"method": "self-signed",
		},
	}
}

// bearerToken extracts the token from a Bearer Authorization header.
func bearerToken(req HTTPRequest) (string, error) {
	auth := req.Header().Get("Authorization")
	if auth == "" {
		return "", ErrUnauthenticated
	}
	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return "", fmt.Errorf("invalid authorization header: %w", ErrUnauthenticated)
	}
	return parts[1], nil
}

// cachedPrincipal returns a verified principal for a previously-seen token
// or nil when the entry is absent or past the token's own expiry.
func (s *SelfSignedAuthenticator) cachedPrincipal(key [32]byte) *Principal {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.cache[key]
	if !ok || entry.exp <= time.Now().Unix() {
		return nil
	}
	return entry.principal
}

// storePrincipal caches a verified principal under the token hash. When the
// cache is full it drops expired entries first, then oldest-observed.
func (s *SelfSignedAuthenticator) storePrincipal(key [32]byte, p *Principal, exp int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.cache) >= principalCacheCap {
		now := time.Now().Unix()
		for k, v := range s.cache {
			if v.exp <= now {
				delete(s.cache, k)
			}
		}
		if len(s.cache) >= principalCacheCap {
			// Still full after expiry sweep — drop an arbitrary entry.
			for k := range s.cache {
				delete(s.cache, k)
				break
			}
		}
	}
	s.cache[key] = cachedPrincipal{principal: p, exp: exp}
}

// issueLegacyAudlessToken mints a self-signed token with no "aud" claim —
// the exact shape every production minter used before the console-audience
// bypass fix (see ConsoleAPIAudience), and the shape NO authenticator in
// this codebase accepts anymore except the unaudienced NewSelfSignedAuthenticator.
// It is kept, unexported and test-only, purely to prove that migration
// boundary: TestLegacyAudlessTokenRejectedByAudienceAuthenticator and
// TestLegacyAudlessTokenStillAcceptedByExistingAuthenticator both depend on
// minting exactly this shape. It was previously exported as IssueToken and
// used in production by basic_login_handler.go and by mcp test helpers;
// both were migrated to IssueTokenWithOptions with an explicit Audience, so
// this is no longer reachable from any non-test code path. Do not reuse it
// for anything that authenticates against a real authenticator — mint via
// IssueTokenWithOptions instead.
func issueLegacyAudlessToken(subject, email, name string, secret []byte) (string, error) {
	now := time.Now()
	return encodeClaims(selfSignedClaims{
		Subject: subject,
		Email:   email,
		Name:    name,
		IAT:     now.Unix(),
		Exp:     now.Add(tokenExpiry).Unix(),
	}, secret)
}

// TokenOptions configures a self-signed token minted via IssueTokenWithOptions.
type TokenOptions struct {
	Subject, Email, Name string
	Audience             string
	Issuer               string
	Scope                string
	TTL                  time.Duration
	Secret               []byte
}

// IssueTokenWithOptions mints an audience-bound, scoped token.
func IssueTokenWithOptions(opts TokenOptions) (string, error) { //nolint:gocritic // TokenOptions is passed by value to keep the call site simple.
	ttl := opts.TTL
	if ttl == 0 {
		ttl = tokenExpiry
	}
	now := time.Now()
	return encodeClaims(selfSignedClaims{
		Subject:  opts.Subject,
		Email:    opts.Email,
		Name:     opts.Name,
		Issuer:   opts.Issuer,
		Audience: opts.Audience,
		Scope:    opts.Scope,
		IAT:      now.Unix(),
		Exp:      now.Add(ttl).Unix(),
	}, opts.Secret)
}

// encodeClaims serializes claims and signs them, producing the single
// signing path shared by IssueToken and IssueTokenWithOptions.
func encodeClaims(claims selfSignedClaims, secret []byte) (string, error) { //nolint:gocritic // claims is a small internal struct passed by value for clarity.
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("marshal claims: %w", err)
	}

	payloadEnc := base64.RawURLEncoding.EncodeToString(payload)
	signingInput := jwtHeader + "." + payloadEnc
	sig := signHMAC([]byte(signingInput), secret)
	sigEnc := base64.RawURLEncoding.EncodeToString(sig)

	return signingInput + "." + sigEnc, nil
}

func verifySelfSigned(rawToken string, secret []byte) (*selfSignedClaims, error) {
	segments := strings.Split(rawToken, ".")
	if len(segments) != 3 {
		return nil, errors.New("invalid token format")
	}

	// Verify signature.
	signingInput := segments[0] + "." + segments[1]
	expectedSig := signHMAC([]byte(signingInput), secret)
	gotSig, err := base64.RawURLEncoding.DecodeString(segments[2])
	if err != nil {
		return nil, fmt.Errorf("decode signature: %w", err)
	}

	if !hmac.Equal(expectedSig, gotSig) {
		return nil, errors.New("invalid token signature")
	}

	// Parse payload.
	payload, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}

	var claims selfSignedClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("parse claims: %w", err)
	}

	// Check expiry.
	if time.Now().Unix() > claims.Exp {
		return nil, errors.New("token expired")
	}

	return &claims, nil
}

func signHMAC(data, secret []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write(data)
	return mac.Sum(nil)
}
