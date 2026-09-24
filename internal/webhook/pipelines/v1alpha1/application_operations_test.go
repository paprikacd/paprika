package v1alpha1

import (
	"testing"

	"github.com/stretchr/testify/require"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestOperationsValidation(t *testing.T) {
	app := &api.Application{Spec: api.ApplicationSpec{HealthChecks: []api.HealthCheck{{Name: "uptime", Interval: "30s", HTTPProbe: &api.HTTPProbe{URL: "http://frontend.tenant.svc/deepcheck", Timeout: 8}, SLO: &api.AvailabilitySLO{TargetPercentage: 99.9, Window: "30d"}}}, Operations: &api.ApplicationOperations{Links: []api.OperationalLink{{Kind: "dashboard", Label: "Grafana", URL: "https://grafana.example/d/app"}}}}}
	require.Empty(t, validateApplicationOperations(app))
	app.Spec.HealthChecks[0].HTTPProbe.Method = "POST"
	app.Spec.Operations.Links[0].URL = "javascript:alert(1)"
	problems := validateApplicationOperations(app)
	require.Len(t, problems, 2)
	require.Equal(t, "spec.healthChecks[0].slo", problems[0].Field)
	require.Equal(t, "spec.operations.links[0].url", problems[1].Field)
	require.NotContains(t, problems.ToAggregate().Error(), "javascript")
}
