package apiserver

import (
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/stretchr/testify/require"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

//nolint:gosec // Deliberately fake credentials exercise endpoint redaction.
func TestHealthEvidenceOmitsProbeCredentials(t *testing.T) {
	app := &pipelinesv1alpha1.Application{}
	app.Spec.HealthChecks = []pipelinesv1alpha1.HealthCheck{{Name: "ready", Expression: "http.statusCode == 200", Interval: "30s", HTTPProbe: &pipelinesv1alpha1.HTTPProbe{
		URL: "https://user:password@example.com/ready?token=secret#secret", Method: "GET", Headers: map[string]string{"Authorization": "secret"}, Body: "secret", ExpectedStatus: 200, Timeout: 5,
	}}}
	converted := convertApplication(app)
	require.Len(t, converted.HealthCheckDefinitions, 1)
	probe := converted.HealthCheckDefinitions[0].HttpProbe
	require.Equal(t, "https://example.com/ready", probe.Url)
	require.Empty(t, probe.Headers)
	require.Empty(t, probe.Body)
	require.EqualValues(t, 200, probe.ExpectedStatus)
	require.Equal(t, "http.statusCode == 200", converted.HealthCheckDefinitions[0].Expression)
	rel := &pipelinesv1alpha1.Release{}
	rel.Spec.Verify = []pipelinesv1alpha1.GateConfig{{Type: "smoke-test", Endpoint: "https://user:password@example.com/ready?token=secret", Timeout: 20}}
	evidence := convertRelease(rel).VerificationChecks
	require.Len(t, evidence, 1)
	require.Equal(t, "https://example.com/ready", evidence[0].Endpoint)
	require.EqualValues(t, 20, evidence[0].TimeoutSeconds)
	require.Equal(t, "[invalid endpoint]", healthEndpoint("https://%password"))
}

func TestHealthFailureEvidenceReachesAPI(t *testing.T) {
	now := metav1.NewTime(time.Unix(1800000000, 0))
	app := &pipelinesv1alpha1.Application{}
	app.Status.HealthChecks = []pipelinesv1alpha1.HealthCheckResult{{Name: "deepcheck", Status: pipelinesv1alpha1.HealthHealthy, RecentFailures: []pipelinesv1alpha1.HealthCheckFailure{{CheckedAt: now, Status: pipelinesv1alpha1.HealthDegraded, Reason: "Timeout", Message: "Probe timed out", DurationMillis: 5000, HTTPBody: "excerpt", BodyTruncated: true}}}}
	result := convertApplication(app).HealthChecks[0]
	require.Len(t, result.RecentFailures, 1)
	require.EqualValues(t, 1800000000, result.RecentFailures[0].CheckedAt)
	require.Equal(t, "Timeout", result.RecentFailures[0].Reason)
	require.True(t, result.RecentFailures[0].BodyTruncated)
}
