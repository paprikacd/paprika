package httphelp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestParseConfig(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		config        string
		want          Config
		wantErr       string
		notConfigured bool
	}{
		{name: "https endpoint", config: `{"endpoint":"https://mimir.example.com"}`, want: Config{Endpoint: "https://mimir.example.com"}},
		{name: "http endpoint with base path and trailing slash", config: `{"endpoint":"http://proxy:8080/obs/"}`, want: Config{Endpoint: "http://proxy:8080/obs/"}},
		{name: "headers and insecureSkipTLS", config: `{"endpoint":"https://mimir.example.com","headers":{"X-Scope-OrgID":"tenant-a"},"insecureSkipTLS":true}`, want: Config{
			Endpoint:        "https://mimir.example.com",
			Headers:         map[string]string{"X-Scope-OrgID": "tenant-a"},
			InsecureSkipTLS: true,
		}},
		{name: "empty document", config: ``, notConfigured: true},
		// Unknown keys are reported before the missing-endpoint check: a
		// document with only known keys either carries the endpoint or is
		// the empty object.
		{name: "unknown key alongside missing endpoint", config: `{"limit":10}`, wantErr: `unknown key "limit"`},
		{name: "empty object", config: `{}`, notConfigured: true},
		{name: "unknown key", config: `{"endpont":"https://x.example.com"}`, wantErr: `unknown key "endpont"`},
		{name: "prometheus-only step is unknown here", config: `{"endpoint":"https://x.example.com","step":"15s"}`, wantErr: `unknown key "step"`},
		{name: "endpoint not a string", config: `{"endpoint":8080}`, wantErr: `key "endpoint" must be a string`},
		{name: "endpoint not a URL", config: `{"endpoint":"not a url"}`, wantErr: `key "endpoint" must be an absolute http(s) URL`},
		{name: "unsupported scheme", config: `{"endpoint":"ftp://example.com"}`, wantErr: `key "endpoint" must be an absolute http(s) URL`},
		{name: "relative reference", config: `{"endpoint":"/api"}`, wantErr: `key "endpoint" must be an absolute http(s) URL`},
		{name: "headers not an object", config: `{"endpoint":"https://x.example.com","headers":"nope"}`, wantErr: `key "headers" must be an object of string values`},
		{name: "insecureSkipTLS not a bool", config: `{"endpoint":"https://x.example.com","insecureSkipTLS":"yes"}`, wantErr: `key "insecureSkipTLS" must be a bool`},
		{name: "invalid JSON", config: `{`, wantErr: "invalid JSON document"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := ParseConfig(json.RawMessage(tt.config))
			if tt.notConfigured {
				require.ErrorIs(t, err, connector.ErrNotConfigured)
				return
			}
			if tt.wantErr != "" {
				require.ErrorContains(t, err, tt.wantErr)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.want, got)
		})
	}
}

func TestEndpointRejectsEmbeddedCredentialsAndURLSuffixes(t *testing.T) {
	t.Parallel()
	for _, endpoint := range []string{"https://user:never-echo@example.com", "https://example.com?key=never-echo", "https://example.com#never-echo"} {
		config, err := json.Marshal(map[string]string{"endpoint": endpoint})
		require.NoError(t, err)
		_, err = ParseConfig(config)
		require.Error(t, err)
		require.NotContains(t, err.Error(), "never-echo")
	}
}

func TestConfigRejectsInlineCredentialHeaders(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"Authorization", "aUtHoRiZaTiOn", "Proxy-Authorization", "Cookie", "X-Api-Key", "X-Goog-Api-Key", "X-Auth-Token"} {
		config, err := json.Marshal(map[string]any{"endpoint": "https://example.com", "headers": map[string]string{name: "never-echo-secret"}})
		require.NoError(t, err)
		_, err = ParseConfig(config)
		require.ErrorContains(t, err, "credentialsSecretRef")
		require.NotContains(t, err.Error(), "never-echo-secret")
	}
}

func TestGetDoesNotForwardCredentialsOrTenantHeadersThroughRedirect(t *testing.T) {
	t.Parallel()
	var followed atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		followed.Add(1)
		fmt.Fprint(w, `{}`)
	}))
	t.Cleanup(target.Close)
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirect.Close)
	_, err := Get(context.Background(), Config{Endpoint: redirect.URL, Headers: map[string]string{"X-Scope-OrgID": "private-tenant"}}, "/query", nil, []byte("private-token"))
	require.ErrorContains(t, err, "backend returned status 307")
	require.Zero(t, followed.Load())
}

func TestReadRequestRetriesTransientStatusesAndReplaysReadPOST(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.Equal(t, "bounded", body["filter"])
		if calls.Add(1) < 3 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		fmt.Fprint(w, `{}`)
	}))
	t.Cleanup(server.Close)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, server.URL, strings.NewReader(`{"filter":"bounded"}`))
	require.NoError(t, err)
	resp, err := DoReadRequest(req, server.Client())
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.EqualValues(t, 3, calls.Load())
}

func TestGetRetryBudgetAndCancellation(t *testing.T) {
	t.Parallel()
	for _, status := range []int{http.StatusUnauthorized, http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			t.Parallel()
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if status == http.StatusTooManyRequests {
					w.Header().Set("Retry-After", "120")
				}
				w.WriteHeader(status)
			}))
			t.Cleanup(server.Close)
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			_, err := Get(ctx, Config{Endpoint: server.URL}, "/query", nil, nil)
			require.Error(t, err)
			require.EqualValues(t, 1, calls.Load())
			if status == http.StatusServiceUnavailable {
				require.ErrorIs(t, err, context.DeadlineExceeded)
			}
		})
	}
}

func TestGetCapsTransientRetries(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(server.Close)
	_, err := Get(context.Background(), Config{Endpoint: server.URL}, "/query", nil, nil)
	require.ErrorContains(t, err, "backend returned status 502")
	require.EqualValues(t, 3, calls.Load())
}

func TestParseConfigHeaders(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		headers string
		want    map[string]string
		wantErr string
	}{
		{
			name:    "tenant headers with an empty value",
			headers: `{"X-Scope-OrgID":"tenant-a","X-Custom":""}`,
			want:    map[string]string{"X-Scope-OrgID": "tenant-a", "X-Custom": ""},
		},
		{name: "empty object", headers: `{}`, want: map[string]string{}},
		{name: "empty name", headers: `{"":"v"}`, wantErr: `key "headers" names must be valid header field names`},
		{name: "name with space", headers: `{"X Bad":"v"}`, wantErr: `key "headers" names must be valid header field names`},
		{name: "CRLF injection in value", headers: `{"X-Test":"ok\r\nX-Injected: 1"}`, wantErr: `key "headers" values must be valid header values`},
		{name: "bare newline in value", headers: `{"X-Test":"ok\n1"}`, wantErr: `key "headers" values must be valid header values`},
		{name: "too many entries", headers: overCountHeaders(t), wantErr: `key "headers" allows at most 16 entries`},
		{name: "combined size over budget", headers: overSizeHeaders(t), wantErr: `key "headers" entries combined exceed the 4096 byte budget`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			cfg, err := ParseConfig(json.RawMessage(`{"endpoint":"https://mimir.example.com","headers":` + tt.headers + `}`))
			if tt.wantErr != "" {
				require.ErrorContains(t, err, tt.wantErr)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.want, cfg.Headers)
			require.False(t, cfg.InsecureSkipTLS)
		})
	}
}

// overCountHeaders builds a headers document with one entry more than the
// count cap allows.
func overCountHeaders(t *testing.T) string {
	t.Helper()
	entries := make(map[string]string, 17)
	for i := range 17 {
		entries[fmt.Sprintf("X-H%02d", i)] = "v"
	}
	raw, err := json.Marshal(entries)
	require.NoError(t, err)
	return string(raw)
}

// overSizeHeaders builds a headers document within the count cap but over
// the combined-size budget.
func overSizeHeaders(t *testing.T) string {
	t.Helper()
	entries := map[string]string{"X-Big": strings.Repeat("v", maxConfigHeaderBytes)}
	raw, err := json.Marshal(entries)
	require.NoError(t, err)
	return string(raw)
}

func TestParseConfigWithKeys(t *testing.T) {
	t.Parallel()

	// The extra key passes strictness and is left undecoded for the caller.
	cfg, err := ParseConfigWithKeys(json.RawMessage(`{"endpoint":"https://prom.example.com","step":"15s"}`), []string{"step"})
	require.NoError(t, err)
	require.Equal(t, "https://prom.example.com", cfg.Endpoint)
	require.Empty(t, cfg.Headers)
	require.False(t, cfg.InsecureSkipTLS)

	// Keys outside the shared set and the extras stay errors.
	_, err = ParseConfigWithKeys(json.RawMessage(`{"endpoint":"https://prom.example.com","step":"15s","limits":"10"}`), []string{"step"})
	require.ErrorContains(t, err, `unknown key "limits"`)
}

func TestParseConfigNeverEchoesCredentialMaterial(t *testing.T) {
	t.Parallel()
	// A URL whose host cannot parse: the raw value embeds userinfo, and the
	// error must not quote it back.
	_, err := ParseConfig(json.RawMessage(`{"endpoint":"https://user:secret@[::1"}`))
	require.Error(t, err)
	require.NotContains(t, err.Error(), "user:secret")
	require.Contains(t, err.Error(), `"endpoint"`)
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()
	require.NoError(t, ValidateConfig(json.RawMessage(`{"endpoint":"https://loki.example.com"}`)))
	require.ErrorIs(t, ValidateConfig(json.RawMessage(`{}`)), connector.ErrNotConfigured)
	require.ErrorContains(t, ValidateConfig(json.RawMessage(`{"endpointz":"https://x"}`)), `unknown key "endpointz"`)
}

func TestGetResponseHandling(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		status   int
		body     string
		want     string // exact JSON body expected on success
		wantIs   error  // sentinel the error must wrap
		wantText string // exact sanitized error text
	}{
		{name: "JSON passthrough", status: http.StatusOK, body: `{"data":[1,2]}`, want: `{"data":[1,2]}`},
		{name: "non-JSON wrapped raw", status: http.StatusOK, body: `plain text answer`, want: `{"raw":"plain text answer"}`},
		{name: "unauthorized", status: http.StatusUnauthorized, wantIs: connector.ErrForbidden, wantText: "backend returned 401"},
		{name: "forbidden", status: http.StatusForbidden, wantIs: connector.ErrForbidden, wantText: "backend returned 403"},
		{name: "not found", status: http.StatusNotFound, wantIs: connector.ErrNotAvailable, wantText: "backend returned 404"},
		{
			name:     "other statuses sanitized",
			status:   http.StatusInternalServerError,
			body:     `internal error: password=hunter2`,
			wantText: "backend returned status 500",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
				fmt.Fprint(w, tt.body)
			}))
			t.Cleanup(server.Close)

			got, err := Get(context.Background(), Config{Endpoint: server.URL}, "/x", nil, nil)
			if tt.want != "" {
				require.NoError(t, err)
				require.JSONEq(t, tt.want, string(got))
				return
			}
			// Exact text for the unwrapped case proves neither the endpoint
			// URL nor the response body leaked into the error; wrapped
			// sentinels are matched on their suffix.
			if tt.wantIs == nil {
				require.EqualError(t, err, tt.wantText)
				return
			}
			require.ErrorIs(t, err, tt.wantIs)
			require.ErrorContains(t, err, tt.wantText)
		})
	}
}

func TestGetAuthVariants(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		credentials []byte
		want        string
	}{
		{name: "nil credentials", credentials: nil, want: ""},
		{name: "empty credentials", credentials: []byte(""), want: ""},
		{
			name:        "basic",
			credentials: []byte("alice:s3cret"),
			want:        "Basic " + base64.StdEncoding.EncodeToString([]byte("alice:s3cret")),
		},
		{name: "bearer", credentials: []byte("token-abc"), want: "Bearer token-abc"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var gotAuth string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotAuth = r.Header.Get("Authorization")
				fmt.Fprint(w, `{"ok":true}`)
			}))
			t.Cleanup(server.Close)

			_, err := Get(context.Background(), Config{Endpoint: server.URL}, "/x", nil, tt.credentials)
			require.NoError(t, err)
			require.Equal(t, tt.want, gotAuth)
		})
	}
}

func TestGetResponseSizeCap(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(make([]byte, MaxResponseBytes+1))
	}))
	t.Cleanup(server.Close)

	_, err := Get(context.Background(), Config{Endpoint: server.URL}, "/x", nil, nil)
	require.ErrorContains(t, err, "exceeds")
}

func TestGetHonorsContextDeadline(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(2 * time.Second)
	}))
	t.Cleanup(server.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	t.Cleanup(cancel)
	_, err := Get(ctx, Config{Endpoint: server.URL}, "/x", nil, nil)
	require.Error(t, err)
	require.ErrorIs(t, err, context.DeadlineExceeded)
}

func TestGetJoinsEndpointAndPath(t *testing.T) {
	t.Parallel()
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		fmt.Fprint(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)

	// Trailing slash on the endpoint must not double the slash in the path.
	_, err := Get(context.Background(), Config{Endpoint: server.URL + "/"}, "/v1/x", nil, nil)
	require.NoError(t, err)
	require.Equal(t, "/v1/x", gotPath)
}

func TestGetSendsConfiguredHeaders(t *testing.T) {
	t.Parallel()
	type seen struct {
		org      string
		emptyRaw []string
		auth     string
	}
	got := make(chan seen, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- seen{
			org:      r.Header.Get("X-Scope-OrgID"),
			emptyRaw: r.Header.Values("X-Empty"),
			auth:     r.Header.Get("Authorization"),
		}
		fmt.Fprint(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)

	cfg := Config{
		Endpoint: server.URL,
		Headers:  map[string]string{"X-Scope-OrgID": "tenant-a", "X-Empty": ""},
	}
	_, err := Get(context.Background(), cfg, "/x", nil, []byte("tok"))
	require.NoError(t, err)

	select {
	case s := <-got:
		require.Equal(t, "tenant-a", s.org)
		require.Equal(t, "Bearer tok", s.auth)
		// The empty value arrives as a present-but-empty header, not an
		// omitted one.
		require.Equal(t, []string{""}, s.emptyRaw)
	case <-time.After(5 * time.Second):
		t.Fatal("test server saw no request")
	}
}

func TestGetConfiguredHeaderWinsAuthCollision(t *testing.T) {
	t.Parallel()
	got := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Header.Get("Authorization")
		fmt.Fprint(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)

	cfg := Config{
		Endpoint: server.URL,
		Headers:  map[string]string{"Authorization": "Bearer config-declared"},
	}
	_, err := Get(context.Background(), cfg, "/x", nil, []byte("per-request"))
	require.NoError(t, err)

	select {
	case auth := <-got:
		require.Equal(t, "Bearer config-declared", auth)
	case <-time.After(5 * time.Second):
		t.Fatal("test server saw no request")
	}
}

func TestGetInsecureSkipTLS(t *testing.T) {
	t.Parallel()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)

	// Default client: the self-signed certificate must fail verification.
	_, err := Get(context.Background(), Config{Endpoint: server.URL}, "/x", nil, nil)
	require.Error(t, err)
	require.ErrorContains(t, err, "certificate")

	// insecureSkipTLS opts this connector into accepting the self-signed
	// certificate.
	got, err := Get(context.Background(), Config{Endpoint: server.URL, InsecureSkipTLS: true}, "/x", nil, nil)
	require.NoError(t, err)
	require.JSONEq(t, `{"ok":true}`, string(got))
}

func TestClassifyState(t *testing.T) {
	t.Parallel()
	require.Equal(t, connector.StateForbidden, ClassifyState(fmt.Errorf("%w: backend returned 401", connector.ErrForbidden)))
	require.Equal(t, connector.StateNotAvailable, ClassifyState(fmt.Errorf("%w: backend returned 404", connector.ErrNotAvailable)))
	require.Equal(t, connector.StateNotConfigured, ClassifyState(fmt.Errorf("%w: missing", connector.ErrNotConfigured)))
	require.Equal(t, connector.StateError, ClassifyState(errors.New("connection refused")))
	require.NotEmpty(t, ReasonFor(connector.StateForbidden))
	require.NotEmpty(t, ReasonFor(connector.StateNotAvailable))
	require.NotEmpty(t, ReasonFor(connector.StateError))
}

func TestClampLimit(t *testing.T) {
	t.Parallel()
	require.Equal(t, 100, ClampLimit(0, 100, 1000))
	require.Equal(t, 100, ClampLimit(-3, 100, 1000))
	require.Equal(t, 42, ClampLimit(42, 100, 1000))
	require.Equal(t, 1000, ClampLimit(5000, 100, 1000))
}
