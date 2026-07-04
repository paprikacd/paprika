package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// TokenRequest is the request body for the token exchange endpoint.
type TokenRequest struct {
	Code         string `json:"code"`
	CodeVerifier string `json:"code_verifier"`
	RedirectURI  string `json:"redirect_uri"`
}

// TokenResponse is returned by the token exchange endpoint.
type TokenResponse struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token,omitempty"`
	ExpiresIn    int    `json:"expires_in"`
	TokenType    string `json:"token_type,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
}

// TokenHandler returns an http.Handler that exchanges an OIDC authorization code
// for tokens via the provider's token endpoint (backchannel exchange using the
// client secret). This keeps the client secret server-side.
// POST /auth/token
func (o *OIDCAuthenticator) TokenHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req TokenRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}

		if req.Code == "" || req.CodeVerifier == "" {
			http.Error(w, "code and code_verifier are required", http.StatusBadRequest)
			return
		}

		redirectURI := req.RedirectURI
		if redirectURI == "" {
			redirectURI = o.oauth2Config.RedirectURL
		}

		token, err := exchangeCode(r.Context(), o, req.Code, req.CodeVerifier, redirectURI)
		if err != nil {
			http.Error(w, "token exchange failed: "+err.Error(), http.StatusUnauthorized)
			return
		}

		rawIDToken, ok := token.Extra("id_token").(string)
		if !ok || rawIDToken == "" {
			http.Error(w, "no id_token in response", http.StatusUnauthorized)
			return
		}

		if err := o.validateIDToken(r.Context(), rawIDToken); err != nil {
			http.Error(w, "id_token validation failed: "+err.Error(), http.StatusUnauthorized)
			return
		}

		resp := TokenResponse{
			IDToken:     rawIDToken,
			AccessToken: token.AccessToken,
			TokenType:   token.TokenType,
			ExpiresIn:   token.ExpiresIn,
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(resp)
	}
}

func exchangeCode(ctx context.Context, o *OIDCAuthenticator, code, codeVerifier, redirectURI string) (*oauth2Token, error) {
	data := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"client_id":     {o.oauth2Config.ClientID},
		"client_secret": {o.oauth2Config.ClientSecret},
		"code_verifier": {codeVerifier},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.tokenEndpoint(), strings.NewReader(data.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, errorf("token endpoint returned %d: %s", resp.StatusCode, string(body))
	}

	var token oauth2Token
	if err := json.Unmarshal(body, &token); err != nil {
		return nil, err
	}

	return &token, nil
}

func (o *OIDCAuthenticator) tokenEndpoint() string {
	return o.oauth2Config.Endpoint.TokenURL
}

func (o *OIDCAuthenticator) validateIDToken(ctx context.Context, rawIDToken string) error {
	_, err := o.verifier.Verify(ctx, rawIDToken)
	return err
}

// oauth2Token mirrors the OAuth2 token response for raw JSON parsing.
type oauth2Token struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresIn    int    `json:"expires_in"`
	IDToken      string `json:"id_token"`
}

func (t *oauth2Token) Extra(key string) interface{} {
	switch key {
	case "id_token":
		return t.IDToken
	default:
		return nil
	}
}

func errorf(format string, args ...interface{}) error {
	return fmt.Errorf(format, args...)
}
