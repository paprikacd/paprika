package main

import (
	"context"
	"time"

	"connectrpc.com/connect"

	proto "github.com/benebsworth/paprika/internal/api/paprika/v1"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/health"
)

// seedHealthEvidence gives the first fixture app a recovered dependency failure
// so the real API and compiled UI exercise historical evidence without an outage.
func seedHealthEvidence(app *api.Application) {
	now := time.Now().UTC()
	check := api.HealthCheck{Name: "internal-deepcheck", Interval: "30s", Expression: "http.statusCode == 200 && http.json.status == 'ok'", HTTPProbe: &api.HTTPProbe{URL: "http://frontend.apps.svc/deepcheck", ExpectedStatus: 200, Timeout: 5}, SLO: &api.AvailabilitySLO{TargetPercentage: 99.9, Window: "30d"}}
	healthy := `{"status":"ok","checks":[{"name":"frontend_backend","ok":true,"latency":"12ms"},{"name":"database_app","ok":true,"latency":"3ms"}]}`
	failed := `{"status":"degraded","checks":[{"name":"frontend_backend","ok":true,"latency":"12ms"},{"name":"database_app","ok":false,"latency":"5000ms","error":"dependency unavailable"}]}`
	history := health.RecordSLO(check, nil, api.HealthDegraded, now.Add(-5*time.Minute))
	history = health.RecordSLO(check, history, api.HealthHealthy, now)
	app.Spec.HealthChecks = []api.HealthCheck{check}

	at := metav1.NewTime(now)
	app.Status.HealthChecks = []api.HealthCheckResult{{Name: check.Name, Status: api.HealthHealthy, Message: "check passed", CheckedAt: &at, HTTPStatusCode: 200, HTTPBody: healthy, DurationMillis: 18, ConfigurationHash: health.MeasurementHash(check), SLOHistory: history, RecentFailures: []api.HealthCheckFailure{
		{CheckedAt: metav1.NewTime(now.Add(-5 * time.Minute)), Status: api.HealthDegraded, Reason: "UnexpectedStatus", Message: "Expected HTTP 200, received HTTP 503", HTTPStatusCode: 503, DurationMillis: 5012, HTTPBody: failed},
	}}}
}

// GetApplication includes the same configured ownership that the fixture's
// dedicated ownership endpoint advertises. The none mode uses the base server.
func (c *consoleServer) GetApplication(ctx context.Context, req *connect.Request[proto.GetApplicationRequest]) (*connect.Response[proto.GetApplicationResponse], error) {
	response, err := c.PaprikaServer.GetApplication(ctx, req)
	if err != nil {
		return nil, err
	}
	ownership, err := c.GetApplicationOwnership(ctx, connect.NewRequest(&proto.GetApplicationOwnershipRequest{Namespace: req.Msg.GetNamespace(), Name: req.Msg.GetName()}))
	if err != nil {
		return nil, err
	}
	if response.Msg.Application != nil {
		response.Msg.Application.Operations = ownership.Msg.Ownership
	}
	return response, nil
}
