package gcpcloudlogging

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// recordedRequest is one request the fake GCP server saw.
type recordedRequest struct {
	method string
	path   string
	query  url.Values
	body   json.RawMessage
	auth   string
}

// fakeGCP is an httptest server acting as BOTH the OAuth2 token endpoint
// (any POST to /token answers a canned bearer token) and the service API.
// google.CredentialsFromJSON signs its JWT locally against a generated RSA
// key and posts the grant to the credential's own token_uri, so the whole
// real auth path runs without touching GCP.
type fakeGCP struct {
	server *httptest.Server
	mu     sync.Mutex
	reqs   []recordedRequest
}

// newFakeGCP starts the fake; api handles service calls (everything but
// /token) after the bearer token is validated. tlsServer selects a
// self-signed TLS server for the insecureSkipTLS tests.
func newFakeGCP(t *testing.T, tlsServer bool, api http.HandlerFunc) *fakeGCP {
	t.Helper()
	fake := &fakeGCP{}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"access_token":"test-token","expires_in":3600,"token_type":"Bearer"}`)
			return
		}

		var body json.RawMessage
		if r.Body != nil {
			raw, err := io.ReadAll(r.Body)
			require.NoError(t, err)
			body = raw
		}
		fake.mu.Lock()
		fake.reqs = append(fake.reqs, recordedRequest{
			method: r.Method,
			path:   r.URL.Path,
			query:  r.URL.Query(),
			body:   body,
			auth:   r.Header.Get("Authorization"),
		})
		fake.mu.Unlock()

		if r.Header.Get("Authorization") != "Bearer test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		api(w, r)
	})
	if tlsServer {
		fake.server = httptest.NewTLSServer(handler)
	} else {
		fake.server = httptest.NewServer(handler)
	}
	t.Cleanup(fake.server.Close)
	return fake
}

// last returns the most recent recorded service request.
func (f *fakeGCP) last(t *testing.T) recordedRequest {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	require.NotEmpty(t, f.reqs)
	return f.reqs[len(f.reqs)-1]
}

// fakeServiceAccountCreds builds a service-account credential JSON whose
// token_uri points at the fake server, signed by a locally generated RSA
// key, so the real JWT grant path runs end to end.
func fakeServiceAccountCreds(t *testing.T, tokenURL, projectID string) json.RawMessage {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	der, err := x509.MarshalPKCS8PrivateKey(key)
	require.NoError(t, err)
	creds, err := json.Marshal(map[string]string{
		"type":         "service_account",
		"project_id":   projectID,
		"client_email": "observability-fake@example.com",
		"client_id":    "1234567890",
		"token_uri":    tokenURL,
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
	})
	require.NoError(t, err)
	return creds
}

// testConfig pins the project and points the endpoint at the fake server.
func testConfig(t *testing.T, endpoint string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"projectId": "test-proj", "endpoint": endpoint})
	require.NoError(t, err)
	return raw
}

// entriesBody is the captured entries:list request body.
type entriesBody struct {
	ResourceNames []string `json:"resourceNames"`
	Filter        string   `json:"filter"`
	PageSize      int      `json:"pageSize"`
	OrderBy       string   `json:"orderBy"`
	PageToken     string   `json:"pageToken"`
}

func TestQueryContinuationPreservesProjectFilterAndWindow(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"entries":[],"nextPageToken":"opaque+/=continuation"}`)
	})
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "other-project")
	start := time.Date(2026, 10, 15, 10, 0, 0, 123456789, time.UTC)
	req := queryLogs(testConfig(t, fake.server.URL), creds, func(req *connector.QueryRequest) {
		req.Query = `severity=ERROR OR severity=WARNING`
		req.Range = connector.TimeRange{Start: start, End: start.Add(time.Minute)}
		req.Limit = 7
	})
	first, err := New().Query(context.Background(), req)
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, first.State)
	var firstBody entriesBody
	require.NoError(t, json.Unmarshal(fake.last(t).body, &firstBody))
	require.Equal(t, []string{"projects/test-proj"}, firstBody.ResourceNames)
	require.Equal(t, `(severity=ERROR OR severity=WARNING) AND timestamp >= "2026-10-15T10:00:00.123456789Z" AND timestamp <= "2026-10-15T10:01:00.123456789Z"`, firstBody.Filter)
	var page struct {
		NextPageToken string `json:"nextPageToken"`
	}
	require.NoError(t, json.Unmarshal(first.Data, &page))
	req.PageToken = page.NextPageToken
	second, err := New().Query(context.Background(), req)
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, second.State)
	var secondBody entriesBody
	require.NoError(t, json.Unmarshal(fake.last(t).body, &secondBody))
	require.Equal(t, req.PageToken, secondBody.PageToken)
	secondBody.PageToken = ""
	require.Equal(t, firstBody, secondBody)
}

func TestOversizePageTokenFailsBeforeCredentialsOrNetwork(t *testing.T) {
	t.Parallel()
	res, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalLogs, PageToken: strings.Repeat("private", 1000)})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.NotContains(t, err.Error(), "private")
}

func TestInsecureBackendDoesNotDisableTokenTLSVerification(t *testing.T) {
	t.Parallel()
	tokenServer := newFakeGCP(t, true, entriesOK)
	backend := newFakeGCP(t, false, entriesOK)
	config, err := json.Marshal(map[string]any{"projectId": "test-proj", "endpoint": backend.server.URL, "insecureSkipTLS": true})
	require.NoError(t, err)
	res, err := New().Query(context.Background(), queryLogs(config, fakeServiceAccountCreds(t, tokenServer.server.URL+"/token", "test-proj"), nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateError, res.State)
	backend.mu.Lock()
	defer backend.mu.Unlock()
	require.Empty(t, backend.reqs)
}

func entriesOK(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"entries":[{"logName":"projects/test-proj/logs/app","textPayload":"hi"}]}`)
}

func queryLogs(cfg json.RawMessage, creds json.RawMessage, mutate func(*connector.QueryRequest)) connector.QueryRequest {
	req := connector.QueryRequest{
		Signal:      connector.SignalLogs,
		Query:       `logName="projects/test-proj/logs/app"`,
		Config:      cfg,
		Credentials: creds,
	}
	if mutate != nil {
		mutate(&req)
	}
	return req
}

func TestQueryOKRoundTrip(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, entriesOK)

	res, err := New().Query(context.Background(), queryLogs(
		testConfig(t, fake.server.URL),
		fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj"), nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"entries":[{"logName":"projects/test-proj/logs/app","textPayload":"hi"}]}`, string(res.Data))

	got := fake.last(t)
	require.Equal(t, http.MethodPost, got.method)
	require.Equal(t, "/v2/entries:list", got.path)
	require.Equal(t, "Bearer test-token", got.auth)

	var body entriesBody
	require.NoError(t, json.Unmarshal(got.body, &body))
	require.Equal(t, []string{"projects/test-proj"}, body.ResourceNames)
	require.Equal(t, `logName="projects/test-proj/logs/app"`, body.Filter)
	require.Equal(t, 100, body.PageSize)
	require.Equal(t, "timestamp desc", body.OrderBy)
}

func TestProjectComesFromCredential(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, entriesOK)

	raw, err := json.Marshal(map[string]string{"endpoint": fake.server.URL})
	require.NoError(t, err)

	res, err := New().Query(context.Background(), queryLogs(raw,
		fakeServiceAccountCreds(t, fake.server.URL+"/token", "creds-proj"), nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var body entriesBody
	require.NoError(t, json.Unmarshal(fake.last(t).body, &body))
	require.Equal(t, []string{"projects/creds-proj"}, body.ResourceNames)
}

func TestProbeEmptyQuery(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, entriesOK)

	res, err := New().Query(context.Background(), queryLogs(
		testConfig(t, fake.server.URL),
		fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj"),
		func(req *connector.QueryRequest) {
			req.Query = ""
			req.Limit = 1
		}))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	got := fake.last(t)
	require.Equal(t, "/v2/entries:list", got.path)
	var body entriesBody
	require.NoError(t, json.Unmarshal(got.body, &body))
	require.Empty(t, body.Filter)
	require.Equal(t, 1, body.PageSize)
}

func TestLimitClamping(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		limit int
		probe bool
		want  int
	}{
		{name: "unset falls back to default", limit: 0, want: 100},
		{name: "negative falls back to default", limit: -5, want: 100},
		{name: "in range passes through", limit: 42, want: 42},
		{name: "above maximum clamps", limit: 5000, want: 1000},
		{name: "probe unset falls back to one", limit: 0, probe: true, want: 1},
		{name: "probe above maximum clamps", limit: 5000, probe: true, want: 1000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fake := newFakeGCP(t, false, entriesOK)

			res, err := New().Query(context.Background(), queryLogs(
				testConfig(t, fake.server.URL),
				fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj"),
				func(req *connector.QueryRequest) {
					req.Limit = tt.limit
					if tt.probe {
						req.Query = ""
					}
				}))
			require.NoError(t, err)
			require.Equal(t, connector.StateOK, res.State)

			var body entriesBody
			require.NoError(t, json.Unmarshal(fake.last(t).body, &body))
			require.Equal(t, tt.want, body.PageSize)
		})
	}
}

func TestBackendErrorsBecomeStates(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status int
		state  connector.State
	}{
		{name: "forbidden", status: http.StatusForbidden, state: connector.StateForbidden},
		{name: "not found", status: http.StatusNotFound, state: connector.StateNotAvailable},
		{name: "bad gateway", status: http.StatusBadGateway, state: connector.StateError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fake := newFakeGCP(t, false, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
				fmt.Fprint(w, `{"error":"detail never surfaces"}`)
			})

			res, err := New().Query(context.Background(), queryLogs(
				testConfig(t, fake.server.URL),
				fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj"), nil))
			require.NoError(t, err)
			require.Equal(t, tt.state, res.State)
			require.NotEmpty(t, res.Reason)
			require.NotContains(t, res.Reason, fake.server.URL)
			require.NotContains(t, res.Reason, "detail never surfaces")
			require.Nil(t, res.Data)
		})
	}
}

func TestUnsupportedSignalAndTraceID(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, entriesOK)
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")

	res, err := New().Query(context.Background(), queryLogs(testConfig(t, fake.server.URL), creds,
		func(req *connector.QueryRequest) { req.Signal = connector.SignalMetrics }))
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "gcp-cloudlogging connector supplies logs only", res.Reason)

	res, err = New().Query(context.Background(), queryLogs(testConfig(t, fake.server.URL), creds,
		func(req *connector.QueryRequest) { req.TraceID = "abc123" }))
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "a trace ID cannot be fetched from cloud logging", res.Reason)
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"projectId":"proj-a"}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"projectId":"proj-a","endpoint":"https://logging.example.com","insecureSkipTLS":false}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage{}))

	err := New().ValidateConfig(json.RawMessage(`{"projectId":"proj-a","bogus":true}`))
	require.ErrorContains(t, err, `unknown key "bogus"`)

	err = New().ValidateConfig(json.RawMessage(`{"endpoint":"not-a-url"}`))
	require.ErrorContains(t, err, `key "endpoint" must be an absolute http(s) URL`)
}

func TestMissingProjectNotConfigured(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, entriesOK)

	raw, err := json.Marshal(map[string]string{"endpoint": fake.server.URL})
	require.NoError(t, err)
	// The credential document carries no project_id and neither does the
	// config.
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "")

	res, err := New().Query(context.Background(), queryLogs(raw, creds, nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateNotConfigured, res.State)
	require.NotEmpty(t, res.Reason)
	require.Nil(t, res.Data)
}

func TestUnsupportedCredentialType(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, entriesOK)

	res, err := New().Query(context.Background(), queryLogs(
		testConfig(t, fake.server.URL),
		json.RawMessage(`{"type":"authorized_user","refresh_token":"x"}`), nil))
	require.Error(t, err)
	require.NotNil(t, res)
	require.Equal(t, connector.StateForbidden, res.State)
	require.NotEmpty(t, res.Reason)
}

func TestInsecureSkipTLS(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, true, entriesOK)
	tokenServer := newFakeGCP(t, false, entriesOK)
	creds := fakeServiceAccountCreds(t, tokenServer.server.URL+"/token", "test-proj")

	// Default: the self-signed certificate must fail verification. The
	// transport error converts to a StateError result per the connector
	// error contract.
	res, err := New().Query(context.Background(), queryLogs(testConfig(t, fake.server.URL), creds, nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateError, res.State)

	// insecureSkipTLS opts this connector into accepting the self-signed
	// backend certificate; OAuth token exchanges still verify certificates.
	raw, err := json.Marshal(map[string]any{
		"projectId":       "test-proj",
		"endpoint":        fake.server.URL,
		"insecureSkipTLS": true,
	})
	require.NoError(t, err)

	res, err = New().Query(context.Background(), queryLogs(raw, creds, nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
}
