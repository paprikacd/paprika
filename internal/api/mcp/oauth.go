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

	// minCodeVerifierLength and maxCodeVerifierLength are RFC 7636 section
	// 4.1's fixed bounds on a PKCE code_verifier's length.
	minCodeVerifierLength = 43
	maxCodeVerifierLength = 128
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

	scope, ok := negotiateScope(principal, q.Get("scope"))
	if !ok {
		writeOAuthError(w, http.StatusBadRequest, "invalid_scope",
			"requested scope exceeds the scope granted to this principal")
		return
	}
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
// server. NewServer requires ServerConfig.ClientID to be non-empty, so
// s.clientID is always configured here — an empty or mismatched clientID
// is always rejected; there is no "unconfigured, skip the check" case.
func (s *Server) clientIDAllowed(clientID string) bool {
	return clientID != "" && clientID == s.clientID
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

// negotiateScope computes the scope an authorization code — and the access
// token it is eventually exchanged for — is granted, from what the client
// requested and what principal is actually entitled to. The granted scope
// is NEVER a superset of principal.Scopes:
//
//   - requested is empty: RFC 6749 section 3.3 leaves the default up to the
//     authorization server when scope is omitted; this server defaults to
//     exactly principal's own scopes, never to every scope it supports. A
//     principal carrying no scopes at all is granted none.
//   - requested names a scope principal does not hold: the WHOLE request is
//     rejected (ok=false), not silently downgraded to the scopes principal
//     does hold — see RFC 6749 section 5.2's invalid_scope condition
//     ("requested scope ... exceeds the scope granted by the resource
//     owner") and task-14-report.md's "Fix round 1" section for why this
//     policy was chosen over a silent intersection.
//   - requested names only scopes principal holds: exactly those are
//     granted, narrowed from whatever principal could have asked for.
func negotiateScope(principal *auth.Principal, requested string) (string, bool) {
	granted := ParseScopes(strings.Join(principal.Scopes, " "))

	if strings.TrimSpace(requested) == "" {
		return scopesToString(granted), true
	}

	requestedScopes := ParseScopes(requested)
	for _, rs := range requestedScopes {
		if !HasScope(granted, rs) {
			return "", false
		}
	}
	return scopesToString(requestedScopes), true
}

func scopesToString(scopes []Scope) string {
	out := make([]string, len(scopes))
	for i, sc := range scopes {
		out[i] = string(sc)
	}
	return strings.Join(out, " ")
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

	// RFC 6749 section 5.1 MUST: every token endpoint response — success or
	// error — must tell caches never to store it, since it carries or
	// relates to credentials.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")

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
	// RFC 7636 section 4.1: code_verifier is a 43-128 character string.
	// Rejecting anything outside that range here, before it is ever hashed
	// and compared, keeps pkceMatches operating only on well-formed input.
	if len(verifier) < minCodeVerifierLength || len(verifier) > maxCodeVerifierLength {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "code_verifier must be 43-128 characters")
		return
	}

	rec, err := s.consumeAuthCode(r.Context(), code)
	if err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "unknown or expired code")
		return
	}

	// RFC 6749 section 4.1.3 requires the token endpoint to verify the code
	// was issued to the client presenting it here — PKCE and exact
	// redirect_uri matching mitigate but do not replace this binding (a
	// code issued to one client_id must not redeem as a different one).
	if r.PostFormValue("client_id") != rec.ClientID {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "code was not issued to this client")
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

// consumeAuthCode atomically looks up and deletes code in a single cache
// operation (GetDel), so of any two callers racing the same code — a
// genuine concurrent replay attempt, not merely "delete happens after
// lookup" — exactly one observes it present; every other caller, concurrent
// or later, sees it already gone. See TestConcurrentAuthCodeRedemptionOnlyOneSucceeds.
func (s *Server) consumeAuthCode(ctx context.Context, code string) (authCodeRecord, error) {
	var rec authCodeRecord
	payload, err := s.cache.GetDel(ctx, authCodeKey(code))
	if err != nil {
		return rec, fmt.Errorf("mcp: consume auth code: %w", err)
	}
	if len(payload) == 0 {
		return rec, errors.New("mcp: unknown or expired auth code")
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

// consumeRefreshToken atomically looks up and deletes token in a single
// cache operation (GetDel) — the rotation and predecessor-revocation this
// file's contract requires, made race-free: of any two callers racing the
// same refresh token, exactly one observes it present and gets a live
// successor chain; the other sees it already gone. A Get-then-Delete here
// previously let concurrent callers both read the value before either
// deleted it, so both could mint a live successor from the same
// predecessor — see TestConcurrentRefreshTokenRedemptionOnlyOneSucceeds.
//
// Stranding risk: if issueTokenPair fails AFTER this call deletes token
// (e.g. the subsequent cache.Set for the new refresh record fails), the
// caller is left with no valid refresh token and must fully re-authorize.
// This is accepted, not mitigated: deferring the delete until the new
// token is safely stored would reopen the exact non-atomic race this
// function exists to close, and re-authorization is a bounded, visible
// failure mode rather than a silent double-spend.
func (s *Server) consumeRefreshToken(ctx context.Context, token string) (refreshRecord, error) {
	var rec refreshRecord
	payload, err := s.cache.GetDel(ctx, refreshKey(token))
	if err != nil {
		return rec, fmt.Errorf("mcp: consume refresh token: %w", err)
	}
	if len(payload) == 0 {
		return rec, errors.New("mcp: unknown or expired refresh token")
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
