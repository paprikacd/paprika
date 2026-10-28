package auth

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

const (
	browserSessionCookie = "paprika_browser_session"
	browserSessionHeader = "X-Paprika-Session"
	browserSessionTTL    = 7 * 24 * time.Hour
	maxSessionCookieSize = 3800
	maxAuthRequestSize   = 16 << 10
)

// browserSessions seals provider credentials for this browser only. The fixed
// deadline survives rotation. Logout removes this browser's cookie; it does not
// revoke a stolen cookie or the provider grant (which the provider can revoke).
type browserSessions struct {
	aead   cipher.AEAD
	origin string
	secure bool
	aad    []byte
	now    func() time.Time
}

type browserSession struct {
	Issuer       string   `json:"issuer"`
	ClientID     string   `json:"clientId"`
	Subject      string   `json:"subject"`
	Audience     []string `json:"audience"`
	RefreshToken string   `json:"refreshToken"`
	ExpiresAt    int64    `json:"expiresAt"`
}

// EnableBrowserSessions enables browser renewal when a signing secret and a
// trusted UI callback are configured. Call during setup, before serving requests.
func (o *OIDCAuthenticator) EnableBrowserSessions(secret []byte) error {
	if len(secret) == 0 || o.oauth2Config.RedirectURL == "" {
		return nil
	}
	callback, err := browserCallback(o.oauth2Config.RedirectURL)
	if err != nil {
		return err
	}
	key := hmac.New(sha256.New, secret)
	_, _ = key.Write([]byte("paprika:console-browser-session:v1"))
	block, err := aes.NewCipher(key.Sum(nil))
	if err != nil {
		return errors.New("cannot configure browser sessions")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return errors.New("cannot configure browser sessions")
	}
	o.sessions = &browserSessions{
		aead: aead, origin: callback.Scheme + "://" + callback.Host,
		secure: callback.Scheme == "https", now: time.Now,
		aad: []byte("paprika:console-browser-session:v1\x00" + o.issuer + "\x00" + o.oauth2Config.ClientID),
	}
	return nil
}

func browserCallback(rawURL string) (*url.URL, error) {
	callback, err := url.Parse(rawURL)
	if err != nil || callback.Host == "" || callback.User != nil || callback.RawQuery != "" || callback.Fragment != "" {
		return nil, errors.New("browser sessions require a valid UI callback")
	}
	local := slices.Contains([]string{"localhost", "127.0.0.1", "::1"}, callback.Hostname())
	if callback.Scheme != "https" && (callback.Scheme != "http" || !local) {
		return nil, errors.New("browser sessions require HTTPS or a loopback UI callback")
	}
	return callback, nil
}

func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
}

func (o *OIDCAuthenticator) browserRequest(r *http.Request) bool {
	return o.sessions != nil && r.Header.Get(browserSessionHeader) == "1" && r.Header.Get("Origin") == o.sessions.origin
}

func (o *OIDCAuthenticator) readBrowserSession(r *http.Request) (*browserSession, error) {
	if o.sessions == nil {
		return nil, ErrUnauthenticated
	}
	cookie, err := r.Cookie(browserSessionCookie)
	if err != nil || len(cookie.Value) > maxSessionCookieSize {
		return nil, ErrUnauthenticated
	}
	sealed, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil || len(sealed) < o.sessions.aead.NonceSize() {
		return nil, ErrUnauthenticated
	}
	nonceSize := o.sessions.aead.NonceSize()
	plain, err := o.sessions.aead.Open(nil, sealed[:nonceSize], sealed[nonceSize:], o.sessions.aad)
	if err != nil {
		return nil, ErrUnauthenticated
	}
	var session browserSession
	if json.Unmarshal(plain, &session) != nil || !o.validSession(&session) {
		return nil, ErrUnauthenticated
	}
	return &session, nil
}

func (o *OIDCAuthenticator) validSession(session *browserSession) bool {
	return session.ClientID == o.oauth2Config.ClientID && session.Subject != "" && session.Issuer != "" && session.RefreshToken != "" && len(session.Audience) > 0 && session.ExpiresAt > o.sessions.now().Unix()
}

func (o *OIDCAuthenticator) writeBrowserSession(w http.ResponseWriter, session *browserSession) error {
	// #nosec G117 -- This private plaintext is immediately AES-GCM sealed; only the authenticated ciphertext is sent to the browser.
	plain, err := json.Marshal(session)
	if err != nil {
		return errors.New("cannot save browser session")
	}
	nonce := make([]byte, o.sessions.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return errors.New("cannot save browser session")
	}
	value := base64.RawURLEncoding.EncodeToString(o.sessions.aead.Seal(nonce, nonce, plain, o.sessions.aad))
	if len(value) > maxSessionCookieSize || session.ExpiresAt <= o.sessions.now().Unix() {
		return errors.New("cannot save browser session")
	}
	// #nosec G124 -- EnableBrowserSessions derives Secure from the validated callback: HTTPS is required except for loopback development.
	http.SetCookie(w, &http.Cookie{
		Name: browserSessionCookie, Value: value, Path: "/auth", HttpOnly: true,
		Secure: o.sessions.secure, SameSite: http.SameSiteLaxMode,
		Expires: time.Unix(session.ExpiresAt, 0).UTC(), MaxAge: int(session.ExpiresAt - o.sessions.now().Unix()),
	})
	return nil
}

func (o *OIDCAuthenticator) clearBrowserSession(w http.ResponseWriter) {
	// #nosec G124 -- Match the issued cookie's validated HTTPS/loopback Secure setting when expiring it; no credential is sent.
	http.SetCookie(w, &http.Cookie{
		Name: browserSessionCookie, Value: "", Path: "/auth", HttpOnly: true,
		Secure: o.sessions.secure, SameSite: http.SameSiteLaxMode,
		Expires: time.Unix(1, 0).UTC(), MaxAge: -1,
	})
}

func sameSessionIdentity(session *browserSession, token *oidc.IDToken) bool {
	audience := slices.Clone(token.Audience)
	slices.Sort(audience)
	original := slices.Clone(session.Audience)
	slices.Sort(original)
	return token.Issuer == session.Issuer && token.Subject == session.Subject && slices.Equal(audience, original)
}

func (o *OIDCAuthenticator) saveLoginSession(w http.ResponseWriter, r *http.Request, token *oauth2Token) bool {
	verified, err := o.verifier.Verify(r.Context(), token.IDToken)
	if err != nil || verified.Subject == "" {
		return false
	}
	if token.RefreshToken == "" {
		previous, err := o.readBrowserSession(r)
		if err == nil && sameSessionIdentity(previous, verified) {
			return true
		}
		o.clearBrowserSession(w)
		return false
	}
	session := &browserSession{
		Issuer: verified.Issuer, ClientID: o.oauth2Config.ClientID, Subject: verified.Subject,
		Audience: verified.Audience, RefreshToken: token.RefreshToken,
		ExpiresAt: o.sessions.now().Add(browserSessionTTL).Unix(),
	}
	if o.writeBrowserSession(w, session) != nil {
		o.clearBrowserSession(w)
		return false
	}
	return true
}

func (o *OIDCAuthenticator) validateSessionRequest(w http.ResponseWriter, r *http.Request) bool {
	noStore(w)
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if !o.browserRequest(r) {
		http.Error(w, "browser session request is not allowed", http.StatusForbidden)
		return false
	}
	if _, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024)); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return false
	}
	return true
}

// RefreshHandler renews a console ID token using the browser's sealed grant.
func (o *OIDCAuthenticator) RefreshHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !o.validateSessionRequest(w, r) {
			return
		}
		session, err := o.readBrowserSession(r)
		if err != nil {
			o.clearBrowserSession(w)
			http.Error(w, "session expired; sign in again", http.StatusUnauthorized)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), oidcHTTPTimeout)
		defer cancel()
		token, err := requestProviderToken(ctx, o, url.Values{
			"grant_type": {"refresh_token"}, "refresh_token": {session.RefreshToken},
			"client_id": {o.oauth2Config.ClientID}, "client_secret": {o.oauth2Config.ClientSecret},
		})
		if err != nil {
			if invalidRefreshGrant(err) {
				o.clearBrowserSession(w)
				http.Error(w, "session expired; sign in again", http.StatusUnauthorized)
				return
			}
			http.Error(w, "session service temporarily unavailable", http.StatusServiceUnavailable)
			return
		}
		if token.IDToken == "" {
			o.clearBrowserSession(w)
			http.Error(w, "session expired; sign in again", http.StatusUnauthorized)
			return
		}
		verified, err := o.verifier.Verify(ctx, token.IDToken)
		if err != nil {
			// The verifier also fails during JWKS outages and does not expose a
			// typed transport error. Keep the grant, but never return unverified
			// credentials. The user can retry or explicitly sign in again.
			http.Error(w, "session service temporarily unavailable", http.StatusServiceUnavailable)
			return
		}
		if !sameSessionIdentity(session, verified) {
			o.clearBrowserSession(w)
			http.Error(w, "session expired; sign in again", http.StatusUnauthorized)
			return
		}
		o.completeRefresh(w, session, token, verified)
	}
}

func invalidRefreshGrant(err error) bool {
	var providerErr *providerTokenError
	return errors.As(err, &providerErr) && providerErr.status == http.StatusBadRequest && providerErr.code == "invalid_grant"
}

func (o *OIDCAuthenticator) completeRefresh(w http.ResponseWriter, session *browserSession, token *oauth2Token, verified *oidc.IDToken) {
	if token.RefreshToken != "" {
		session.RefreshToken = token.RefreshToken
	}
	if err := o.writeBrowserSession(w, session); err != nil {
		o.clearBrowserSession(w)
		http.Error(w, "session expired; sign in again", http.StatusUnauthorized)
		return
	}
	response := TokenResponse{
		IDToken: token.IDToken, AccessToken: token.AccessToken, TokenType: token.TokenType,
		ExpiresIn: int(time.Until(verified.Expiry).Seconds()), SessionRefreshAvailable: true,
	}
	w.Header().Set("Content-Type", "application/json")
	// #nosec G117 -- Return verified OAuth tokens only to the origin-checked browser presenting its sealed grant; the refresh token stays in the HttpOnly cookie.
	if err := json.NewEncoder(w).Encode(response); err != nil {
		http.Error(w, "cannot encode session response", http.StatusInternalServerError)
	}
}

// LogoutHandler removes this browser's refresh cookie; it does not revoke the
// provider's grant or a bearer token already issued to another client.
func (o *OIDCAuthenticator) LogoutHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !o.validateSessionRequest(w, r) {
			return
		}
		o.clearBrowserSession(w)
		w.WriteHeader(http.StatusNoContent)
	}
}

func (o *OIDCAuthenticator) isGoogle() bool {
	return strings.TrimSuffix(o.issuer, "/") == "https://accounts.google.com"
}

// PublicConfigHandler exposes only the login methods available to the console.
func PublicConfigHandler(cfg Config, authenticator *OIDCAuthenticator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		noStore(w)
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		provider, label := "oidc", "Single sign-on"
		if authenticator != nil && authenticator.isGoogle() {
			provider, label = "google", "Google"
		}
		response := struct {
			OIDC struct {
				Enabled  bool   `json:"enabled"`
				Provider string `json:"provider"`
				Label    string `json:"label"`
			} `json:"oidc"`
			Basic struct {
				Enabled bool `json:"enabled"`
			} `json:"basic"`
			Session struct {
				RefreshEnabled bool `json:"refreshEnabled"`
			} `json:"session"`
		}{}
		response.OIDC.Enabled = cfg.Enabled && authenticator != nil
		response.OIDC.Provider, response.OIDC.Label = provider, label
		response.Basic.Enabled = cfg.Enabled && cfg.BasicAuth != nil && len(cfg.TokenSecret) > 0
		response.Session.RefreshEnabled = response.OIDC.Enabled && authenticator.sessions != nil
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(response); err != nil {
			http.Error(w, "cannot encode login configuration", http.StatusInternalServerError)
		}
	}
}
