package gcpcloudtrace

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
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

		fake.mu.Lock()
		fake.reqs = append(fake.reqs, recordedRequest{
			method: r.Method,
			path:   r.URL.Path,
			query:  r.URL.Query(),
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

func tracesOK(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"traces":[{"traceId":"abc123","spans":[]}]}`)
}

func queryTraces(cfg json.RawMessage, creds json.RawMessage, mutate func(*connector.QueryRequest)) connector.QueryRequest {
	req := connector.QueryRequest{
		Signal:      connector.SignalTraces,
		Query:       `+label:route`,
		Config:      cfg,
		Credentials: creds,
	}
	if mutate != nil {
		mutate(&req)
	}
	return req
}

func TestQueryListOKRoundTrip(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, tracesOK)

	start := time.Unix(1_700_000_000, 0)
	end := start.Add(30 * time.Minute)
	res, err := New().Query(context.Background(), queryTraces(
		testConfig(t, fake.server.URL),
		fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj"),
		func(req *connector.QueryRequest) { req.Range = connector.TimeRange{Start: start, End: end} }))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"traces":[{"traceId":"abc123","spans":[]}]}`, string(res.Data))

	got := fake.last(t)
	require.Equal(t, http.MethodGet, got.method)
	require.Equal(t, "/v1/projects/test-proj/traces", got.path)
	require.Equal(t, "Bearer test-token", got.auth)
	require.Equal(t, "+label:route", got.query.Get("filter"))
	require.Equal(t, start.UTC().Format(time.RFC3339Nano), got.query.Get("startTime"))
	require.Equal(t, end.UTC().Format(time.RFC3339Nano), got.query.Get("endTime"))
	require.Equal(t, "100", got.query.Get("pageSize"))
}

func TestContinuationPreservesProjectFilterAndWindow(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"traces":[],"nextPageToken":"opaque+/=continuation"}`)
	})
	start := time.Date(2026, 10, 15, 10, 0, 0, 123456789, time.UTC)
	req := queryTraces(testConfig(t, fake.server.URL), fakeServiceAccountCreds(t, fake.server.URL+"/token", "other-project"), func(req *connector.QueryRequest) {
		req.Range = connector.TimeRange{Start: start, End: start.Add(time.Minute)}
		req.Limit = 7
	})
	first, err := New().Query(context.Background(), req)
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, first.State)
	before := fake.last(t)
	var page struct {
		NextPageToken string `json:"nextPageToken"`
	}
	require.NoError(t, json.Unmarshal(first.Data, &page))
	req.PageToken = page.NextPageToken
	second, err := New().Query(context.Background(), req)
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, second.State)
	after := fake.last(t)
	require.Equal(t, "/v1/projects/test-proj/traces", after.path)
	require.Equal(t, req.PageToken, after.query.Get("pageToken"))
	after.query.Del("pageToken")
	require.Equal(t, before.query, after.query)
	require.Equal(t, "2026-10-15T10:00:00.123456789Z", after.query.Get("startTime"))
}

func TestProbeRetainsTimeBounds(t *testing.T) {
	t.Parallel()
	start := time.Unix(1700000000, 0)
	_, params := requestShape("test-proj", &connector.QueryRequest{Range: connector.TimeRange{Start: start, End: start.Add(time.Minute)}})
	require.Equal(t, "1", params.Get("pageSize"))
	require.Equal(t, start.UTC().Format(time.RFC3339Nano), params.Get("startTime"))
	require.Equal(t, start.Add(time.Minute).UTC().Format(time.RFC3339Nano), params.Get("endTime"))
}

func TestInvalidPageTokenShapesFailBeforeCredentialsOrNetwork(t *testing.T) {
	t.Parallel()
	for _, req := range []connector.QueryRequest{
		{Signal: connector.SignalTraces, PageToken: strings.Repeat("private", 1000)},
		{Signal: connector.SignalTraces, TraceID: "trace-id", PageToken: "private"},
	} {
		res, err := New().Query(context.Background(), req)
		require.ErrorIs(t, err, connector.ErrUnsupported)
		require.Equal(t, connector.StateNotAvailable, res.State)
		require.NotContains(t, err.Error(), "private")
	}
}

func TestTraceIDFetchTakesPrecedence(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"projectId":"test-proj","traceId":"abc123","spans":[]}`)
	})

	res, err := New().Query(context.Background(), queryTraces(
		testConfig(t, fake.server.URL),
		fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj"),
		func(req *connector.QueryRequest) { req.TraceID = "abc123" }))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"projectId":"test-proj","traceId":"abc123","spans":[]}`, string(res.Data))

	got := fake.last(t)
	require.Equal(t, "/v1/projects/test-proj/traces/abc123", got.path)
	require.Empty(t, got.query.Get("filter"))
}

func TestProbeEmptyQuery(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, tracesOK)

	res, err := New().Query(context.Background(), queryTraces(
		testConfig(t, fake.server.URL),
		fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj"),
		func(req *connector.QueryRequest) { req.Query = "" }))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	got := fake.last(t)
	require.Equal(t, "/v1/projects/test-proj/traces", got.path)
	require.Equal(t, "1", got.query.Get("pageSize"))
	require.Empty(t, got.query.Get("filter"))
}

func TestLimitClamping(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		limit int
		want  string
	}{
		{name: "unset falls back to default", limit: 0, want: "100"},
		{name: "negative falls back to default", limit: -5, want: "100"},
		{name: "in range passes through", limit: 42, want: "42"},
		{name: "above maximum clamps", limit: 5000, want: "1000"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fake := newFakeGCP(t, false, tracesOK)

			res, err := New().Query(context.Background(), queryTraces(
				testConfig(t, fake.server.URL),
				fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj"),
				func(req *connector.QueryRequest) { req.Limit = tt.limit }))
			require.NoError(t, err)
			require.Equal(t, connector.StateOK, res.State)
			require.Equal(t, tt.want, fake.last(t).query.Get("pageSize"))
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

			res, err := New().Query(context.Background(), queryTraces(
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

func TestUnsupportedSignal(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, tracesOK)

	res, err := New().Query(context.Background(), queryTraces(testConfig(t, fake.server.URL),
		fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj"),
		func(req *connector.QueryRequest) { req.Signal = connector.SignalLogs }))
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "gcp-cloudtrace connector supplies traces only", res.Reason)
}

func TestValidateConfig(t *testing.T) {
	t.Parallel()

	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"projectId":"proj-a"}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{"projectId":"proj-a","endpoint":"https://cloudtrace.example.com","insecureSkipTLS":false}`)))
	require.NoError(t, New().ValidateConfig(json.RawMessage{}))

	err := New().ValidateConfig(json.RawMessage(`{"projectId":"proj-a","bogus":true}`))
	require.ErrorContains(t, err, `unknown key "bogus"`)
}

func TestMissingProjectNotConfigured(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, tracesOK)

	raw, err := json.Marshal(map[string]string{"endpoint": fake.server.URL})
	require.NoError(t, err)
	// The credential document carries no project_id and neither does the
	// config.
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "")

	res, err := New().Query(context.Background(), queryTraces(raw, creds, nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateNotConfigured, res.State)
	require.NotEmpty(t, res.Reason)
	require.Nil(t, res.Data)
}

func TestUnsupportedCredentialType(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, tracesOK)

	res, err := New().Query(context.Background(), queryTraces(
		testConfig(t, fake.server.URL),
		json.RawMessage(`{"type":"authorized_user","refresh_token":"x"}`), nil))
	require.Error(t, err)
	require.NotNil(t, res)
	require.Equal(t, connector.StateForbidden, res.State)
	require.NotEmpty(t, res.Reason)
}

func TestInsecureSkipTLS(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, true, tracesOK)
	tokenServer := newFakeGCP(t, false, tracesOK)
	creds := fakeServiceAccountCreds(t, tokenServer.server.URL+"/token", "test-proj")

	// Default: the self-signed certificate must fail verification. The
	// transport error converts to a StateError result per the connector
	// error contract.
	res, err := New().Query(context.Background(), queryTraces(testConfig(t, fake.server.URL), creds, nil))
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

	res, err = New().Query(context.Background(), queryTraces(raw, creds, nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
}
