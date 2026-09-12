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

// MCPTokenAudience is the audience every token this file mints carries. It
// is what stops an MCP access token being replayed against the console API
// (which requires a distinct audience) and vice versa — see
// TestIssuedAccessTokenCarriesMCPAudience. Exported so Task 15's
// buildMCPHandlers (cmd/main.go) can build the MCP server's Authenticator
// against the exact same audience this package mints tokens for, without
// duplicating the literal string across packages.
const MCPTokenAudience = "paprika-mcp"

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
	mux.HandleFunc("/mcp/authorize/consent", s.handleAuthorizeConsent)
	mux.HandleFunc("/mcp/token", s.handleToken)
}

// consentPath is where a browser lacking a console credential is redirected
// from GET /mcp/authorize, and where the design's SPA (not this package's
// responsibility) collects explicit user consent before POSTing to
// /mcp/authorize/consent.
const consentPath = "/mcp/consent"

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
// endpoint. Authentication runs FIRST, before any request validation
// (response_type, client_id, redirect_uri, PKCE): every unauthenticated
// caller gets an identical failure regardless of what else is wrong or right
// about the request, so an unauthenticated probe can never distinguish a
// registered redirect_uri from an unregistered one, or a valid client_id
// from an invalid one, by status code, body, or headers (see
// TestAuthorizeUnauthenticatedRequestsAreIndistinguishable). No Location
// header pointing at redirect_uri is ever set before authentication
// succeeds.
//
// Authentication here uses s.authorizeAuthenticator — the CONSOLE user
// authenticator stack (Google OIDC + Paprika self-signed tokens), not
// s.authenticator (the MCP-audience-only authenticator /mcp itself uses).
// Requiring an MCP access token here would be circular: the only thing that
// mints one is /mcp/token, which itself needs a code from this endpoint.
//
// On authentication failure, a caller that looks like a browser (an Accept
// header containing "text/html") is redirected to consentPath instead of
// getting a 401, so a human with no console session yet can complete login
// and consent there — see redirectToConsent for the validation this
// performs before choosing what to forward. A non-browser (JSON/API) caller
// keeps getting exactly the pre-existing 401.
//
// A caller that DOES authenticate but still looks like a browser is ALSO
// sent to consentPath rather than getting a code minted directly here (Fix
// round 1, Finding 2): explicit human consent is required for every
// browser-driven authorization, not only the unauthenticated case. Skipping
// straight to negotiateScope for an authenticated browser would let any
// caller that manages to authenticate — today, only a console
// principal, which never carries Scopes and so this path is harmless in
// practice, but the bypass itself must not exist — mint a code with no
// consent screen ever shown. Only a non-browser (JSON/API) authenticated
// caller keeps the pre-existing direct-grant behaviour below.
//
// Only once a caller is authenticated AND does not look like a browser does
// validateAuthorizeRequest run, and only then can a 400 distinguish an
// unregistered redirect_uri, a bad response_type, or missing PKCE
// parameters from one another — see its doc comment for why client_id and
// redirect_uri are still collapsed into one response at that stage.
func (s *Server) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ctx := auth.WithRequest(r.Context(), r)
	principal, err := s.authorizeAuthenticator.Authenticate(ctx)
	if err != nil {
		if looksLikeBrowser(r) {
			s.redirectToConsent(w, r)
			return
		}
		s.writeUnauthenticated(w)
		return
	}

	if looksLikeBrowser(r) {
		s.redirectToConsent(w, r)
		return
	}

	q := r.URL.Query()
	redirectURI, codeChallenge, ok := s.validateAuthorizeRequest(w, q)
	if !ok {
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

	dest, err := buildRedirectWithCode(redirectURI, code, q.Get("state"))
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	//nolint:gosec // dest was built from redirectURI, which validateAuthorizeRequest already
	// checked for exact byte-equality against the registered allowlist above; it is never
	// attacker-controlled at this point.
	http.Redirect(w, r, dest, http.StatusFound)
}

// buildRedirectWithCode appends code and, if non-empty, state to
// redirectURI's query string, returning the resulting URL as a string.
// Shared by handleAuthorize and handleAuthorizeConsent — both mint a code
// against an already-validated, exact-match-registered redirectURI and need
// to build the identical final redirect target from it.
func buildRedirectWithCode(redirectURI, code, state string) (string, error) {
	return buildRedirectWithParam(redirectURI, "code", code, state)
}

// buildRedirectWithError appends an OAuth error code (e.g. "access_denied")
// and, if non-empty, state to redirectURI's query string. Used by
// handleAuthorizeConsent's deny path (Fix round 1, Finding 1a) so a denial
// is always sent to a URL this server itself validated and built — never
// one constructed in client-side script from unvalidated input.
func buildRedirectWithError(redirectURI, errorCode, state string) (string, error) {
	return buildRedirectWithParam(redirectURI, "error", errorCode, state)
}

// buildRedirectWithParam is the shared implementation behind
// buildRedirectWithCode and buildRedirectWithError: it parses redirectURI,
// sets a single named query parameter plus, if non-empty, state, and
// returns the resulting URL as a string.
func buildRedirectWithParam(redirectURI, key, value, state string) (string, error) {
	dest, err := url.Parse(redirectURI)
	if err != nil {
		return "", fmt.Errorf("mcp: parse redirect_uri: %w", err)
	}
	values := dest.Query()
	values.Set(key, value)
	if state != "" {
		values.Set("state", state)
	}
	dest.RawQuery = values.Encode()
	return dest.String(), nil
}

// looksLikeBrowser reports whether r's Accept header indicates an
// interactive browser navigation rather than a JSON/API caller — the same
// signal a normal top-level GET navigation sends by default. It is
// deliberately a narrow, explicit check (Accept containing "text/html")
// rather than "absence of a bearer token" or similar: a JSON caller with no
// credential must keep getting exactly the pre-existing 401 (see
// TestAuthorizeUnauthenticatedRequestsAreIndistinguishable and
// TestAuthorizeJSONGETUnauthenticatedStillReturns401), and only a caller
// that positively looks like a browser is redirected instead.
func looksLikeBrowser(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

// redirectToConsent sends a browser-like GET /mcp/authorize to consentPath —
// whether or not the caller is authenticated (Fix round 1, Finding 2 also
// routes an authenticated browser here). It validates client_id and
// redirect_uri registration FIRST (Fix round 1, Finding 1b): a valid pair
// gets the original request's raw query string forwarded byte-for-byte, an
// invalid pair gets ONLY "?error=invalid_request" forwarded, dropping every
// other caller-supplied parameter (including the unregistered redirect_uri
// itself, which must never be echoed anywhere in the response).
//
// Both outcomes are still a 302 to this exact same fixed path, which is
// what keeps this closed as an oracle despite now validating first: a
// third-party page driving this as a top-level browser navigation can
// neither read the Location header nor observe the resulting cross-origin
// URL, and a cross-origin fetch of this endpoint gets an opaque response —
// so the differing query shape between the two outcomes is not observable
// to an attacker, unlike a directly-inspectable JSON response would be. See
// TestAuthorizeBrowserGETWithNoCredentialRedirectsToConsent.
func (s *Server) redirectToConsent(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	dest := consentPath
	if s.clientIDAllowed(q.Get("client_id")) && s.isRegisteredRedirect(q.Get("redirect_uri")) {
		if r.URL.RawQuery != "" {
			dest += "?" + r.URL.RawQuery
		}
	} else {
		dest += "?error=invalid_request"
	}
	//nolint:gosec // dest always starts with the fixed constant consentPath; only the query
	// string (never the scheme or host) comes from the request, so this can never redirect
	// off-site regardless of what the caller supplies.
	http.Redirect(w, r, dest, http.StatusFound)
}

// validateAuthorizeRequest checks the request's remaining preconditions —
// response_type, client_id, redirect_uri, and PKCE parameters — once
// handleAuthorize has already confirmed the caller is authenticated. It
// writes the appropriate OAuth error itself and returns ok=false on the
// first failure. Splitting this out of handleAuthorize keeps each
// function's branching independently readable and testable.
//
// CF5 (task-15-report.md): client_id and redirect_uri are deliberately
// collapsed into ONE generic "invalid_request" response, rather than
// client_id getting its own "unauthorized_client" error as earlier
// revisions did. Reporting them separately would let a caller distinguish
// "this client_id is wrong" from "this client_id is right but the
// redirect_uri is wrong" — an enumeration oracle over registered client
// IDs, on top of the redirect_uri oracle. This distinction is only ever
// reachable by an authenticated caller now that handleAuthorize
// authenticates first, but the collapsed response is kept regardless: it
// costs nothing and removes any temptation to split it again later.
// Neither error ever echoes the caller-supplied client_id or redirect_uri
// back into the response body or a header, and a Location header is never
// set on this path at all.
func (s *Server) validateAuthorizeRequest(w http.ResponseWriter, q url.Values) (redirectURI, codeChallenge string, ok bool) {
	if q.Get("response_type") != "code" {
		writeOAuthError(w, http.StatusBadRequest, "unsupported_response_type", "only response_type=code is supported")
		return "", "", false
	}

	redirectURI = q.Get("redirect_uri")
	if !s.validateClientAndRedirect(w, q.Get("client_id"), redirectURI) {
		return "", "", false
	}

	codeChallenge = q.Get("code_challenge")
	if !validatePKCE(w, codeChallenge, q.Get("code_challenge_method")) {
		return "", "", false
	}

	return redirectURI, codeChallenge, true
}

// validateClientAndRedirect is the shared client_id/redirect_uri check both
// validateAuthorizeRequest (GET /mcp/authorize) and handleAuthorizeConsent
// (POST /mcp/authorize/consent) use. See validateAuthorizeRequest's doc
// comment (CF5) for why client_id and redirect_uri are deliberately
// collapsed into one generic "invalid_request" response rather than two
// distinguishable ones.
func (s *Server) validateClientAndRedirect(w http.ResponseWriter, clientID, redirectURI string) bool {
	if !s.clientIDAllowed(clientID) || !s.isRegisteredRedirect(redirectURI) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "client_id or redirect_uri is not registered")
		return false
	}
	return true
}

// validatePKCE is the shared PKCE precondition check both
// validateAuthorizeRequest and handleAuthorizeConsent use: a non-empty
// challenge, using S256 specifically — RFC 7636 section 4.3's "plain"
// method is never accepted, since it offers no protection against a
// network observer who captures the authorization code.
func validatePKCE(w http.ResponseWriter, codeChallenge, codeChallengeMethod string) bool {
	if codeChallenge == "" || codeChallengeMethod != "S256" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "code_challenge with method S256 is required")
		return false
	}
	return true
}

// decisionApprove and decisionDeny are the two values consentRequest.Decision
// accepts. An empty Decision is treated as decisionApprove, matching the
// field's pre-existing behaviour from before Decision was added — every
// caller that never sends it (including every pre-existing test) keeps
// getting the approve path.
const (
	decisionApprove = "approve"
	decisionDeny    = "deny"
)

// consentRequest is the JSON body POST /mcp/authorize/consent accepts. It
// mirrors the query parameters GET /mcp/authorize takes, plus Scopes: the
// explicit list of scopes the user ticked in the consent UI. This is
// deliberately NOT derived from any token claim — a Google ID token (and
// the plain console self-signed token /auth/token issues) carries no
// paprika:* scope claim at all, so consent is the only source of truth for
// what is granted on this path.
//
// Decision (Fix round 1, Finding 1a) is "approve" or "deny" — an empty
// value defaults to "approve". Routing Deny through this endpoint, rather
// than having the UI build a rejection redirect from the raw redirect_uri
// itself, is the fix for the CRITICAL finding that a crafted
// "javascript:"-scheme redirect_uri could execute attacker script on the
// console origin when the UI assigned an unvalidated navigation target to
// location.href: the server validates client_id/redirect_uri exactly as on
// approve (see handleAuthorizeConsent) and is the only party that ever
// builds the resulting navigation target.
//
//nolint:tagliatelle // matches the snake_case field names GET /mcp/authorize's query parameters use.
type consentRequest struct {
	ClientID            string   `json:"client_id"`
	RedirectURI         string   `json:"redirect_uri"`
	CodeChallenge       string   `json:"code_challenge"`
	CodeChallengeMethod string   `json:"code_challenge_method"`
	State               string   `json:"state"`
	Scopes              []string `json:"scopes"`
	Decision            string   `json:"decision"`
}

// consentResponse is what a successful POST /mcp/authorize/consent returns:
// the exact URL — the client's own redirect_uri with code and state
// appended — the consent UI should navigate the browser to next, finishing
// the authorization_code hand-off back to the MCP client.
type consentResponse struct {
	RedirectTo string `json:"redirectTo"`
}

// handleAuthorizeConsent implements POST /mcp/authorize/consent: the
// endpoint the consent UI (consentPath) calls once an authenticated console
// user has either ticked which scopes to grant, or clicked Deny. It
// authenticates with the SAME console authenticator stack GET
// /mcp/authorize uses (never the MCP-audience one), and re-validates
// client_id/redirect_uri exactly as the GET path does (the request could
// reach here directly, not only via the browser redirect) BEFORE branching
// on Decision.
//
// Decision == "deny" (Fix round 1, Finding 1a) skips PKCE and scope
// validation entirely — no code is minted — and returns a redirectTo built
// by buildRedirectWithError carrying error=access_denied and the original
// state, appended to the now-validated redirect_uri. This is the only
// server-approved rejection target; the UI must never construct one itself
// from the raw, unvalidated redirect_uri a client supplied.
//
// Decision == "approve" (the default when omitted, preserving this
// endpoint's pre-existing behaviour) re-validates PKCE, validates the
// ticked scopes via consentedScope, and mints an authorization code bound
// to both the authenticated principal and exactly the consented scope.
//
// CSRF: this endpoint is state-changing (POST) but is not vulnerable to a
// classic cross-site CSRF, because it authenticates via an Authorization
// bearer header, never a cookie. A cross-site HTML form cannot set a custom
// request header, and a cross-site script attempting to via fetch/XHR would
// trigger a CORS preflight this server never answers permissively for this
// path (no Access-Control-Allow-Origin is set anywhere for /mcp/authorize/
// consent) — so a third-party page can neither submit a same-shape request
// carrying the victim's credential nor read the response. No separate CSRF
// token is added for this reason.
func (s *Server) handleAuthorizeConsent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ctx := auth.WithRequest(r.Context(), r)
	principal, err := s.authorizeAuthenticator.Authenticate(ctx)
	if err != nil {
		s.writeUnauthenticated(w)
		return
	}

	var req consentRequest
	if decodeErr := json.NewDecoder(r.Body).Decode(&req); decodeErr != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
		return
	}

	if !s.validateClientAndRedirect(w, req.ClientID, req.RedirectURI) {
		return
	}

	switch req.Decision {
	case "", decisionApprove:
		s.finishConsentApprove(r.Context(), w, principal, &req)
	case decisionDeny:
		finishConsentDeny(w, &req)
	default:
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "decision must be \"approve\" or \"deny\"")
	}
}

// finishConsentDeny builds the server-validated deny redirect (carrying
// error=access_denied and the original state) and returns it as the
// response's redirectTo. Called only after validateClientAndRedirect has
// already confirmed client_id and redirect_uri are registered — see Fix
// round 1, Finding 1(a): the browser must never construct this URL itself.
func finishConsentDeny(w http.ResponseWriter, req *consentRequest) {
	dest, err := buildRedirectWithError(req.RedirectURI, "access_denied", req.State)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, consentResponse{RedirectTo: dest})
}

// finishConsentApprove validates PKCE and the consented scope, mints the
// authorization code, and returns the redirect the browser should follow to
// complete the flow.
func (s *Server) finishConsentApprove(ctx context.Context, w http.ResponseWriter, principal *auth.Principal, req *consentRequest) {
	if !validatePKCE(w, req.CodeChallenge, req.CodeChallengeMethod) {
		return
	}

	scope, ok := consentedScope(req.Scopes)
	if !ok {
		writeOAuthError(w, http.StatusBadRequest, "invalid_scope", "no valid scope was consented to")
		return
	}

	code, err := s.issueAuthCode(ctx, &authCodeRecord{
		Subject:       principal.Subject,
		Email:         principal.Email,
		Name:          principal.Name,
		Scope:         scope,
		RedirectURI:   req.RedirectURI,
		CodeChallenge: req.CodeChallenge,
		ClientID:      req.ClientID,
	})
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	dest, err := buildRedirectWithCode(req.RedirectURI, code, req.State)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, consentResponse{RedirectTo: dest})
}

// consentedScope validates and normalises the scopes a user ticked in the
// consent UI, returning them joined into a single scope string exactly as
// negotiateScope's grants are represented. Unlike negotiateScope, this
// deliberately does NOT consult principal.Scopes — a console credential
// (Google ID token, or a plain self-signed console token) carries no
// paprika:* scope claim at all, so explicit consent is the only source of
// truth for what is granted here.
//
// requested must be non-empty and every entry must be exactly ScopeRead or
// ScopeWrite — an empty list or any unrecognised token is rejected outright
// (ok=false), the same fail-closed rule negotiateScope applies to an
// unrecognised or unheld scope: silently dropping an unrecognised value
// here could otherwise hand back a token granting less than the user
// thought they consented to, with no error to explain why. Duplicate
// entries are deduplicated.
func consentedScope(requested []string) (string, bool) {
	if len(requested) == 0 {
		return "", false
	}
	seen := make(map[Scope]struct{}, len(requested))
	granted := make([]Scope, 0, len(requested))
	for _, r := range requested {
		sc := Scope(r)
		if sc != ScopeRead && sc != ScopeWrite {
			return "", false
		}
		if _, dup := seen[sc]; dup {
			continue
		}
		seen[sc] = struct{}{}
		granted = append(granted, sc)
	}
	return scopesToString(granted), true
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
//   - requested contains any token that is not a recognised scope value at
//     all (e.g. "admin", or "PAPRIKA:WRITE" with the wrong case): the WHOLE
//     request is rejected (ok=false), same as an unheld-but-recognised
//     scope. ParseScopes silently drops unrecognised tokens by design (so
//     they can never widen access), which means it alone cannot be used
//     here to detect them — a raw field count comparison below is used
//     instead. Without this, a typo'd or garbage scope value used to
//     silently fall through to a zero-scope token: the whole authorize
//     request would succeed, but the client would receive a token that
//     could call nothing, with no error to explain why. See Fix round 2,
//     Fold-in 3.
func negotiateScope(principal *auth.Principal, requested string) (string, bool) {
	// A nil principal can never be granted any scope. handleAuthorize never
	// calls negotiateScope without first authenticating successfully, so
	// this should be unreachable in production — but negotiateScope is
	// unexported, callable directly, and one of only two places
	// (issueTokenPair being the other) where a scope claim originates, so it
	// must not blindly dereference a caller-supplied nil and panic. Fail
	// closed instead, exactly like every other rejection path here.
	if principal == nil {
		return "", false
	}
	granted := ParseScopes(strings.Join(principal.Scopes, " "))

	if strings.TrimSpace(requested) == "" {
		return scopesToString(granted), true
	}

	requestedScopes := ParseScopes(requested)
	if len(requestedScopes) != len(strings.Fields(requested)) {
		// At least one requested token was dropped by ParseScopes because it
		// is not a recognised scope value.
		return "", false
	}
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

// issueTokenPair mints an access token bound to MCPTokenAudience plus a
// fresh rotating refresh token, stores the refresh record, and writes the
// RFC 6749 section 5.1 JSON response. It is the single place both grant
// types converge, so every successful /mcp/token response is built the same
// way.
func (s *Server) issueTokenPair(ctx context.Context, w http.ResponseWriter, subject, email, name, scope string) {
	access, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject:  subject,
		Email:    email,
		Name:     name,
		Audience: MCPTokenAudience,
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
