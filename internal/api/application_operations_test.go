package apiserver

import (
	"context"
	"net/url"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	pb "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/health"
)

func TestApplicationOperationsAuthorizedAndDefensive(t *testing.T) {
	app := &api.Application{ObjectMeta: metav1.ObjectMeta{Name: "checkout", Namespace: "tenant"}, Spec: api.ApplicationSpec{Project: "payments", Operations: &api.ApplicationOperations{
		Links:    []api.OperationalLink{{Kind: "dashboard", Label: "Grafana", URL: "https://grafana.example/d/app"}, {Kind: "custom", Label: "Unsafe", URL: "javascript:alert(1)"}, {Kind: "logs", Label: "Credentials", URL: (&url.URL{Scheme: "https", Host: "example.com", User: url.UserPassword("test-user", "test-value")}).String()}},
		Metadata: map[string]api.OperationalValue{"Environment": "production"},
	}}}
	server := consoleStubServer(t)
	server.client = newArtifactTestClient(app)
	response, err := server.GetApplicationOwnership(context.Background(), connect.NewRequest(&pb.GetApplicationOwnershipRequest{Namespace: "tenant", Name: "checkout"}))
	require.NoError(t, err)
	require.Equal(t, pb.DataState_DATA_STATE_OK, response.Msg.Ownership.State)
	require.Len(t, response.Msg.Ownership.Links, 1)
	require.Equal(t, "Grafana", response.Msg.Ownership.Links[0].Label)
	require.Equal(t, "production", convertOperationalMetadata(app.Spec.Operations)["Environment"])
	ns := "tenant"
	require.Equal(t, pb.DataState_DATA_STATE_OK, server.operationsDataSource(context.Background(), &ns).State)
	denied := NewPaprikaServer(server.client, nil, WithAuthorizer(auth.NewRBACAuthorizer([]auth.RBACRule{{Subjects: []string{"alice"}, Actions: []string{"read"}, Resources: []string{"applications"}, Namespaces: []string{"tenant"}, Projects: []string{"other"}}})))
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})
	_, err = denied.applicationOperations(ctx, "tenant", "checkout")
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	require.Equal(t, pb.DataState_DATA_STATE_NOT_CONFIGURED, denied.operationsDataSource(ctx, &ns).State)
	require.Equal(t, pb.DataState_DATA_STATE_NOT_CONFIGURED, convertOperations(nil).State)
}

func TestApplicationSLOResponseUsesCurrentClockAndConfiguration(t *testing.T) {
	now := time.Unix(1800000000, 0)
	check := api.HealthCheck{Name: "uptime", Interval: "30s", HTTPProbe: &api.HTTPProbe{URL: "http://frontend.tenant.svc/deepcheck"}, SLO: &api.AvailabilitySLO{TargetPercentage: 99.9, Window: "30d"}}
	app := &api.Application{Spec: api.ApplicationSpec{HealthChecks: []api.HealthCheck{check}}, Status: api.ApplicationStatus{HealthChecks: []api.HealthCheckResult{{Name: "uptime", Status: api.HealthHealthy, DurationMillis: 12, SLOHistory: health.RecordSLO(check, nil, api.HealthHealthy, now)}}}}
	result := convertApplicationHealthChecks(app, now)[0]
	require.EqualValues(t, 12, result.DurationMillis)
	require.Equal(t, "Collecting", result.Slo.State)
	require.EqualValues(t, 1, result.Slo.Healthy)
	require.Less(t, result.Slo.WindowCoveragePercentage, 0.01)
	require.Equal(t, "Stale", convertApplicationHealthChecks(app, now.Add(time.Minute+time.Second))[0].Slo.State)
	app.Spec.HealthChecks[0].HTTPProbe.URL = "http://replacement.tenant.svc/deepcheck"
	require.Zero(t, convertApplicationHealthChecks(app, now)[0].Slo.Healthy)
}
