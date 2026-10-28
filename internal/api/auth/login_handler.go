package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"unicode"

	"golang.org/x/oauth2"
)

type LoginResponse struct {
	URL          string `json:"url"`
	CodeVerifier string `json:"codeVerifier"`
	State        string `json:"state"`
}

func (o *OIDCAuthenticator) LoginHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		noStore(w)
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		redirectURI, err := o.validateRedirectURL(r.URL.Query().Get("redirect_uri"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		state, err := randomString(32)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		codeVerifier, err := randomString(64)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		codeChallenge := pkceChallenge(codeVerifier)

		options := []oauth2.AuthCodeOption{
			oauth2.SetAuthURLParam("code_challenge", codeChallenge),
			oauth2.SetAuthURLParam("code_challenge_method", "S256"),
			oauth2.SetAuthURLParam("redirect_uri", redirectURI),
		}
		if redirectURI == o.oauth2Config.RedirectURL && redirectURI != CLIRedirectURL {
			browserOptions, err := o.browserLoginOptions(r)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			options = append(options, browserOptions...)
		}
		authURL := o.oauth2Config.AuthCodeURL(state, options...)

		resp := LoginResponse{
			URL:          authURL,
			CodeVerifier: codeVerifier,
			State:        state,
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			http.Error(w, fmt.Sprintf("encode response: %v", err), http.StatusInternalServerError)
		}
	}
}

func (o *OIDCAuthenticator) browserLoginOptions(r *http.Request) ([]oauth2.AuthCodeOption, error) {
	hint := strings.TrimSpace(r.URL.Query().Get("login_hint"))
	if len(hint) > 320 || strings.ContainsFunc(hint, unicode.IsControl) {
		return nil, errors.New("invalid login hint")
	}
	switchAccount := r.URL.Query().Get("switchAccount") == "true"
	options := []oauth2.AuthCodeOption{}
	if hint != "" && !switchAccount {
		options = append(options, oauth2.SetAuthURLParam("login_hint", hint))
	}
	prompts := []string{}
	if switchAccount {
		prompts = append(prompts, "select_account")
	}
	offlineOptions, offline := o.offlineLoginOptions()
	options = append(options, offlineOptions...)
	_, sessionErr := o.readBrowserSession(r)
	if offline && (sessionErr != nil || switchAccount) {
		prompts = append(prompts, "consent")
	}
	if len(prompts) > 0 {
		options = append(options, oauth2.SetAuthURLParam("prompt", strings.Join(prompts, " ")))
	}
	return options, nil
}

func (o *OIDCAuthenticator) offlineLoginOptions() ([]oauth2.AuthCodeOption, bool) {
	if o.sessions == nil {
		return nil, false
	}
	if o.isGoogle() {
		return []oauth2.AuthCodeOption{oauth2.SetAuthURLParam("access_type", "offline")}, true
	}
	if slices.Contains(o.oauth2Config.Scopes, "offline_access") {
		return nil, true
	}
	var discovery struct {
		Scopes []string `json:"scopes_supported"` //nolint:tagliatelle // Standard OIDC discovery field.
	}
	if o.provider == nil {
		return nil, false
	}
	if err := o.provider.Claims(&discovery); err != nil {
		return nil, false
	}
	if !slices.Contains(discovery.Scopes, "offline_access") {
		return nil, false
	}
	return []oauth2.AuthCodeOption{oauth2.SetAuthURLParam("scope", strings.Join(o.oauth2Config.Scopes, " ")+" offline_access")}, true
}

func randomString(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", errors.New("failed to generate random bytes")
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func pkceChallenge(verifier string) string {
	h := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(h[:])
}
