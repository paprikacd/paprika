/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	loginRequestTimeout  = 15 * time.Second
	maxLoginResponseSize = 1 << 20
)

var errAuthenticationFailed = errors.New("authentication failed; please try again")

type loginResponse struct {
	URL          string `json:"url"`
	CodeVerifier string `json:"codeVerifier"`
	State        string `json:"state"`
}

type tokenRequest struct {
	Code         string `json:"code"`
	CodeVerifier string `json:"codeVerifier"`
	RedirectURI  string `json:"redirectUri"`
}

type tokenResponse struct {
	IDToken string `json:"idToken"`
}

func newLoginHTTPClient() *http.Client {
	return &http.Client{
		Timeout: loginRequestTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func requestLogin(ctx context.Context, client *http.Client, server, redirectURI string) (*loginResponse, error) {
	loginURL := strings.TrimRight(server, "/") + "/auth/login"
	parsed, err := url.Parse(loginURL)
	if err != nil {
		return nil, errors.New("start login request failed")
	}
	query := parsed.Query()
	query.Set("redirect_uri", redirectURI)
	parsed.RawQuery = query.Encode()

	requestCtx, cancel := context.WithTimeout(ctx, loginRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, parsed.String(), http.NoBody)
	if err != nil {
		return nil, errors.New("start login request failed")
	}
	body, status, err := doBoundedRequest(client, req)
	if err != nil || status != http.StatusOK {
		return nil, errors.New("start login request failed")
	}

	var response loginResponse
	if err := json.Unmarshal(body, &response); err != nil || response.URL == "" || response.CodeVerifier == "" || response.State == "" {
		return nil, errors.New("start login request failed")
	}
	return &response, nil
}

func exchangeLoginCode(ctx context.Context, client *http.Client, server string, request tokenRequest) (*tokenResponse, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return nil, errAuthenticationFailed
	}

	requestCtx, cancel := context.WithTimeout(ctx, loginRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost,
		strings.TrimRight(server, "/")+"/auth/token", bytes.NewReader(body))
	if err != nil {
		return nil, errAuthenticationFailed
	}
	req.Header.Set("Content-Type", "application/json")

	responseBody, status, err := doBoundedRequest(client, req)
	if err != nil || status != http.StatusOK {
		return nil, errAuthenticationFailed
	}
	var response tokenResponse
	if err := json.Unmarshal(responseBody, &response); err != nil || response.IDToken == "" {
		return nil, errAuthenticationFailed
	}
	return &response, nil
}

func doBoundedRequest(client *http.Client, req *http.Request) (body []byte, status int, requestErr error) {
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("perform login HTTP request: %w", err)
	}
	var readErr error
	body, readErr = io.ReadAll(io.LimitReader(resp.Body, maxLoginResponseSize+1))
	closeErr := resp.Body.Close()
	if readErr != nil {
		return nil, resp.StatusCode, fmt.Errorf("read login HTTP response: %w", readErr)
	}
	if closeErr != nil {
		return nil, resp.StatusCode, fmt.Errorf("close login HTTP response: %w", closeErr)
	}
	if len(body) > maxLoginResponseSize {
		return nil, resp.StatusCode, errors.New("response too large")
	}
	return body, resp.StatusCode, nil
}
