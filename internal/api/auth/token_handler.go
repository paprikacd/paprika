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
	IDToken                 string `json:"idToken"`
	AccessToken             string `json:"accessToken,omitempty"`
	ExpiresIn               int    `json:"expiresIn"`
	TokenType               string `json:"tokenType,omitempty"`
	SessionRefreshAvailable bool   `json:"sessionRefreshAvailable"`
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
		noStore(w)
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		req, err := decodeTokenRequest(w, r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		redirectURI, err := o.validateRedirectURL(req.RedirectURI)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		browser, err := o.browserTokenExchange(r, redirectURI)
		if err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}

		rawIDToken, tokenResp, err := o.exchangeAndValidate(r.Context(), req)
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
		if browser {
			resp.SessionRefreshAvailable = o.saveLoginSession(w, r, tokenResp)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// #nosec G117 -- OAuth code exchange intentionally returns verified tokens to the PKCE client; no provider refresh token enters this response.
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			http.Error(w, fmt.Sprintf("encode response: %v", err), http.StatusInternalServerError)
		}
	}
}

func decodeTokenRequest(w http.ResponseWriter, r *http.Request) (*TokenRequest, error) {
	var req TokenRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAuthRequestSize))
	if err := decoder.Decode(&req); err != nil {
		return nil, errors.New("invalid request body")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("invalid request body")
	}
	if req.Code == "" || req.CodeVerifier == "" {
		return nil, errors.New("code and codeVerifier are required")
	}
	return &req, nil
}

func (o *OIDCAuthenticator) browserTokenExchange(r *http.Request, redirectURI string) (bool, error) {
	browser := o.browserRequest(r) && redirectURI == o.oauth2Config.RedirectURL && redirectURI != CLIRedirectURL
	if o.sessions != nil && r.Header.Get(browserSessionHeader) != "" && !browser {
		return false, errors.New("browser session request is not allowed")
	}
	return browser, nil
}

func (o *OIDCAuthenticator) exchangeAndValidate(ctx context.Context, req *TokenRequest) (string, *oauth2Token, error) {
	redirectURI, err := o.validateRedirectURL(req.RedirectURI)
	if err != nil {
		return "", nil, err
	}

	token, err := exchangeCode(ctx, o, req.Code, req.CodeVerifier, redirectURI)
	if err != nil {
		return "", nil, err
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return "", nil, errors.New("no id_token in response")
	}

	if err := o.validateIDToken(ctx, rawIDToken); err != nil {
		return "", nil, errors.New("id_token validation failed")
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
	return requestProviderToken(ctx, o, data)
}

// providerTokenError retains only the standard OAuth error code, never provider
// descriptions, request credentials or response bodies.
type providerTokenError struct {
	status int
	code   string
}

func (e *providerTokenError) Error() string {
	return fmt.Sprintf("token endpoint returned HTTP %d", e.status)
}

func requestProviderToken(ctx context.Context, o *OIDCAuthenticator, data url.Values) (*oauth2Token, error) {
	ctx, cancel := context.WithTimeout(ctx, oidcHTTPTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.tokenEndpoint(), strings.NewReader(data.Encode()))
	if err != nil {
		return nil, errors.New("token request failed")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := o.httpClient.Do(req)
	if err != nil {
		return nil, errors.New("token request failed")
	}
	//nolint:errcheck // response body cleanup is best-effort after the bounded read
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxTokenResponseSize+1))
	if err != nil {
		return nil, errors.New("token request failed")
	}
	if len(body) > maxTokenResponseSize {
		return nil, errors.New("token endpoint response too large")
	}

	if resp.StatusCode != http.StatusOK {
		var failure struct {
			Code string `json:"error"`
		}
		if err := json.Unmarshal(body, &failure); err != nil {
			failure.Code = ""
		}
		return nil, &providerTokenError{status: resp.StatusCode, code: failure.Code}
	}

	var token oauth2Token
	if err := json.Unmarshal(body, &token); err != nil {
		return nil, errors.New("invalid token endpoint response")
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
