package health

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestEvidenceRetainsFailuresAfterRecoveryAndRestart(t *testing.T) {
	check := sloCheck()
	now := time.Unix(1800000000, 0)
	var previous *api.HealthCheckResult
	for i := 0; i < 8; i++ {
		at := metav1.NewTime(now.Add(time.Duration(i) * time.Minute))
		current := &api.HealthCheckResult{Status: api.HealthDegraded, CheckedAt: &at, ConfigurationHash: MeasurementHash(check), DurationMillis: 75}
		CaptureEvidence(check, previous, EvalResult{Status: api.HealthDegraded, Message: "check failed", HTTPResult: &HTTPResult{StatusCode: 503, Body: `{"checks":[{"name":"database","ok":false,"error":"dependency unavailable"}]}`}}, current)
		previous = current
	}
	require.Len(t, previous.RecentFailures, 5)
	require.Equal(t, now.Add(7*time.Minute), previous.RecentFailures[0].CheckedAt.Time)
	require.Equal(t, "UnexpectedStatus", previous.RecentFailures[0].Reason)
	data, err := json.Marshal(previous)
	require.NoError(t, err)
	var restored api.HealthCheckResult
	require.NoError(t, json.Unmarshal(data, &restored))
	at := metav1.NewTime(now.Add(8 * time.Minute))
	current := &api.HealthCheckResult{Status: api.HealthHealthy, CheckedAt: &at, ConfigurationHash: MeasurementHash(check)}
	CaptureEvidence(check, &restored, EvalResult{Status: api.HealthHealthy, HTTPResult: &HTTPResult{StatusCode: http.StatusOK, Body: "ok"}}, current)
	require.Len(t, current.RecentFailures, 5)
	require.Contains(t, current.RecentFailures[0].HTTPBody, "database")
	require.Empty(t, current.Reason)
	current.RecentFailures[0].Message = "changed"
	require.NotEqual(t, "changed", restored.RecentFailures[0].Message, "cached Kubernetes objects must not be mutated")
	at = metav1.NewTime(now.Add(31 * 24 * time.Hour))
	current = &api.HealthCheckResult{Status: api.HealthHealthy, CheckedAt: &at, ConfigurationHash: MeasurementHash(check)}
	CaptureEvidence(check, &restored, EvalResult{Status: api.HealthHealthy}, current)
	require.Empty(t, current.RecentFailures)
	at = metav1.NewTime(now.Add(8 * time.Minute))
	current = &api.HealthCheckResult{Status: api.HealthHealthy, CheckedAt: &at, ConfigurationHash: "changed-probe"}
	CaptureEvidence(check, &restored, EvalResult{Status: api.HealthHealthy}, current)
	require.Empty(t, current.RecentFailures)
}

//nolint:gosec // Fake credentials verify diagnostic redaction.
func TestEvidenceRedactsAndBoundsResponses(t *testing.T) {
	probe := &api.HTTPProbe{URL: "https://user:fakepass@example.test/check?key=fakequery", Headers: map[string]string{"Authorization": "Bearer fakeheader"}}
	body := `{"checks":[{"name":"db","ok":false,"token":"fake-token","nested":{"password":"fake-password"}}],"message":"Bearer fakeheader at https://user:fakepass@example.test/check?key=fakequery"}`
	sanitized, truncated := sanitizeEvidence(body, probe, 4096)
	require.False(t, truncated)
	for _, secret := range []string{"fake-token", "fake-password", "fakeheader", "fakepass", "fakequery"} {
		require.NotContains(t, sanitized, secret)
	}
	require.Contains(t, sanitized, `"name":"db"`)
	var decoded any
	require.NoError(t, json.Unmarshal([]byte(sanitized), &decoded))
	sanitized, truncated = sanitizeEvidence(strings.Repeat("界", 2000), nil, 2048)
	require.True(t, truncated)
	require.LessOrEqual(t, len(sanitized), 2048)
	require.True(t, utf8.ValidString(sanitized))
	sanitized, _ = sanitizeEvidence("password=example token=example2 Bearer example3", nil, 4096)
	require.NotContains(t, sanitized, "example")
}

func TestProbeTransportClassification(t *testing.T) {
	for _, tt := range []struct {
		err    error
		reason string
	}{
		{context.DeadlineExceeded, "Timeout"}, {context.Canceled, "Canceled"}, {&net.DNSError{Err: "secret", Name: "secret"}, "DNSFailure"}, {syscall.ECONNREFUSED, "ConnectionRefused"}, {errors.New("secret"), "RequestFailed"},
	} {
		result := probeTransportFailure(tt.err)
		require.Equal(t, tt.reason, result.Reason)
		require.NotContains(t, result.Body, "secret")
	}
}

type failedReader struct{}

func (failedReader) Read([]byte) (int, error) { return 0, errors.New("secret read failure") }
func (failedReader) Close() error             { return nil }
func TestProbeReadFailureCannotPassTrueExpression(t *testing.T) {
	oversized := readProbeResponse(&http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(strings.Repeat("a", 64*1024+1)))})
	require.Equal(t, "ResponseTooLarge", oversized.Reason)
	failed := readProbeResponse(&http.Response{StatusCode: http.StatusOK, Body: failedReader{}})
	require.Equal(t, "ResponseReadError", failed.Reason)
	require.NotContains(t, failed.Body, "secret")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(strings.Repeat("a", 64*1024+1))) }))
	defer server.Close()
	result := NewCELEvaluator().Evaluate(context.Background(), api.HealthCheck{Expression: "true", HTTPProbe: &api.HTTPProbe{URL: server.URL}}, &api.Application{})
	require.Equal(t, api.HealthDegraded, result.Status)
	require.Equal(t, "ResponseTooLarge", result.HTTPResult.Reason)
}
