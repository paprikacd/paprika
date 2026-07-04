package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type TokenRequest struct {
	Code         string `json:"code"`
	CodeVerifier string `json:"codeVerifier"`
	RedirectURI  string `json:"redirectUri"`
}

type TokenResponse struct {
	IDToken      string `json:"idToken"`
	AccessToken  string `json:"accessToken,omitempty"`
	ExpiresIn    int    `json:"expiresIn"`
	TokenType    string `json:"tokenType,omitempty"`
	RefreshToken string `json:"refreshToken,omitempty"`
}

//nolint:tagliatelle // standard OAuth2 snake_case fields per RFC 6749
type oauth2Token struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresIn    int    `json:"expires_in"`
	IDToken      string `json:"id_token"`
}

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
			http.Error(w, "code and codeVerifier are required", http.StatusBadRequest)
			return
		}

		rawIDToken, tokenResp, err := o.exchangeAndValidate(r.Context(), &req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}

		resp := TokenResponse{
			IDToken:     rawIDToken,
			AccessToken: tokenResp.AccessToken,
			TokenType:   tokenResp.TokenType,
			ExpiresIn:   tokenResp.ExpiresIn,
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		//nolint:gosec // AccessToken is a session token, not a secret
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			http.Error(w, fmt.Sprintf("encode response: %v", err), http.StatusInternalServerError)
		}
	}
}

func (o *OIDCAuthenticator) exchangeAndValidate(ctx context.Context, req *TokenRequest) (string, *oauth2Token, error) {
	redirectURI := req.RedirectURI
	if redirectURI == "" {
		redirectURI = o.oauth2Config.RedirectURL
	}

	token, err := exchangeCode(ctx, o, req.Code, req.CodeVerifier, redirectURI)
	if err != nil {
		return "", nil, fmt.Errorf("token exchange failed: %w", err)
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return "", nil, errors.New("no id_token in response")
	}

	if err := o.validateIDToken(ctx, rawIDToken); err != nil {
		return "", nil, fmt.Errorf("id_token validation failed: %w", err)
	}

	return rawIDToken, token, nil
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
		return nil, fmt.Errorf("create token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("token request: %w", err)
	}

	defer func() {
		if cerr := resp.Body.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("close token response body: %w", cerr)
		}
	}()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read token response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("token endpoint returned %d: %s", resp.StatusCode, string(body))
	}

	var token oauth2Token
	if err := json.Unmarshal(body, &token); err != nil {
		return nil, fmt.Errorf("parse token response: %w", err)
	}

	return &token, nil
}

func (o *OIDCAuthenticator) tokenEndpoint() string {
	return o.oauth2Config.Endpoint.TokenURL
}

func (o *OIDCAuthenticator) validateIDToken(ctx context.Context, rawIDToken string) error {
	_, err := o.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return fmt.Errorf("verify id_token: %w", err)
	}
	return nil
}

func (t *oauth2Token) Extra(key string) interface{} {
	switch key {
	case "id_token":
		return t.IDToken
	default:
		return nil
	}
}
