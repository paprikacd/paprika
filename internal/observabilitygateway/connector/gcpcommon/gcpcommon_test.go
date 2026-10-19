package gcpcommon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestParseConfig(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		config  string
		want    Config
		wantErr string
	}{
		{
			name:   "empty document is valid",
			config: ``,
			want:   Config{},
		},
		{
			name:   "full document",
			config: `{"projectId":"proj-a","endpoint":"https://logging.example.com","insecureSkipTLS":true}`,
			want:   Config{ProjectID: "proj-a", Endpoint: "https://logging.example.com", InsecureSkipTLS: true},
		},
		{
			name:   "projectId and endpoint only",
			config: `{"projectId":"proj-a","endpoint":"https://logging.example.com"}`,
			want:   Config{ProjectID: "proj-a", Endpoint: "https://logging.example.com"},
		},
		{
			name:    "unknown key",
			config:  `{"projectId":"proj-a","bogus":true}`,
			wantErr: `unknown key "bogus"`,
		},
		{
			name:    "projectId not a string",
			config:  `{"projectId":42}`,
			wantErr: `key "projectId" must be a string`,
		},
		{
			name:    "endpoint not a string",
			config:  `{"endpoint":42}`,
			wantErr: `key "endpoint" must be a string`,
		},
		{
			name:    "endpoint not absolute http",
			config:  `{"endpoint":"logging.example.com"}`,
			wantErr: `key "endpoint" must be an absolute http(s) URL`,
		},
		{
			name:    "insecureSkipTLS not a bool",
			config:  `{"insecureSkipTLS":"yes"}`,
			wantErr: `key "insecureSkipTLS" must be a bool`,
		},
		{
			name:    "invalid JSON",
			config:  `{"projectId":`,
			wantErr: "invalid JSON document",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			cfg, err := ParseConfig(json.RawMessage(tt.config))
			if tt.wantErr != "" {
				require.ErrorContains(t, err, tt.wantErr)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.want, cfg)
		})
	}
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, ValidateConfig(json.RawMessage(`{"projectId":"proj-a"}`)))
	require.NoError(t, ValidateConfig(json.RawMessage{}))
	require.ErrorContains(t, ValidateConfig(json.RawMessage(`{"endpointt":"https://x"}`)), `unknown key "endpointt"`)
}

func TestResolveProject(t *testing.T) {
	t.Parallel()

	credsWithProject := json.RawMessage(`{"type":"service_account","project_id":"creds-proj"}`)
	credsNoProject := json.RawMessage(`{"type":"service_account"}`)

	project, err := ResolveProject("configured-proj", credsWithProject)
	require.NoError(t, err)
	require.Equal(t, "configured-proj", project)

	project, err = ResolveProject("", credsWithProject)
	require.NoError(t, err)
	require.Equal(t, "creds-proj", project)

	_, err = ResolveProject("", credsNoProject)
	require.ErrorIs(t, err, connector.ErrNotConfigured)
	require.ErrorContains(t, err, "a projectId must be configured")

	// A malformed credential document has no project either; Client reports
	// the document problem when the query proceeds to credential loading.
	_, err = ResolveProject("", json.RawMessage(`{`))
	require.ErrorIs(t, err, connector.ErrNotConfigured)

	// Pure-metadata ambient identity (no document at all) has no in-process
	// project: the operator must set projectId.
	_, err = ResolveProject("", nil)
	require.ErrorIs(t, err, connector.ErrNotConfigured)
}

func TestClientRejectsUnsupportedCredentialType(t *testing.T) {
	t.Parallel()

	_, err := Client(context.Background(), Config{}, json.RawMessage(`{"type":"authorized_user"}`))
	require.ErrorContains(t, err, "unsupported credential type")

	_, err = Client(context.Background(), Config{}, json.RawMessage(`{`))
	require.ErrorContains(t, err, "credential document is not valid JSON")
}

func TestCloudTraceUsesPublishedReadOnlyScope(t *testing.T) {
	t.Parallel()
	require.Contains(t, scopes, "https://www.googleapis.com/auth/trace.readonly")
	require.NotContains(t, scopes, "https://www.googleapis.com/auth/trace.read")
}

func TestCredentialTypeAndEndpointErrorsNeverEchoValues(t *testing.T) {
	t.Parallel()
	_, err := Client(context.Background(), Config{}, json.RawMessage(`{"type":"never-echo-secret"}`))
	require.Error(t, err)
	require.NotContains(t, err.Error(), "never-echo-secret")
	for _, endpoint := range []string{"https://user:never-echo-secret@example.com", "https://example.com?key=never-echo-secret", "https://example.com#never-echo-secret"} {
		config, err := json.Marshal(map[string]string{"endpoint": endpoint})
		require.NoError(t, err)
		_, err = ParseConfig(config)
		require.Error(t, err)
		require.NotContains(t, err.Error(), "never-echo-secret")
	}
}

func TestDoRefusesRedirectWithOAuthTransport(t *testing.T) {
	t.Parallel()
	var followed atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		followed.Add(1)
		fmt.Fprint(w, `{}`)
	}))
	t.Cleanup(target.Close)
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(source.Close)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, source.URL, http.NoBody)
	require.NoError(t, err)
	_, err = Do(req, staticClient())
	require.ErrorContains(t, err, "backend returned status 307")
	require.Zero(t, followed.Load())
}

// TestClientAmbientWithoutIdentityFailsClosed: when the ambient lookup finds
// nothing (forced through the package seam — the real probe consults the
// process environment and the link-local metadata address, which no env
// manipulation can neutralize on every host), Client must fail with
// ErrNoAmbientCredentials so connectors report StateNotConfigured — the
// backend was never contacted, so a refusal verdict would misdescribe what
// happened.
func TestClientAmbientWithoutIdentityFailsClosed(t *testing.T) {
	original := findDefaultCredentials
	findDefaultCredentials = func(context.Context, ...string) (*google.Credentials, error) {
		return nil, errors.New("google: could not find default credentials")
	}
	t.Cleanup(func() { findDefaultCredentials = original })

	_, err := Client(context.Background(), Config{}, nil)
	require.ErrorIs(t, err, ErrNoAmbientCredentials)
}

// TestCredentialErrorMapsAmbientToNotConfigured: the sentinel from ambient
// resolution maps to StateNotConfigured with the actionable fixed sentence;
// a refused or malformed document stays StateForbidden.
func TestCredentialErrorMapsVerdicts(t *testing.T) {
	t.Parallel()

	result, err := CredentialError(fmt.Errorf("%w: google: could not find default credentials", ErrNoAmbientCredentials))
	require.NotNil(t, result)
	require.Error(t, err)
	require.Equal(t, connector.StateNotConfigured, result.State)
	require.Contains(t, result.Reason, "set a credentialsSecretRef or attach Workload Identity")

	result, err = CredentialError(errors.New("parsing credential document: x509: malformed"))
	require.NotNil(t, result)
	require.Error(t, err)
	require.Equal(t, connector.StateForbidden, result.State)
}

func TestURLOverrideAndDefault(t *testing.T) {
	t.Parallel()

	params := url.Values{"pageSize": []string{"1"}}
	require.Equal(t, "https://logging.googleapis.com/v2/entries:list?pageSize=1",
		URL(Config{}, "https://logging.googleapis.com", "/v2/entries:list", params))
	require.Equal(t, "https://fake.example.com/base/v2/entries:list",
		URL(Config{Endpoint: "https://fake.example.com/base/"}, "https://logging.googleapis.com", "/v2/entries:list", nil))
}

// staticClient returns an HTTP client that always sends one bearer token,
// for Do tests that do not exercise credential construction.
func staticClient() *http.Client {
	return oauth2.NewClient(context.Background(), oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "static-token"}))
}

func TestDoRoundTrip(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer static-token", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/v1/x", http.NoBody)
	require.NoError(t, err)
	data, err := Do(req, staticClient())
	require.NoError(t, err)
	require.JSONEq(t, `{"ok":true}`, string(data))
}

func TestDoWrapsNonJSONBody(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "plain text reply")
	}))
	t.Cleanup(server.Close)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, http.NoBody)
	require.NoError(t, err)
	data, err := Do(req, staticClient())
	require.NoError(t, err)
	require.JSONEq(t, `{"raw":"plain text reply"}`, string(data))
}

func TestDoClassifiesStatuses(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status int
		check  func(t *testing.T, err error)
	}{
		{name: "unauthorized wraps forbidden", status: http.StatusUnauthorized,
			check: func(t *testing.T, err error) { require.ErrorIs(t, err, connector.ErrForbidden) }},
		{name: "forbidden wraps forbidden", status: http.StatusForbidden,
			check: func(t *testing.T, err error) { require.ErrorIs(t, err, connector.ErrForbidden) }},
		{name: "not found wraps not available", status: http.StatusNotFound,
			check: func(t *testing.T, err error) { require.ErrorIs(t, err, connector.ErrNotAvailable) }},
		{name: "other statuses stay sanitized", status: http.StatusBadGateway,
			check: func(t *testing.T, err error) {
				require.ErrorContains(t, err, "backend returned status 502")
				require.NotErrorIs(t, err, connector.ErrForbidden)
				require.NotErrorIs(t, err, connector.ErrNotAvailable)
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
				fmt.Fprint(w, `{"error":"detail never surfaces"}`)
			}))
			t.Cleanup(server.Close)

			req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, http.NoBody)
			require.NoError(t, err)
			data, err := Do(req, staticClient())
			require.Error(t, err)
			require.Nil(t, data)
			require.NotContains(t, err.Error(), server.URL)
			require.NotContains(t, err.Error(), "detail never surfaces")
			tt.check(t, err)
		})
	}
}

func TestDoCapsResponseBody(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// One byte over the cap: rejected, not truncated.
		fmt.Fprint(w, strings.Repeat("a", 8<<20+1))
	}))
	t.Cleanup(server.Close)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, http.NoBody)
	require.NoError(t, err)
	_, err = Do(req, staticClient())
	require.ErrorContains(t, err, "byte limit")
}

func TestDoSanitizesTransportErrors(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	server.Close() // Every request now fails with connection refused.

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/v1/x", http.NoBody)
	require.NoError(t, err)
	_, err = Do(req, staticClient())
	require.Error(t, err)
	// The *url.Error wrapper quotes the request URL — endpoint URLs can
	// carry credential material, so only the cause may survive.
	require.NotContains(t, err.Error(), server.URL)
	require.NotContains(t, err.Error(), "http://")
}

// retrieveErrorSource fails the way a refused OAuth grant does: an
// *oauth2.RetrieveError quoting the token endpoint's response body.
type retrieveErrorSource struct {
	body []byte
}

func (s retrieveErrorSource) Token() (*oauth2.Token, error) {
	return nil, &oauth2.RetrieveError{
		Response: &http.Response{StatusCode: http.StatusBadRequest},
		Body:     s.body,
	}
}

func TestDoSanitizesRetrieveErrors(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)

	client := oauth2.NewClient(context.Background(), retrieveErrorSource{body: []byte("client_secret=never-echo")})
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, http.NoBody)
	require.NoError(t, err)
	_, err = Do(req, client)
	require.Error(t, err)
	require.ErrorContains(t, err, "obtaining backend access token failed")
	require.NotContains(t, err.Error(), "client_secret")
}

func TestClassifyStateDelegates(t *testing.T) {
	t.Parallel()

	require.Equal(t, connector.StateForbidden, ClassifyState(fmt.Errorf("%w: backend returned 403", connector.ErrForbidden)))
	require.Equal(t, connector.StateNotAvailable, ClassifyState(connector.ErrNotAvailable))
	require.Equal(t, connector.StateNotConfigured, ClassifyState(connector.ErrNotConfigured))
	require.Equal(t, connector.StateError, ClassifyState(errors.New("boom")))
	require.NotEmpty(t, ReasonFor(connector.StateForbidden))
}

// TestClientRefusesAmbientIdentityForForeignEndpoints: the gateway's own
// Google identity goes only to a googleapis.com host over verified TLS. Any
// other endpoint is refused before the ambient lookup runs, so no token is
// minted for it at all.
func TestClientRefusesAmbientIdentityForForeignEndpoints(t *testing.T) {
	var lookups atomic.Int32
	original := findDefaultCredentials
	findDefaultCredentials = func(context.Context, ...string) (*google.Credentials, error) {
		lookups.Add(1)
		return &google.Credentials{TokenSource: oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "gateway-identity"})}, nil
	}
	t.Cleanup(func() { findDefaultCredentials = original })

	refused := []Config{
		{Endpoint: "https://attacker.example"},
		{Endpoint: "http://logging.googleapis.com"},
		{Endpoint: "https://logging.googleapis.com.attacker.example"},
		{Endpoint: "https://evilgoogleapis.com"},
		{InsecureSkipTLS: true},
		{Endpoint: "https://logging.googleapis.com", InsecureSkipTLS: true},
	}
	for _, cfg := range refused {
		_, err := Client(context.Background(), cfg, nil)
		require.ErrorIs(t, err, ErrAmbientEndpointRefused, "%+v", cfg)
		require.NotContains(t, err.Error(), "attacker", "the error must not echo the endpoint")
	}
	require.Zero(t, lookups.Load(), "a refused endpoint must not even resolve ambient identity")

	allowed := []Config{
		{},
		{Endpoint: "https://logging.googleapis.com"},
		{Endpoint: "https://monitoring.googleapis.com:443/"},
		{Endpoint: "https://private.googleapis.com"},
		{Endpoint: "https://LOGGING.GOOGLEAPIS.COM."},
	}
	for _, cfg := range allowed {
		client, err := Client(context.Background(), cfg, nil)
		require.NoError(t, err, "%+v", cfg)
		require.NotNil(t, client)
	}
}

// TestCredentialStateMapsAmbientEndpointRefusal: nothing was sent, so the
// verdict is NotConfigured with a sentence naming the way forward.
func TestCredentialStateMapsAmbientEndpointRefusal(t *testing.T) {
	t.Parallel()
	state, reason := CredentialState(fmt.Errorf("gcp-cloudlogging: %w", ErrAmbientEndpointRefused))
	require.Equal(t, connector.StateNotConfigured, state)
	require.Contains(t, reason, "credentialsSecretRef")
}

// TestClientPinsFederatedCredentialURLsToGoogle: an external_account or
// impersonated_service_account document decides where x/oauth2 posts subject
// tokens and access tokens. Only Google API hosts over HTTPS are accepted;
// otherwise a document could make the gateway read its own service-account
// token from disk and post it elsewhere. Errors name the field, never the
// value.
func TestClientPinsFederatedCredentialURLsToGoogle(t *testing.T) {
	t.Parallel()

	const validSource = `{"type":"external_account",` +
		`"audience":"//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/pool/providers/vke",` +
		`"subject_token_type":"urn:ietf:params:oauth:token-type:jwt",` +
		`"token_url":"https://sts.googleapis.com/v1/token",` +
		`"credential_source":{"file":"/var/run/secrets/tokens/gcp"}}`
	withField := func(field, value string) string {
		return strings.Replace(validSource, `"type":"external_account",`, fmt.Sprintf(`"type":"external_account",%q:%q,`, field, value), 1)
	}

	refused := map[string]string{
		"token_url":                         strings.Replace(validSource, "https://sts.googleapis.com/v1/token", "https://attacker.example/token", 1),
		"plain-http token_url":              strings.Replace(validSource, "https://sts.googleapis.com/v1/token", "http://sts.googleapis.com/v1/token", 1),
		"service_account_impersonation_url": withField("service_account_impersonation_url", "https://attacker.example/impersonate"),
		"token_info_url":                    withField("token_info_url", "https://attacker.example/info"),
		"universe_domain":                   withField("universe_domain", "attacker.example"),
		"executable": strings.Replace(validSource, `{"file":"/var/run/secrets/tokens/gcp"}`,
			`{"executable":{"command":"/bin/sh -c id"}}`, 1),
		"impersonated url": `{"type":"impersonated_service_account",` +
			`"service_account_impersonation_url":"https://attacker.example/impersonate",` +
			`"source_credentials":` + validSource + `}`,
		"impersonated source": `{"type":"impersonated_service_account",` +
			`"service_account_impersonation_url":"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken",` +
			`"source_credentials":` + strings.Replace(validSource, "https://sts.googleapis.com/v1/token", "https://attacker.example/token", 1) + `}`,
	}
	for name, document := range refused {
		_, err := Client(context.Background(), Config{}, []byte(document))
		require.Error(t, err, name)
		require.NotContains(t, err.Error(), "attacker", "%s: the error must not echo the document", name)
		require.NotContains(t, err.Error(), "/bin/sh", "%s: the error must not echo the document", name)
	}

	accepted := map[string]string{
		"workload identity federation": validSource,
		"impersonation through federation": `{"type":"impersonated_service_account",` +
			`"service_account_impersonation_url":"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken",` +
			`"source_credentials":` + validSource + `}`,
	}
	for name, document := range accepted {
		client, err := Client(context.Background(), Config{}, []byte(document))
		require.NoError(t, err, name)
		require.NotNil(t, client, name)
	}
}
