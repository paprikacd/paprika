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
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/spf13/cobra"
)

const defaultLoginCallbackTimeout = 5 * time.Minute

const (
	defaultBrowserLaunchTimeout  = 10 * time.Second
	loginBrowserResultGrace      = time.Second
	maxLoginIdentityDisplayBytes = 256
)

type loginDependencies struct {
	client               *http.Client
	listen               func(network, address string) (net.Listener, error)
	openBrowser          func(context.Context, string) error
	callbackTimeout      time.Duration
	browserLaunchTimeout time.Duration
	now                  func() time.Time
}

func defaultLoginDependencies() loginDependencies {
	return loginDependencies{
		client:               newLoginHTTPClient(),
		listen:               net.Listen,
		openBrowser:          openBrowserURL,
		callbackTimeout:      defaultLoginCallbackTimeout,
		browserLaunchTimeout: defaultBrowserLaunchTimeout,
		now:                  time.Now,
	}
}

func newLoginCmd(ctx context.Context) *cobra.Command {
	return newLoginCmdWithDependencies(ctx, defaultLoginDependencies())
}

func newLoginCmdWithDependencies(ctx context.Context, dependencies loginDependencies) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Log in through your browser",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return executeLogin(ctx, cmd.OutOrStdout(), dependencies)
		},
	}
	return cmd
}

func executeLogin(ctx context.Context, writer io.Writer, dependencies loginDependencies) error { //nolint:cyclop,funlen,gocognit,gocyclo // Login orchestration keeps security-sensitive state transitions explicit.
	if dependencies.client == nil {
		dependencies.client = newLoginHTTPClient()
	}
	if dependencies.listen == nil {
		dependencies.listen = net.Listen
	}
	if dependencies.openBrowser == nil {
		dependencies.openBrowser = openBrowserURL
	}
	if dependencies.callbackTimeout <= 0 {
		dependencies.callbackTimeout = defaultLoginCallbackTimeout
	}
	if dependencies.browserLaunchTimeout <= 0 {
		dependencies.browserLaunchTimeout = defaultBrowserLaunchTimeout
	}
	if dependencies.now == nil {
		dependencies.now = time.Now
	}

	configPath := globalConfigPath
	if configPath == "" {
		configPath = defaultConfigPath()
	}
	cfg, err := loadConfig(configPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	server := cfg.Server
	if globalServer != "" {
		server = globalServer
	}
	if server == "" {
		return errors.New("server URL is not configured; use --server")
	}
	server, err = validateServerURL(server)
	if err != nil {
		return err
	}

	listener, err := dependencies.listen("tcp", loginCallbackAddress)
	if err != nil {
		return fmt.Errorf("login callback URI %s is unavailable", loginCallbackURI)
	}

	login, err := requestLogin(ctx, dependencies.client, server, loginCallbackURI)
	if err != nil {
		if closeErr := listener.Close(); closeErr != nil {
			return errors.New("close login callback listener failed")
		}
		if ctx.Err() != nil {
			return fmt.Errorf("login canceled: %w", ctx.Err())
		}
		return err
	}
	if err := validateBrowserURL(login.URL); err != nil {
		if closeErr := listener.Close(); closeErr != nil {
			return errors.New("close login callback listener failed")
		}
		return errors.New("login provider returned an invalid authorization URL")
	}

	callback := newLoginCallbackServer(listener, login.State)
	defer callback.shutdown(ctx)

	browserCtx, browserCancel := context.WithTimeout(ctx, dependencies.browserLaunchTimeout)
	openResult := make(chan error, 1)
	go func() {
		openResult <- dependencies.openBrowser(browserCtx, login.URL)
	}()
	browserAttemptFinished := false
	defer func() {
		browserCancel()
		if browserAttemptFinished {
			return
		}
		grace := time.NewTimer(loginBrowserResultGrace)
		defer grace.Stop()
		select {
		case <-openResult:
			browserAttemptFinished = true
		case <-grace.C:
		}
	}()
	var browserOutputErr error
	reportBrowserResult := func(wait bool) {
		if browserAttemptFinished {
			return
		}
		report := func(openErr error) {
			browserAttemptFinished = true
			if openErr != nil {
				if _, writeErr := fmt.Fprintf(writer, "Open this URL to log in:\n%s\n", login.URL); writeErr != nil {
					browserOutputErr = errors.New("write login output failed")
				}
			}
		}
		if !wait {
			select {
			case openErr := <-openResult:
				report(openErr)
			default:
			}
			return
		}
		grace := time.NewTimer(loginBrowserResultGrace)
		defer grace.Stop()
		select {
		case openErr := <-openResult:
			report(openErr)
		case <-grace.C:
		}
	}

	timer := time.NewTimer(dependencies.callbackTimeout)
	defer timer.Stop()
	for {
		select {
		case event := <-callback.events:
			if event.err != nil {
				callback.complete(loginCallbackResult{})
				reportBrowserResult(true)
				return event.err
			}
			token, exchangeErr := exchangeLoginCode(ctx, dependencies.client, server, tokenRequest{
				Code:         event.code,
				CodeVerifier: login.CodeVerifier,
				RedirectURI:  loginCallbackURI,
			})
			if exchangeErr != nil {
				callback.complete(loginCallbackResult{})
				reportBrowserResult(true)
				if ctx.Err() != nil {
					return fmt.Errorf("login canceled: %w", ctx.Err())
				}
				return errAuthenticationFailed
			}
			expiresAt, identity, parseErr := parseLoginIDToken(token.IDToken, dependencies.now())
			if parseErr != nil {
				callback.complete(loginCallbackResult{})
				reportBrowserResult(true)
				return errAuthenticationFailed
			}
			cfg.Server = server
			cfg.Token = token.IDToken
			cfg.TokenExpiresAt = expiresAt
			if saveErr := cfg.Save(configPath); saveErr != nil {
				callback.complete(loginCallbackResult{})
				reportBrowserResult(true)
				return errors.New("save login configuration failed")
			}
			callback.complete(loginCallbackResult{success: true})
			reportBrowserResult(true)
			if browserOutputErr != nil {
				return browserOutputErr
			}
			if identity != "" {
				if _, writeErr := fmt.Fprintf(writer, "Logged in as %s\n", identity); writeErr != nil {
					return errors.New("write login output failed")
				}
			} else {
				if _, writeErr := fmt.Fprintln(writer, "Logged in"); writeErr != nil {
					return errors.New("write login output failed")
				}
			}
			return nil
		case openErr := <-openResult:
			browserAttemptFinished = true
			if openErr != nil {
				if _, writeErr := fmt.Fprintf(writer, "Open this URL to log in:\n%s\n", login.URL); writeErr != nil {
					browserOutputErr = errors.New("write login output failed")
				}
			}
		case <-timer.C:
			callback.complete(loginCallbackResult{})
			return errors.New("login timed out waiting for browser callback")
		case <-ctx.Done():
			callback.complete(loginCallbackResult{})
			return fmt.Errorf("login canceled: %w", ctx.Err())
		}
	}
}

func validateServerURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("invalid server URL")
	}
	if !isAllowedWebScheme(parsed) {
		return "", errors.New("server URL must use HTTPS (HTTP is allowed only for loopback servers)")
	}
	return parsed.String(), nil
}

func validateBrowserURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" || parsed.User != nil || !isAllowedWebScheme(parsed) {
		return errors.New("invalid browser URL")
	}
	return nil
}

func isAllowedWebScheme(parsed *url.URL) bool {
	if parsed.Scheme == "https" {
		return true
	}
	if parsed.Scheme != "http" {
		return false
	}
	hostname := strings.ToLower(parsed.Hostname())
	return hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1"
}

func openBrowserURL(ctx context.Context, rawURL string) error {
	if err := validateBrowserURL(rawURL); err != nil {
		return err
	}
	var command string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		command = "open"
		args = []string{"--", rawURL}
	case "windows":
		command = "rundll32"
		args = []string{"url.dll,FileProtocolHandler", rawURL}
	default:
		command = "xdg-open"
		args = []string{rawURL}
	}
	// #nosec G204 -- command is selected from a static per-OS allowlist and the URL is validated.
	cmd := exec.CommandContext(ctx, command, args...)
	if err := cmd.Run(); err != nil {
		return errors.New("open browser failed")
	}
	return nil
}

func parseLoginIDToken(raw string, now time.Time) (time.Time, string, error) { //nolint:cyclop // Claim decoding intentionally rejects every malformed form explicitly.
	// The API has already validated this ID token. Parsing here only derives the
	// persisted expiry and the identity displayed by the CLI.
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return time.Time{}, "", errAuthenticationFailed
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(payload) > maxLoginResponseSize {
		return time.Time{}, "", errAuthenticationFailed
	}
	var claims struct {
		ExpiresAt         json.RawMessage `json:"exp"`
		Email             string          `json:"email"`
		PreferredUsername string          `json:"preferred_username"` //nolint:tagliatelle // Standard OIDC claim name.
		Subject           string          `json:"sub"`
	}
	if decodeErr := json.Unmarshal(payload, &claims); decodeErr != nil || len(claims.ExpiresAt) == 0 {
		return time.Time{}, "", errAuthenticationFailed
	}
	decoder := json.NewDecoder(strings.NewReader(string(claims.ExpiresAt)))
	decoder.UseNumber()
	var expValue any
	if decodeErr := decoder.Decode(&expValue); decodeErr != nil {
		return time.Time{}, "", errAuthenticationFailed
	}
	expNumber, ok := expValue.(json.Number)
	if !ok {
		return time.Time{}, "", errAuthenticationFailed
	}
	expSeconds, err := expNumber.Int64()
	if err != nil {
		return time.Time{}, "", errAuthenticationFailed
	}
	expiresAt := time.Unix(expSeconds, 0).UTC()
	if !expiresAt.After(now) {
		return time.Time{}, "", errAuthenticationFailed
	}
	identity := claims.Email
	if identity == "" {
		identity = claims.PreferredUsername
	}
	if identity == "" {
		identity = claims.Subject
	}
	return expiresAt, sanitizeLoginIdentity(identity), nil
}

func sanitizeLoginIdentity(identity string) string {
	var display strings.Builder
	display.Grow(min(len(identity), maxLoginIdentityDisplayBytes))
	for identity != "" {
		r, size := utf8.DecodeRuneInString(identity)
		identity = identity[size:]
		var rendered string
		if r < 0x20 || (r >= 0x7f && r <= 0x9f) {
			rendered = fmt.Sprintf("\\u%04X", r)
		} else {
			rendered = string(r)
		}
		if display.Len()+len(rendered) > maxLoginIdentityDisplayBytes {
			break
		}
		display.WriteString(rendered)
	}
	return display.String()
}
