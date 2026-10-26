package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/cache"
)

const (
	nativeGatewayContractIssuer   = "https://observe-contract.example.invalid"
	nativeGatewayContractRedirect = "http://127.0.0.1:18791/contract-callback"
	// Public RFC 7636 example, never a user credential or an external login.
	nativeGatewayContractVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	nativeGatewayContractState    = "fixed-nonsecret-constructor-contract-state"
)

// TestObservabilityGatewayNativeOAuthConstructorContract exercises the actual
// constructor, console authenticator, OAuth routes, gateway mux and request
// limiter together. No authenticator is replaced with a principal stub. The
// only Kubernetes client is an empty fake, OIDC is absent, and the sole invoked
// tool reads the static provider-type catalog without contacting a provider.
func TestObservabilityGatewayNativeOAuthConstructorContract(t *testing.T) {
	for _, protocolVersion := range []string{"2025-03-26", "2025-11-25"} {
		t.Run(protocolVersion, func(t *testing.T) {
			testObservabilityGatewayNativeOAuthConstructorContract(t, protocolVersion)
		})
	}
}

func testObservabilityGatewayNativeOAuthConstructorContract(t *testing.T, protocolVersion string) {
	t.Helper()
	secret := []byte("fixed-nonsecret-native-gateway-contract-key")
	cfg := &cliConfig{
		AuthEnabled: true, MCPPublicURL: nativeGatewayContractIssuer,
		MCPAccessTokenTTL: time.Minute, MCPRefreshTokenTTL: time.Hour,
	}
	require.NoError(t, validateObservabilityGatewayConfig(cfg))
	store, err := cache.New(t.Context(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	kube := fake.NewClientBuilder().WithScheme(newScheme()).Build()
	srv, authenticator, usage, backend, err := buildObservabilityServer(t.Context(), cfg,
		auth.Config{Enabled: true, TokenSecret: secret}, kube, store)
	require.NoError(t, err)
	mux := buildObservabilityMux(srv, authenticator, cfg.MCPPublicURL, usage, backend)

	// The gate is dormant through OAuth and the protocol flow. Later it holds
	// four real protocol responses in Write, inside the production limiter,
	// proving response serialization retains those request slots.
	var holdProtocolWrites atomic.Bool
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseWriters := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseWriters()
	handler := limitObservabilityProtocolRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/observe/mcp" && holdProtocolWrites.Load() {
			w = &nativeGatewayContractBlockedWriter{ResponseWriter: w, entered: entered, release: release}
		}
		mux.ServeHTTP(w, r)
	}))
	httpServer := httptest.NewServer(handler)
	t.Cleanup(httpServer.Close)
	client := httpServer.Client()
	client.Timeout = 5 * time.Second
	// OAuth redirects are parsed in memory. Never follow a callback or the
	// configured public issuer, even though both are nonsecret test values.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	httpFlow := nativeGatewayContractHTTP{client: client, baseURL: httpServer.URL, protocolVersion: protocolVersion}

	registered := httpFlow.mustJSON(t, http.MethodPost, "/observe/register", "", map[string]any{
		"redirect_uris": []string{nativeGatewayContractRedirect},
		"client_name":   "native-constructor-contract", "token_endpoint_auth_method": "none",
	})
	require.Equal(t, http.StatusCreated, registered.status)
	//nolint:tagliatelle // RFC 7591 wire names.
	var registration struct {
		ClientID     string   `json:"client_id"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	require.NoError(t, json.Unmarshal(registered.body, &registration))
	require.NotEmpty(t, registration.ClientID)
	require.Equal(t, []string{nativeGatewayContractRedirect}, registration.RedirectURIs)

	digest := sha256.Sum256([]byte(nativeGatewayContractVerifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	resource := nativeGatewayContractIssuer + "/observe/mcp"
	query := url.Values{
		"client_id": {registration.ClientID}, "response_type": {"code"},
		"redirect_uri": {nativeGatewayContractRedirect}, "scope": {string(mcp.ScopeObserve)},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"},
		"state": {nativeGatewayContractState}, "resource": {resource, resource},
	}
	require.Len(t, query["resource"], 2, "the browser request must carry both resource values")
	browser := httpFlow.mustRequest(t, nativeGatewayContractRequest{
		method: http.MethodGet, path: "/observe/authorize?" + query.Encode(),
		accept: "text/html,application/xhtml+xml",
	})
	require.Equal(t, http.StatusFound, browser.status)
	consentLocation, err := url.Parse(browser.header.Get("Location"))
	require.NoError(t, err)
	require.Empty(t, consentLocation.Host)
	require.Equal(t, "/observe/consent", consentLocation.Path)
	require.Len(t, consentLocation.Query(), 1, "the anonymous redirect exposes only an opaque rid")
	rid := consentLocation.Query().Get("rid")
	require.NotEmpty(t, rid)

	// This is the production console HMAC minter and audience; an observe
	// token does not exist until after explicit consent and PKCE redemption.
	consoleToken, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject: "native-contract-user", Email: "native-contract@example.invalid", Name: "Contract User",
		Audience: auth.ConsoleAPIAudience, TTL: time.Minute, Secret: secret,
	})
	require.NoError(t, err)
	pendingPath := "/observe/authorize/pending?rid=" + url.QueryEscape(rid)
	unauthenticatedPending := httpFlow.mustJSON(t, http.MethodGet, pendingPath, "", nil)
	require.Equal(t, http.StatusUnauthorized, unauthenticatedPending.status)
	pendingResponse := httpFlow.mustJSON(t, http.MethodGet, pendingPath, consoleToken, nil)
	require.Equal(t, http.StatusOK, pendingResponse.status,
		"identical duplicate resource values must survive anonymous browser authorization")
	//nolint:tagliatelle // OAuth pending and consent use RFC 6749 wire names.
	var pending struct {
		ClientID            string `json:"client_id"`
		RedirectURI         string `json:"redirect_uri"`
		CodeChallenge       string `json:"code_challenge"`
		CodeChallengeMethod string `json:"code_challenge_method"`
		State               string `json:"state"`
		Scope               string `json:"scope"`
	}
	require.NoError(t, json.Unmarshal(pendingResponse.body, &pending))
	require.Equal(t, registration.ClientID, pending.ClientID)
	require.Equal(t, nativeGatewayContractRedirect, pending.RedirectURI)
	require.Equal(t, challenge, pending.CodeChallenge)
	require.Equal(t, "S256", pending.CodeChallengeMethod)
	require.Equal(t, nativeGatewayContractState, pending.State)
	require.Equal(t, string(mcp.ScopeObserve), pending.Scope)
	approved := httpFlow.mustJSON(t, http.MethodPost, "/observe/authorize/consent", consoleToken, map[string]any{
		"client_id": pending.ClientID, "redirect_uri": pending.RedirectURI,
		"code_challenge": pending.CodeChallenge, "code_challenge_method": pending.CodeChallengeMethod,
		"state": pending.State, "scopes": []string{string(mcp.ScopeObserve)}, "decision": "approve",
	})
	require.Equal(t, http.StatusOK, approved.status)
	require.Equal(t, "no-store", approved.header.Get("Cache-Control"))
	var handoff struct {
		RedirectTo string `json:"redirectTo"`
	}
	require.NoError(t, json.Unmarshal(approved.body, &handoff))
	callback, err := url.Parse(handoff.RedirectTo)
	require.NoError(t, err)
	require.Equal(t, "127.0.0.1:18791", callback.Host)
	require.Equal(t, "/contract-callback", callback.Path)
	require.Equal(t, nativeGatewayContractState, callback.Query().Get("state"))
	code := callback.Query().Get("code")
	require.NotEmpty(t, code)

	form := url.Values{
		"grant_type": {"authorization_code"}, "client_id": {registration.ClientID},
		"code": {code}, "redirect_uri": {nativeGatewayContractRedirect},
		"code_verifier": {nativeGatewayContractVerifier}, "resource": {resource, resource},
	}
	require.Len(t, form["resource"], 2, "the token form must carry both resource values")
	tokenResponse := httpFlow.mustRequest(t, nativeGatewayContractRequest{
		method: http.MethodPost, path: "/observe/token", body: []byte(form.Encode()),
		contentType: "application/x-www-form-urlencoded", accept: "application/json",
	})
	require.Equal(t, http.StatusOK, tokenResponse.status)
	require.Equal(t, "no-store", tokenResponse.header.Get("Cache-Control"))
	//nolint:tagliatelle // RFC 6749 token response wire names.
	var pair struct {
		AccessToken  string `json:"access_token"`  // #nosec G117 -- Decode the RFC 6749 response from the isolated test server to verify authentication.
		RefreshToken string `json:"refresh_token"` // #nosec G117 -- Decode the RFC 6749 response from the isolated test server to verify token issuance.
		TokenType    string `json:"token_type"`
		Scope        string `json:"scope"`
	}
	require.NoError(t, json.Unmarshal(tokenResponse.body, &pair))
	require.NotEmpty(t, pair.AccessToken)
	require.NotEmpty(t, pair.RefreshToken)
	require.Equal(t, "Bearer", pair.TokenType)
	require.Equal(t, string(mcp.ScopeObserve), pair.Scope)
	verification := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/observe/mcp", http.NoBody)
	verification.Header.Set("Authorization", "Bearer "+pair.AccessToken)
	principal, err := authenticator.Authenticate(auth.WithRequest(t.Context(), verification))
	require.NoError(t, err)
	require.Equal(t, "native-contract-user", principal.Subject)
	require.Equal(t, []string{string(mcp.ScopeObserve)}, principal.Scopes)

	// Legacy native HTTP requests carry the negotiated MCP-Protocol-Version
	// and accept only JSON, with no Origin or modern Mcp-Method/Mcp-Name
	// headers. Every protocol step reuses the SAME access token returned by
	// this constructor's real consent/code flow.
	initialized := httpFlow.mustJSON(t, http.MethodPost, "/observe/mcp", pair.AccessToken, map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{
			"protocolVersion": protocolVersion, "capabilities": map[string]any{},
			"clientInfo": map[string]any{"name": "native-constructor-contract", "version": "1"},
		},
	})
	var initializeResult struct {
		ProtocolVersion string `json:"protocolVersion"`
		Capabilities    struct {
			Tools json.RawMessage `json:"tools"`
		} `json:"capabilities"`
	}
	nativeGatewayContractDecodeRPC(t, initialized, 1, &initializeResult)
	require.Equal(t, protocolVersion, initializeResult.ProtocolVersion)
	require.NotEmpty(t, initializeResult.Capabilities.Tools)
	notification := httpFlow.mustJSON(t, http.MethodPost, "/observe/mcp", pair.AccessToken, map[string]any{
		"jsonrpc": "2.0", "method": "notifications/initialized", "params": map[string]any{},
	})
	require.Equal(t, http.StatusAccepted, notification.status)
	require.Empty(t, notification.body)
	listed := httpFlow.mustJSON(t, http.MethodPost, "/observe/mcp", pair.AccessToken, map[string]any{
		"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": map[string]any{},
	})
	var inventory struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
		NextCursor string `json:"nextCursor"`
	}
	nativeGatewayContractDecodeRPC(t, listed, 2, &inventory)
	require.Len(t, inventory.Tools, 14)
	require.Empty(t, inventory.NextCursor)
	names := make([]string, 0, len(inventory.Tools))
	for _, tool := range inventory.Tools {
		names = append(names, tool.Name)
	}
	require.ElementsMatch(t, []string{
		"list_observability_providers", "get_observability_provider", "query_metrics", "query_logs", "query_traces",
		"list_provider_types", "describe_provider_type", "validate_provider", "list_metric_names", "list_metric_series", "list_label_names",
		"list_label_values", "get_metric_metadata", "list_trace_services",
	}, names)
	staticCall := nativeGatewayContractStaticCallBody(t, 3)
	called := httpFlow.mustRequest(t, nativeGatewayContractRequest{
		method: http.MethodPost, path: "/observe/mcp", token: pair.AccessToken,
		body: staticCall, contentType: "application/json", accept: "application/json",
	})
	require.NoError(t, nativeGatewayContractStaticResult(called, 3))
	snapshot := usage.Snapshot()
	require.Len(t, snapshot.Tools, 1)
	require.Equal(t, "list_provider_types", snapshot.Tools[0].Name)
	require.Equal(t, uint64(1), snapshot.Tools[0].Calls)

	t.Run("constructor rejects wrong issuer and audience", func(t *testing.T) {
		for _, claims := range []struct {
			name, issuer, audience string
		}{
			{name: "wrong issuer", issuer: "https://other-contract.example.invalid", audience: mcp.ObservabilityTokenAudience},
			{name: "wrong audience", issuer: nativeGatewayContractIssuer, audience: mcp.MCPTokenAudience},
		} {
			t.Run(claims.name, func(t *testing.T) {
				wrongToken, tokenErr := auth.IssueTokenWithOptions(auth.TokenOptions{
					Subject: "native-contract-user", Issuer: claims.issuer, Audience: claims.audience,
					Scope: string(mcp.ScopeObserve), TTL: time.Minute, Secret: secret,
				})
				require.NoError(t, tokenErr)
				response := httpFlow.mustRequest(t, nativeGatewayContractRequest{
					method: http.MethodPost, path: "/observe/mcp", token: wrongToken,
					body: staticCall, contentType: "application/json", accept: "application/json",
				})
				require.Equal(t, http.StatusUnauthorized, response.status)
				require.Contains(t, response.header.Get("WWW-Authenticate"),
					nativeGatewayContractIssuer+"/observe/.well-known/oauth-protected-resource")
			})
		}
	})

	t.Run("four constructed protocol responses retain their slots", func(t *testing.T) {
		holdProtocolWrites.Store(true)
		t.Cleanup(releaseWriters)
		completed := make(chan error, 4)
		for range 4 {
			go func() {
				response, requestErr := httpFlow.request(t.Context(), nativeGatewayContractRequest{
					method: http.MethodPost, path: "/observe/mcp", token: pair.AccessToken,
					body: staticCall, contentType: "application/json", accept: "application/json",
				})
				if requestErr == nil {
					requestErr = nativeGatewayContractStaticResult(response, 3)
				}
				completed <- requestErr
			}()
		}
		deadline := time.NewTimer(3 * time.Second)
		defer deadline.Stop()
		for range 4 {
			select {
			case <-entered:
			case <-deadline.C:
				t.Fatal("four real gateway protocol responses did not enter their final write")
			}
		}
		saturated := httpFlow.mustRequest(t, nativeGatewayContractRequest{
			method: http.MethodPost, path: "/observe/mcp", token: pair.AccessToken,
			body: staticCall, contentType: "application/json", accept: "application/json",
		})
		require.Equal(t, http.StatusTooManyRequests, saturated.status)
		require.Equal(t, "1", saturated.header.Get("Retry-After"))
		health := httpFlow.mustJSON(t, http.MethodGet, "/healthz", "", nil)
		require.Equal(t, http.StatusOK, health.status)
		metadata := httpFlow.mustJSON(t, http.MethodGet, "/observe/.well-known/oauth-protected-resource", "", nil)
		require.Equal(t, http.StatusOK, metadata.status)
		holdProtocolWrites.Store(false)
		releaseWriters()
		for range 4 {
			select {
			case requestErr := <-completed:
				require.NoError(t, requestErr)
			case <-time.After(3 * time.Second):
				t.Fatal("released contract request did not finish")
			}
		}
		reused := httpFlow.mustRequest(t, nativeGatewayContractRequest{
			method: http.MethodPost, path: "/observe/mcp", token: pair.AccessToken,
			body: staticCall, contentType: "application/json", accept: "application/json",
		})
		require.NoError(t, nativeGatewayContractStaticResult(reused, 3))
	})
}

type nativeGatewayContractRequest struct {
	method, path, token, contentType, accept string
	body                                     []byte
}

type nativeGatewayContractResponse struct {
	status int
	header http.Header
	body   []byte
}

type nativeGatewayContractHTTP struct {
	client                   *http.Client
	baseURL, protocolVersion string
}

func (h nativeGatewayContractHTTP) request(ctx context.Context, in nativeGatewayContractRequest) (nativeGatewayContractResponse, error) {
	req, err := http.NewRequestWithContext(ctx, in.method, h.baseURL+in.path, bytes.NewReader(in.body))
	if err != nil {
		return nativeGatewayContractResponse{}, errors.New("construct local contract request")
	}
	if in.token != "" {
		req.Header.Set("Authorization", "Bearer "+in.token)
	}
	if in.contentType != "" {
		req.Header.Set("Content-Type", in.contentType)
	}
	if in.accept != "" {
		req.Header.Set("Accept", in.accept)
	}
	if in.path == "/observe/mcp" {
		req.Header.Set("MCP-Protocol-Version", h.protocolVersion)
	}
	resp, err := h.client.Do(req) // #nosec G704 -- The contract harness uses only its local httptest server URL.
	if err != nil {
		return nativeGatewayContractResponse{}, errors.New("local contract HTTP request failed")
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		return nativeGatewayContractResponse{}, errors.New("contract response unreadable or over bounded size")
	}
	return nativeGatewayContractResponse{status: resp.StatusCode, header: resp.Header.Clone(), body: body}, nil
}

func (h nativeGatewayContractHTTP) mustRequest(t *testing.T, in nativeGatewayContractRequest) nativeGatewayContractResponse {
	t.Helper()
	response, err := h.request(t.Context(), in)
	require.NoError(t, err)
	return response
}

func (h nativeGatewayContractHTTP) mustJSON(t *testing.T, method, path, token string, payload any) nativeGatewayContractResponse {
	t.Helper()
	var body []byte
	if payload != nil {
		var err error
		body, err = json.Marshal(payload)
		require.NoError(t, err)
	}
	return h.mustRequest(t, nativeGatewayContractRequest{
		method: method, path: path, token: token, body: body,
		contentType: "application/json", accept: "application/json",
	})
}

func nativeGatewayContractDecodeRPC(t *testing.T, response nativeGatewayContractResponse, id int, result any) {
	t.Helper()
	require.NoError(t, nativeGatewayContractRPCResult(response, id, result))
}

func nativeGatewayContractRPCResult(response nativeGatewayContractResponse, id int, result any) error {
	if response.status != http.StatusOK {
		return errors.New("contract protocol response was not HTTP 200")
	}
	var envelope struct {
		Version string          `json:"jsonrpc"`
		ID      int             `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   json.RawMessage `json:"error"`
	}
	if json.Unmarshal(response.body, &envelope) != nil || envelope.Version != "2.0" || envelope.ID != id {
		return errors.New("contract protocol response had an invalid JSON-RPC envelope")
	}
	if len(envelope.Error) != 0 && string(envelope.Error) != "null" {
		return errors.New("contract protocol response returned a JSON-RPC error")
	}
	if len(envelope.Result) == 0 || string(envelope.Result) == "null" || json.Unmarshal(envelope.Result, result) != nil {
		return errors.New("contract protocol response had no valid JSON-RPC result")
	}
	return nil
}

// This pure decoder is also used by concurrent callers: no require(t), raw
// error payload, response body, or token may escape a worker goroutine.
func nativeGatewayContractStaticResult(response nativeGatewayContractResponse, id int) error {
	var callResult struct {
		IsError           bool `json:"isError"`
		StructuredContent struct {
			Types []struct {
				Type string `json:"type"`
			} `json:"types"`
			ObservedAt string `json:"observedAt"`
		} `json:"structuredContent"`
	}
	if err := nativeGatewayContractRPCResult(response, id, &callResult); err != nil {
		return err
	}
	if callResult.IsError || len(callResult.StructuredContent.Types) != 13 {
		return errors.New("contract static tool result was erroneous or had an incomplete catalog")
	}
	seen := make(map[string]struct{}, 13)
	for _, item := range callResult.StructuredContent.Types {
		if item.Type == "" {
			return errors.New("contract static catalog contained an empty provider type")
		}
		if _, duplicate := seen[item.Type]; duplicate {
			return errors.New("contract static catalog contained a duplicate provider type")
		}
		seen[item.Type] = struct{}{}
	}
	if _, err := time.Parse(time.RFC3339Nano, callResult.StructuredContent.ObservedAt); err != nil {
		return errors.New("contract static tool result had no valid observation timestamp")
	}
	return nil
}

func nativeGatewayContractStaticCallBody(t *testing.T, id int) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": map[string]any{
			"name": "list_provider_types", "arguments": map[string]any{},
		},
	})
	require.NoError(t, err)
	return body
}

type nativeGatewayContractBlockedWriter struct {
	http.ResponseWriter
	entered chan<- struct{}
	release <-chan struct{}
	once    sync.Once
}

func (w *nativeGatewayContractBlockedWriter) Write(body []byte) (int, error) {
	w.once.Do(func() {
		w.entered <- struct{}{}
		<-w.release
	})
	return w.ResponseWriter.Write(body)
}

func (w *nativeGatewayContractBlockedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
