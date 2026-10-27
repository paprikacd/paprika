package uptime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

const firebaseTokenURL = "https://securetoken.googleapis.com/v1/token" //nolint:gosec // G101: public fixed Firebase endpoint, not a credential.

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
	return refreshFirebase(ctx, credential, client)
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

func refreshFirebase(ctx context.Context, credential firebaseCredential, client *http.Client) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	body := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {credential.RefreshToken}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, firebaseTokenURL+"?"+url.Values{"key": {credential.APIKey}}.Encode(), strings.NewReader(body.Encode()))
	if err != nil {
		return "", errors.New("uptime credential refresh failed")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	boundedClient := *client
	boundedClient.CheckRedirect = httphelp.RejectRedirect
	// Do not retry token issuance. The request always uses this fixed Google
	// HTTPS origin and the verified transport, never provider HTTP/TLS options.
	response, err := boundedClient.Do(req) // #nosec G704 -- fixed Firebase origin; only the API key query value varies; redirects are refused.
	if err != nil {
		return "", errors.New("uptime credential refresh failed")
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // Best-effort close after the bounded response read.
	return refreshedToken(response)
}

func refreshedToken(response *http.Response) (string, error) {
	if response.StatusCode == http.StatusBadRequest || response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return "", connector.ErrForbidden
	}
	if response.StatusCode != http.StatusOK {
		return "", errors.New("uptime credential refresh failed")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (32<<10)+1))
	if err != nil || len(raw) > 32<<10 {
		return "", errors.New("uptime credential refresh failed")
	}
	//nolint:tagliatelle // Firebase's documented REST response uses snake_case.
	var result struct {
		IDToken string `json:"id_token"`
	}
	if json.Unmarshal(raw, &result) != nil || !validToken(result.IDToken, 16<<10) {
		return "", errors.New("uptime credential refresh failed")
	}
	return result.IDToken, nil
}
