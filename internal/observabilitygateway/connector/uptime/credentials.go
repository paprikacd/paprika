package uptime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

const firebaseTokenURL = "https://securetoken.googleapis.com/v1/token" //nolint:gosec // G101: public fixed Firebase endpoint, not a credential.

const (
	firebaseRefreshTimeout = 8 * time.Second
	// tokenRefreshMargin stops an ID token being reused in its last minutes, so
	// a read that starts just before expiry does not fail mid-request.
	tokenRefreshMargin = 5 * time.Minute
)

// newCredentialClient returns the client for Firebase refreshes. It uses the
// shared verified transport with no provider TLS options. Tests replace it to
// reach a fake token endpoint.
var newCredentialClient = func() *http.Client {
	return &http.Client{Transport: transport, CheckRedirect: httphelp.RejectRedirect}
}

// tokens keeps Firebase ID tokens, keyed by the credential identity. Each
// token is kept until tokenRefreshMargin before its expires_in, and concurrent
// refreshes for one credential share a single request.
var tokens = newCoalescer[string](maxCachedEntries, func(token string) int { return len(token) })

// The refresh credential is accepted only from credentialsSecretRef. It is
// never accepted from config, query text, provider metadata or error messages.
type firebaseCredential struct {
	APIKey       string `json:"apiKey"`       // #nosec G117 -- explicit private credential document, never serialized in a response.
	RefreshToken string `json:"refreshToken"` // #nosec G117 -- explicit private credential document, never serialized in a response.
}

func bearerCredential(ctx context.Context, raw []byte, client *http.Client) (string, error) {
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return "", connector.ErrNotConfigured
	}
	if len(text) > 16<<10 {
		return "", connector.ErrForbidden
	}
	if !strings.HasPrefix(text, "{") {
		if !validToken(text, 16<<10) {
			return "", connector.ErrForbidden
		}
		return text, nil
	}
	credential, err := parseFirebaseCredential(text)
	if err != nil {
		return "", err
	}
	return refreshFirebase(ctx, raw, credential, client)
}

func validToken(value string, limit int) bool {
	return value != "" && len(value) <= limit && !strings.ContainsAny(value, "\r\n\t ")
}

func parseFirebaseCredential(raw string) (firebaseCredential, error) {
	var credential firebaseCredential
	if checkJSON(raw) != nil {
		return credential, connector.ErrForbidden
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&credential) != nil {
		return credential, connector.ErrForbidden
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return credential, connector.ErrForbidden
	}
	if !validToken(credential.APIKey, 256) || !validToken(credential.RefreshToken, 12<<10) {
		return credential, connector.ErrForbidden
	}
	return credential, nil
}

func refreshFirebase(ctx context.Context, raw []byte, credential firebaseCredential, client *http.Client) (string, error) {
	return tokens.do(ctx, "firebase-token-refresh", credentialIdentity(raw), firebaseRefreshTimeout, func(fetchCtx context.Context) (string, time.Duration, error) {
		token, lifetime, err := fetchFirebaseToken(fetchCtx, credential, client)
		if err != nil {
			return "", 0, err
		}
		return token, tokenKeepFor(lifetime), nil
	})
}

// tokenKeepFor returns how long a token with the given lifetime may be reused.
// A lifetime too short to leave room after the refresh margin is not kept.
func tokenKeepFor(lifetime time.Duration) time.Duration {
	keep := lifetime - tokenRefreshMargin
	if keep <= 0 {
		return 0
	}
	return keep
}

func fetchFirebaseToken(ctx context.Context, credential firebaseCredential, client *http.Client) (string, time.Duration, error) {
	body := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {credential.RefreshToken}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, firebaseTokenURL+"?"+url.Values{"key": {credential.APIKey}}.Encode(), strings.NewReader(body.Encode()))
	if err != nil {
		return "", 0, errors.New("uptime credential refresh failed")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	boundedClient := *client
	boundedClient.CheckRedirect = httphelp.RejectRedirect
	// Do not retry token issuance. The request always uses this fixed Google
	// HTTPS origin and the verified transport, never provider HTTP/TLS options.
	response, err := boundedClient.Do(req) // #nosec G704 -- fixed Firebase origin; only the API key query value varies; redirects are refused.
	if err != nil {
		return "", 0, errors.New("uptime credential refresh failed")
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // Best-effort close after the bounded response read.
	return refreshedToken(response)
}

// lifetimeSeconds reads Firebase's expires_in, which the REST API sends as a
// quoted decimal string. A missing or malformed value reads as zero, so the
// token is used but not kept.
type lifetimeSeconds int64

func (s *lifetimeSeconds) UnmarshalJSON(raw []byte) error {
	seconds, err := strconv.ParseInt(strings.Trim(string(raw), `"`), 10, 64)
	if err != nil || seconds < 0 {
		seconds = 0
	}
	*s = lifetimeSeconds(seconds)
	return nil
}

func refreshedToken(response *http.Response) (string, time.Duration, error) {
	if response.StatusCode == http.StatusBadRequest || response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return "", 0, connector.ErrForbidden
	}
	if response.StatusCode != http.StatusOK {
		return "", 0, errors.New("uptime credential refresh failed")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (32<<10)+1))
	if err != nil || len(raw) > 32<<10 {
		return "", 0, errors.New("uptime credential refresh failed")
	}
	//nolint:tagliatelle // Firebase's documented REST response uses snake_case.
	var result struct {
		IDToken   string          `json:"id_token"`
		ExpiresIn lifetimeSeconds `json:"expires_in"`
	}
	if json.Unmarshal(raw, &result) != nil || !validToken(result.IDToken, 16<<10) {
		return "", 0, errors.New("uptime credential refresh failed")
	}
	return result.IDToken, time.Duration(result.ExpiresIn) * time.Second, nil
}
