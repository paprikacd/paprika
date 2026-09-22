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
}

// NewSelfSignedAuthenticator creates an authenticator for self-signed tokens.
func NewSelfSignedAuthenticator(secret []byte) *SelfSignedAuthenticator {
	return &SelfSignedAuthenticator{secret: secret}
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
	return &SelfSignedAuthenticator{secret: secret, audience: audience, issuer: issuer}, nil
}

// Authenticate validates a Bearer token signed with the server's secret.
func (s *SelfSignedAuthenticator) Authenticate(ctx context.Context) (*Principal, error) {
	req, err := requestFromContext(ctx)
	if err != nil {
		return nil, errors.Join(err, ErrUnauthenticated)
	}

	auth := req.Header().Get("Authorization")
	if auth == "" {
		return nil, ErrUnauthenticated
	}

	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return nil, fmt.Errorf("invalid authorization header: %w", ErrUnauthenticated)
	}

	rawToken := parts[1]
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
	}, nil
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
