// console-session-e2e serves the real console auth handlers against a private,
// loopback OIDC issuer. No cluster, real account, or production secret is used.
package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/benebsworth/paprika/internal/api/auth"
)

const clientID = "console-session-e2e"

type authorization struct {
	challenge string
	redirect  string
}

type fixture struct {
	mu            sync.Mutex
	issuer        string
	redirectURI   string
	key           *rsa.PrivateKey
	controlKey    string
	codes         map[string]authorization
	refreshTokens map[string]bool
	authorize     int
	exchange      int
	refresh       int
	logout        int
	protected     int
	refreshMode   string
	refreshDelay  int
	loginHint     string
	prompt        string
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	readyFile := flag.String("ready-file", "", "Private ready JSON file")
	uiURL := flag.String("ui-url", "", "Optional loopback Next dev server")
	uiDir := flag.String("ui-dir", "ui/out", "Built static UI")
	flag.Parse()
	if *readyFile == "" {
		return errors.New("ready-file is required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return fmt.Errorf("generate fixture signing key: %w", err)
	}
	f := &fixture{key: key, controlKey: rand.Text(), codes: make(map[string]authorization), refreshTokens: make(map[string]bool)}
	issuer := httptest.NewServer(http.HandlerFunc(f.serveIssuer))
	defer issuer.Close()
	f.issuer = issuer.URL
	mux := http.NewServeMux()
	app := httptest.NewServer(mux)
	defer app.Close()
	f.redirectURI = app.URL + "/auth/callback"
	config := auth.Config{Enabled: true, TokenSecret: []byte(rand.Text() + rand.Text()), OIDC: &auth.OIDCConfig{
		IssuerURL: issuer.URL, ClientID: clientID, ClientSecret: rand.Text(), RedirectURL: f.redirectURI,
		Scopes: []string{"openid", "profile", "email", "offline_access"}, HTTPClient: issuer.Client(),
	}}
	authenticator, err := auth.NewOIDCAuthenticator(ctx, config.OIDC)
	if err != nil {
		return fmt.Errorf("initialize fixture OIDC: %w", err)
	}
	if err = authenticator.EnableBrowserSessions(config.TokenSecret); err != nil {
		return fmt.Errorf("enable fixture sessions: %w", err)
	}
	mux.HandleFunc("/auth/config", auth.PublicConfigHandler(config, authenticator))
	mux.HandleFunc("/auth/login", authenticator.LoginHandler())
	mux.HandleFunc("/auth/token", authenticator.TokenHandler())
	mux.HandleFunc("/auth/refresh", authenticator.RefreshHandler())
	mux.HandleFunc("/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.logout++
		f.mu.Unlock()
		authenticator.LogoutHandler()(w, r)
	})
	mux.HandleFunc("/__session_fixture/control", f.control)
	mux.HandleFunc("/__session_fixture/protected", f.protect(authenticator, func(w http.ResponseWriter, _ *http.Request) {
		respond(w, map[string]any{"subject": "console-test-user", "ok": true})
	}))
	// Dashboard data is deterministic and intentionally empty. Authentication is
	// real: expired or missing JWTs receive 401 from the production verifier.
	mux.HandleFunc("/paprika.v1.PaprikaService/", f.protect(authenticator, func(w http.ResponseWriter, _ *http.Request) {
		respond(w, map[string]any{})
	}))
	mux.HandleFunc("/api/insights/", f.protect(authenticator, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(strings.TrimRight(r.URL.Path, "/"), "/dashboards"):
			respond(w, map[string]any{"dashboards": []any{}})
		case strings.HasSuffix(strings.TrimRight(r.URL.Path, "/"), "/saved-queries"):
			respond(w, map[string]any{"queries": []any{}})
		default:
			respond(w, map[string]any{})
		}
	}))
	mux.HandleFunc("/observe/consent", consentDestination)
	mux.HandleFunc("/events", http.NotFound)
	frontend, err := frontendHandler(*uiURL, *uiDir)
	if err != nil {
		return err
	}
	mux.Handle("/", frontend)
	if err = f.writeReady(*readyFile, app.URL); err != nil {
		return err
	}
	fmt.Println("Console session fixture ready (loopback only)")
	<-ctx.Done()
	return nil
}

func consentDestination(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if _, err := fmt.Fprint(w, "<!doctype html><title>Observe consent fixture</title><h1>Observe consent resumed</h1>"); err != nil {
		fmt.Fprintln(os.Stderr, "write fixture consent response failed")
	}
}

func (f *fixture) writeReady(filename, appURL string) error {
	ready, err := json.Marshal(map[string]string{"baseURL": appURL, "issuerURL": f.issuer, "controlKey": f.controlKey})
	if err != nil {
		return fmt.Errorf("encode fixture readiness: %w", err)
	}
	if err = os.WriteFile(filename, ready, 0o600); err != nil {
		return fmt.Errorf("write fixture readiness: %w", err)
	}
	return nil
}

func frontendHandler(rawURL, directory string) (http.Handler, error) {
	if rawURL == "" {
		return http.FileServer(http.Dir(directory)), nil
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
		return nil, errors.New("ui-url must be a loopback HTTP URL")
	}
	return httputil.NewSingleHostReverseProxy(u), nil
}

func (f *fixture) protect(authenticator *auth.OIDCAuthenticator, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, err := authenticator.Authenticate(auth.WithRequest(r.Context(), r)); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			respond(w, map[string]string{"code": "unauthenticated", "message": "Session expired"})
			return
		}
		f.mu.Lock()
		f.protected++
		f.mu.Unlock()
		next(w, r)
	}
}

func (f *fixture) serveIssuer(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.URL.Path {
	case "/.well-known/openid-configuration":
		respond(w, map[string]any{
			"issuer": f.issuer, "authorization_endpoint": f.issuer + "/authorize", "token_endpoint": f.issuer + "/token", "jwks_uri": f.issuer + "/jwks",
			"response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"},
			"id_token_signing_alg_values_supported": []string{"RS256"}, "scopes_supported": []string{"openid", "profile", "email", "offline_access"},
		})
	case "/jwks":
		respond(w, map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "kid": "session-fixture", "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(f.key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(f.key.E)).Bytes()),
		}}})
	case "/authorize":
		f.authorizeRequest(w, r)
	case "/token":
		f.token(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (f *fixture) authorizeRequest(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	redirect, err := url.Parse(query.Get("redirect_uri"))
	if err != nil || redirect.Scheme != "http" || redirect.Hostname() != "127.0.0.1" || f.redirectURI == "" || query.Get("redirect_uri") != f.redirectURI || query.Get("client_id") != clientID || query.Get("code_challenge_method") != "S256" {
		http.Error(w, "invalid fixture authorization", http.StatusBadRequest)
		return
	}
	code := rand.Text()
	f.mu.Lock()
	f.authorize++
	f.loginHint, f.prompt = query.Get("login_hint"), query.Get("prompt")
	f.codes[code] = authorization{challenge: query.Get("code_challenge"), redirect: redirect.String()}
	f.mu.Unlock()
	values := redirect.Query()
	values.Set("code", code)
	values.Set("state", query.Get("state"))
	redirect.RawQuery = values.Encode()
	// #nosec G710 -- The redirect must exactly match the callback of this fixture's own loopback app; only encoded OAuth code/state parameters are added.
	http.Redirect(w, r, redirect.String(), http.StatusFound)
}

func (f *fixture) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}
	if !f.validateGrant(w, r) {
		return
	}
	refresh := rand.Text()
	f.mu.Lock()
	f.refreshTokens[refresh] = true
	f.mu.Unlock()
	idToken, err := f.signToken(time.Now().Add(time.Hour))
	if err != nil {
		http.Error(w, "cannot sign fixture token", http.StatusInternalServerError)
		return
	}
	respond(w, map[string]any{"id_token": idToken, "access_token": rand.Text(), "refresh_token": refresh, "expires_in": 3600, "token_type": "Bearer"})
}

func (f *fixture) validateGrant(w http.ResponseWriter, r *http.Request) bool {
	switch r.Form.Get("grant_type") {
	case "authorization_code":
		f.mu.Lock()
		f.exchange++
		code, valid := f.codes[r.Form.Get("code")]
		delete(f.codes, r.Form.Get("code"))
		f.mu.Unlock()
		digest := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if !valid || code.redirect != r.Form.Get("redirect_uri") || code.challenge != base64.RawURLEncoding.EncodeToString(digest[:]) {
			invalidGrant(w)
			return false
		}
		return true
	case "refresh_token":
		return f.validateRefresh(w, r)
	default:
		http.Error(w, "unsupported grant", http.StatusBadRequest)
		return false
	}
}

func (f *fixture) validateRefresh(w http.ResponseWriter, r *http.Request) bool {
	f.mu.Lock()
	f.refresh++
	mode, delay := f.refreshMode, f.refreshDelay
	valid := f.refreshTokens[r.Form.Get("refresh_token")]
	f.mu.Unlock()
	if delay > 0 {
		time.Sleep(time.Duration(delay) * time.Millisecond)
	}
	if mode == "unavailable" {
		http.Error(w, "fixture temporarily unavailable", http.StatusServiceUnavailable)
		return false
	}
	if mode == "revoked" || !valid {
		invalidGrant(w)
		return false
	}
	f.mu.Lock()
	delete(f.refreshTokens, r.Form.Get("refresh_token"))
	f.mu.Unlock()
	return true
}

func invalidGrant(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	respond(w, map[string]string{"error": "invalid_grant"})
}

func (f *fixture) signToken(expiry time.Time) (string, error) {
	header, err := json.Marshal(map[string]string{"alg": "RS256", "kid": "session-fixture", "typ": "JWT"})
	if err != nil {
		return "", fmt.Errorf("encode JWT header: %w", err)
	}
	claims, err := json.Marshal(map[string]any{
		"iss": f.issuer, "sub": "console-test-user", "aud": clientID,
		"iat": time.Now().Add(-time.Hour).Unix(), "exp": expiry.Unix(),
		"email": "robin@example.test", "email_verified": true, "name": "Robin Test", "picture": "",
	})
	if err != nil {
		return "", fmt.Errorf("encode JWT claims: %w", err)
	}
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", fmt.Errorf("sign JWT: %w", err)
	}
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func (f *fixture) control(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Session-Fixture") != f.controlKey {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodPost {
		var command struct {
			RefreshMode  string `json:"refreshMode"`
			RefreshDelay int    `json:"refreshDelay"`
			Reset        bool   `json:"reset"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&command); err != nil {
			http.Error(w, "invalid control", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.refreshMode, f.refreshDelay = command.RefreshMode, command.RefreshDelay
		if command.Reset {
			f.authorize, f.exchange, f.refresh, f.logout, f.protected = 0, 0, 0, 0, 0
			f.loginHint, f.prompt = "", ""
		}
		f.mu.Unlock()
	}
	expired, err := f.signToken(time.Now().Add(-time.Minute))
	if err != nil {
		http.Error(w, "cannot sign token", http.StatusInternalServerError)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	respond(w, map[string]any{
		"authorize": f.authorize, "exchange": f.exchange, "refresh": f.refresh, "logout": f.logout, "protected": f.protected,
		"loginHint": f.loginHint, "prompt": f.prompt, "expiredToken": expired,
	})
}

func respond(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		fmt.Fprintln(os.Stderr, "write fixture JSON response failed")
	}
}
