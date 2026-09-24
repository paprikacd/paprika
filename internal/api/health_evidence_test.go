package apiserver

import (
	"testing"

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
