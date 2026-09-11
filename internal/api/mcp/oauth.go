package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/benebsworth/paprika/internal/api/auth"
)

// Default token lifetimes, used whenever ServerConfig.AccessTTL /
// ServerConfig.RefreshTTL is left zero. These match the design spec's
// defaults for --mcp-access-token-ttl and --mcp-refresh-token-ttl.
const (
	defaultAccessTTL  = 24 * time.Hour
	defaultRefreshTTL = 30 * 24 * time.Hour

	// authCodeTTL is deliberately short: an authorization code is meant to
	// be exchanged within the same browser round trip, not held onto.
	authCodeTTL = 5 * time.Minute
)

// defaultDuration returns d if it is non-zero, else fallback. It centralises
// the "config left this TTL unset" rule so NewServer's defaulting for
// AccessTTL/RefreshTTL has one implementation.
func defaultDuration(d, fallback time.Duration) time.Duration {
	if d == 0 {
		return fallback
	}
	return d
}

// mcpTokenAudience is the audience every token this file mints carries. It
// is what stops an MCP access token being replayed against the console API
// (which requires a distinct audience) and vice versa — see
// TestIssuedAccessTokenCarriesMCPAudience.
const mcpTokenAudience = "paprika-mcp"

// oauthScopesSupported is the fixed set of scopes this authorization server
// grants. It is deliberately the same two values Scope declares — nothing
// else exists to request.
var oauthScopesSupported = []string{string(ScopeRead), string(ScopeWrite)}

// RegisterOAuthRoutes wires the MCP OAuth 2.1 authorization surface —
// protected-resource metadata (RFC 9728), authorization-server metadata
// (RFC 8414), the authorization endpoint, and the token endpoint — onto mux.
//
// Identity for the authorization endpoint is derived by reusing this same
// Server's own Authenticator (the SelfSignedAuthenticator validating
// Paprika's HS256 bearer tokens). Those tokens only exist once a human has
// already completed Paprika's existing Google OIDC login (GET /auth/login,
// POST /auth/token — internal/api/auth), so authenticating here is exactly
// "reusing the existing Google OIDC login for identity" without this
// package reaching into the OIDC package directly or duplicating its
// client-secret handling.
func (s *Server) RegisterOAuthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/.well-known/oauth-protected-resource", s.handleProtectedResourceMetadata)
	mux.HandleFunc("/.well-known/oauth-authorization-server", s.handleAuthorizationServerMetadata)
	mux.HandleFunc("/mcp/authorize", s.handleAuthorize)
	mux.HandleFunc("/mcp/token", s.handleToken)
}

// protectedResourceMetadata is the RFC 9728 document a client fetches after
// receiving this server's 401 WWW-Authenticate challenge (writeUnauthenticated).
//
//nolint:tagliatelle // RFC 9728 mandates these exact snake_case field names.
type protectedResourceMetadata struct {
	Resource             string   `json:"resource"`
	AuthorizationServers []string `json:"authorization_servers"`
	ScopesSupported      []string `json:"scopes_supported"`
}

func (s *Server) handleProtectedResourceMetadata(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, protectedResourceMetadata{
		Resource:             s.publicURL + "/mcp",
		AuthorizationServers: []string{s.publicURL},
		ScopesSupported:      oauthScopesSupported,
	})
}

// authorizationServerMetadata is the RFC 8414 document naming Paprika as its
// own authorization server — see the design spec's "Paprika is already an
// authorization server" note.
//
//nolint:tagliatelle // RFC 8414 mandates these exact snake_case field names.
type authorizationServerMetadata struct {
	Issuer                        string   `json:"issuer"`
	AuthorizationEndpoint         string   `json:"authorization_endpoint"`
	TokenEndpoint                 string   `json:"token_endpoint"`
	ResponseTypesSupported        []string `json:"response_types_supported"`
	GrantTypesSupported           []string `json:"grant_types_supported"`
	CodeChallengeMethodsSupported []string `json:"code_challenge_methods_supported"`
	TokenEndpointAuthMethods      []string `json:"token_endpoint_auth_methods_supported"`
	ScopesSupported               []string `json:"scopes_supported"`
}

func (s *Server) handleAuthorizationServerMetadata(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, authorizationServerMetadata{
		Issuer:                        s.publicURL,
		AuthorizationEndpoint:         s.publicURL + "/mcp/authorize",
		TokenEndpoint:                 s.publicURL + "/mcp/token",
		ResponseTypesSupported:        []string{"code"},
		GrantTypesSupported:           []string{"authorization_code", "refresh_token"},
		CodeChallengeMethodsSupported: []string{"S256"},
		TokenEndpointAuthMethods:      []string{"none"},
		ScopesSupported:               oauthScopesSupported,
	})
}

// authCodeRecord is what an authorization code resolves to in the cache,
// under authCodeKey. It carries everything the token endpoint needs to
// finish an authorization_code exchange without re-deriving it: the
// principal identity, the granted scope, and the exact redirect_uri and PKCE
// challenge the code was issued against, both of which RFC 6749/7636 require
// the token endpoint to re-verify rather than trust the client's second
// request blindly.
//
//nolint:tagliatelle // internal cache-only serialization; snake_case matches the OAuth field names it mirrors.
type authCodeRecord struct {
	Subject       string `json:"sub"`
	Email         string `json:"email"`
	Name          string `json:"name"`
	Scope         string `json:"scope"`
	RedirectURI   string `json:"redirect_uri"`
	CodeChallenge string `json:"code_challenge"`
	ClientID      string `json:"client_id"`
}

// handleAuthorize implements the authorization_code + PKCE authorization
// endpoint. redirect_uri is checked against the exact-match allowlist BEFORE
// anything else — including before authentication — so that an attacker
// supplying an unregistered redirect_uri never reaches a code path that
// could send them anywhere, and never learns anything from a differently
// shaped failure (see TestAuthorizeRejectsUnregisteredRedirectURI).
func (s *Server) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	q := r.URL.Query()
	redirectURI, codeChallenge, ok := s.validateAuthorizeRequest(w, q)
	if !ok {
		return
	}

	ctx := auth.WithRequest(r.Context(), r)
	principal, err := s.authenticator.Authenticate(ctx)
	if err != nil {
		s.writeUnauthenticated(w)
		return
	}

	scope := strings.Join(scopesToStrings(negotiateScopes(q.Get("scope"))), " ")
	code, err := s.issueAuthCode(ctx, &authCodeRecord{
		Subject:       principal.Subject,
		Email:         principal.Email,
		Name:          principal.Name,
		Scope:         scope,
		RedirectURI:   redirectURI,
		CodeChallenge: codeChallenge,
		ClientID:      q.Get("client_id"),
	})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// redirectURI has already been validated as an exact match against the
	// registered allowlist, so it is safe to redirect to; url.Parse on an
	// already-registered value is not attacker-controlled parsing.
	dest, err := url.Parse(redirectURI)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	values := dest.Query()
	values.Set("code", code)
	if state := q.Get("state"); state != "" {
		values.Set("state", state)
	}
	dest.RawQuery = values.Encode()
	//nolint:gosec // dest was built from redirectURI, which validateAuthorizeRequest already
	// checked for exact byte-equality against the registered allowlist above; it is never
	// attacker-controlled at this point.
	http.Redirect(w, r, dest.String(), http.StatusFound)
}

// validateAuthorizeRequest checks the fixed, pre-authentication preconditions
// of an authorize request — response_type, client_id, redirect_uri, and PKCE
// parameters — writing the appropriate OAuth error itself and returning
// ok=false on the first failure. Splitting this out of handleAuthorize keeps
// each function's branching independently readable and testable.
//
// redirect_uri is validated here, before authentication runs, so that an
// attacker supplying an unregistered redirect_uri never reaches a code path
// that could send them anywhere, and never learns anything from a
// differently shaped failure (see TestAuthorizeRejectsUnregisteredRedirectURI).
func (s *Server) validateAuthorizeRequest(w http.ResponseWriter, q url.Values) (redirectURI, codeChallenge string, ok bool) {
	if q.Get("response_type") != "code" {
		writeOAuthError(w, http.StatusBadRequest, "unsupported_response_type", "only response_type=code is supported")
		return "", "", false
	}
	if !s.clientIDAllowed(q.Get("client_id")) {
		writeOAuthError(w, http.StatusBadRequest, "unauthorized_client", "unknown client_id")
		return "", "", false
	}

	redirectURI = q.Get("redirect_uri")
	if !s.isRegisteredRedirect(redirectURI) {
		// Deliberately generic: never echo the caller-supplied redirect_uri
		// back into the response body or a header. A Location header is
		// never set on this path at all.
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "redirect_uri is not registered for this client")
		return "", "", false
	}

	codeChallenge = q.Get("code_challenge")
	if codeChallenge == "" || q.Get("code_challenge_method") != "S256" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "code_challenge with method S256 is required")
		return "", "", false
	}

	return redirectURI, codeChallenge, true
}

// clientIDAllowed reports whether clientID may use this authorization
// server. An unconfigured s.clientID (the zero value) means no static
// client has been registered, in which case the check is skipped rather
// than rejecting every request — matching how s.redirectURIs behaves when
// empty, and how the test fixtures that do not configure a client (e.g.
// newTestServer) still exercise the token endpoint.
func (s *Server) clientIDAllowed(clientID string) bool {
	if s.clientID == "" {
		return true
	}
	return clientID == s.clientID
}

// isRegisteredRedirect reports whether candidate is EXACTLY one of the
// server's registered redirect URIs. This is a plain string comparison,
// deliberately: no URL parsing, normalization, or canonicalization runs
// first, because any of those could be tricked into treating a
// traversal (".../..") or suffix-confusion
// ("https://claude.ai.evil.example/...") variant as equivalent to a
// registered URI. A byte-for-byte match is the only comparison that cannot
// be fooled by such a variant, which is exactly what
// TestAuthorizeRejectsUnregisteredRedirectURI exercises.
func (s *Server) isRegisteredRedirect(candidate string) bool {
	if candidate == "" {
		return false
	}
	for _, registered := range s.redirectURIs {
		if candidate == registered {
			return true
		}
	}
	return false
}

// negotiateScopes parses a requested scope string and falls back to every
// scope this server supports when the client did not request one — RFC 6749
// section 3.3 leaves the default up to the authorization server when scope
// is omitted.
func negotiateScopes(requested string) []Scope {
	if scopes := ParseScopes(requested); len(scopes) > 0 {
		return scopes
	}
	return []Scope{ScopeRead, ScopeWrite}
}

func scopesToStrings(scopes []Scope) []string {
	out := make([]string, len(scopes))
	for i, sc := range scopes {
		out[i] = string(sc)
	}
	return out
}

// issueAuthCode mints a random authorization code and stores rec against it
// for authCodeTTL, single-use (handleAuthorizationCodeGrant deletes it on
// first exchange).
func (s *Server) issueAuthCode(ctx context.Context, rec *authCodeRecord) (string, error) {
	code, err := randomToken()
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(rec)
	if err != nil {
		return "", fmt.Errorf("mcp: marshal auth code record: %w", err)
	}
	if err := s.cache.Set(ctx, authCodeKey(code), payload, authCodeTTL); err != nil {
		return "", fmt.Errorf("mcp: store auth code: %w", err)
	}
	return code, nil
}

func authCodeKey(code string) string {
	return "mcp:code:" + code
}

// refreshRecord is what a refresh token resolves to in the cache, under
// refreshKey. Deliberately minimal — just enough to re-mint an access token
// — matching what the brief's seedRefreshToken test helper writes directly.
type refreshRecord struct {
	Subject string `json:"sub"`
	Scope   string `json:"scope"`
}

func refreshKey(token string) string {
	return "mcp:refresh:" + token
}

// tokenResponse is the RFC 6749 section 5.1 access token response this
// package returns from every successful /mcp/token grant.
//
//nolint:tagliatelle // RFC 6749 mandates these exact snake_case field names.
type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope,omitempty"`
}

// handleToken implements the token endpoint, dispatching on grant_type.
// Only authorization_code and refresh_token are supported — notably NOT
// password, which RFC 6749 section 4.3 deprecates and which this server
// must never accept: see TestTokenEndpointRejectsUnsupportedGrant.
func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseForm(); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "malformed form body")
		return
	}

	if !s.clientIDAllowed(r.PostFormValue("client_id")) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client", "unknown client_id")
		return
	}

	switch r.PostFormValue("grant_type") {
	case "authorization_code":
		s.handleAuthorizationCodeGrant(w, r)
	case "refresh_token":
		s.handleRefreshTokenGrant(w, r)
	default:
		writeOAuthError(w, http.StatusBadRequest, "unsupported_grant_type",
			"only authorization_code and refresh_token are supported")
	}
}

// handleAuthorizationCodeGrant exchanges a code minted by handleAuthorize
// for an access token + refresh token. The code is deleted on first lookup
// — single-use regardless of what happens afterward — and both the
// redirect_uri (RFC 6749 section 4.1.3) and the PKCE code_verifier (RFC 7636
// section 4.6) are re-verified against what handleAuthorize recorded, not
// merely accepted from this second request.
func (s *Server) handleAuthorizationCodeGrant(w http.ResponseWriter, r *http.Request) {
	code := r.PostFormValue("code")
	verifier := r.PostFormValue("code_verifier")
	if code == "" || verifier == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "code and code_verifier are required")
		return
	}

	rec, err := s.consumeAuthCode(r.Context(), code)
	if err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "unknown or expired code")
		return
	}

	if r.PostFormValue("redirect_uri") != rec.RedirectURI {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "redirect_uri does not match the authorization request")
		return
	}
	if !pkceMatches(verifier, rec.CodeChallenge) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "code_verifier does not match")
		return
	}

	s.issueTokenPair(r.Context(), w, rec.Subject, rec.Email, rec.Name, rec.Scope)
}

// consumeAuthCode looks up code and deletes it, so it cannot be exchanged
// twice regardless of what the caller does with the returned record.
func (s *Server) consumeAuthCode(ctx context.Context, code string) (authCodeRecord, error) {
	var rec authCodeRecord
	payload, err := s.cache.Get(ctx, authCodeKey(code))
	if err != nil {
		return rec, fmt.Errorf("mcp: look up auth code: %w", err)
	}
	if len(payload) == 0 {
		return rec, errors.New("mcp: unknown or expired auth code")
	}
	if err := s.cache.Delete(ctx, authCodeKey(code)); err != nil {
		return rec, fmt.Errorf("mcp: retire auth code: %w", err)
	}
	if err := json.Unmarshal(payload, &rec); err != nil {
		return rec, fmt.Errorf("mcp: unmarshal auth code record: %w", err)
	}
	return rec, nil
}

// pkceMatches reports whether verifier hashes (S256, RFC 7636 section 4.2)
// to challenge, compared in constant time.
func pkceMatches(verifier, challenge string) bool {
	sum := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(computed), []byte(challenge)) == 1
}

// handleRefreshTokenGrant implements refresh-token rotation: the presented
// token is deleted on lookup — burning it before anything else runs, so a
// replay of the same token can never succeed even if a later step in this
// same request were to fail — and a freshly generated refresh token is
// stored in its place. See TestRefreshTokenRotatesAndRevokesPredecessor.
func (s *Server) handleRefreshTokenGrant(w http.ResponseWriter, r *http.Request) {
	presented := r.PostFormValue("refresh_token")
	if presented == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "refresh_token is required")
		return
	}

	rec, err := s.consumeRefreshToken(r.Context(), presented)
	if err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "unknown or expired refresh_token")
		return
	}

	s.issueTokenPair(r.Context(), w, rec.Subject, "", "", rec.Scope)
}

// consumeRefreshToken looks up token and deletes it — the rotation and
// predecessor-revocation this file's contract requires — before returning
// the record it held.
func (s *Server) consumeRefreshToken(ctx context.Context, token string) (refreshRecord, error) {
	var rec refreshRecord
	payload, err := s.cache.Get(ctx, refreshKey(token))
	if err != nil {
		return rec, fmt.Errorf("mcp: look up refresh token: %w", err)
	}
	if len(payload) == 0 {
		return rec, errors.New("mcp: unknown or expired refresh token")
	}
	if err := s.cache.Delete(ctx, refreshKey(token)); err != nil {
		return rec, fmt.Errorf("mcp: revoke refresh token: %w", err)
	}
	if err := json.Unmarshal(payload, &rec); err != nil {
		return rec, fmt.Errorf("mcp: unmarshal refresh record: %w", err)
	}
	return rec, nil
}

// issueTokenPair mints an access token bound to mcpTokenAudience plus a
// fresh rotating refresh token, stores the refresh record, and writes the
// RFC 6749 section 5.1 JSON response. It is the single place both grant
// types converge, so every successful /mcp/token response is built the same
// way.
func (s *Server) issueTokenPair(ctx context.Context, w http.ResponseWriter, subject, email, name, scope string) {
	access, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject:  subject,
		Email:    email,
		Name:     name,
		Audience: mcpTokenAudience,
		Issuer:   s.publicURL,
		Scope:    scope,
		TTL:      s.accessTTL,
		Secret:   s.secret,
	})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	refresh, err := randomToken()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	payload, err := json.Marshal(refreshRecord{Subject: subject, Scope: scope})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := s.cache.Set(ctx, refreshKey(refresh), payload, s.refreshTTL); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, tokenResponse{
		AccessToken:  access,
		RefreshToken: refresh,
		TokenType:    "Bearer",
		ExpiresIn:    int(s.accessTTL.Seconds()),
		Scope:        scope,
	})
}

// randomToken returns a cryptographically random, URL-safe opaque token —
// used for both authorization codes and refresh tokens. Matches the
// pattern already established by Confirmer.Issue (confirm.go): 32 bytes
// from crypto/rand, base64.RawURLEncoding.
func randomToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("mcp: generate token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// oauthError is the RFC 6749 section 5.2 error response shape.
//
//nolint:tagliatelle // RFC 6749 mandates these exact snake_case field names.
type oauthError struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description,omitempty"`
}

func writeOAuthError(w http.ResponseWriter, status int, code, description string) {
	writeJSON(w, status, oauthError{Error: code, ErrorDescription: description})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v) //nolint:errcheck // best-effort: the status/headers are already written
}
