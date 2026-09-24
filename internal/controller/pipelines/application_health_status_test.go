package pipelines

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/health"
)

func TestHealthSLOPersistsFailureRecoveryAndRestart(t *testing.T) {
	var calls, status atomic.Int32
	status.Store(http.StatusOK)
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); w.WriteHeader(int(status.Load())) }))
	defer endpoint.Close()
	check := api.HealthCheck{Name: "uptime", Interval: "30s", Expression: "true", HTTPProbe: &api.HTTPProbe{URL: endpoint.URL, Timeout: 1}, SLO: &api.AvailabilitySLO{TargetPercentage: 99.9, Window: "30d"}}
	app := &api.Application{ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "tenant"}, Spec: api.ApplicationSpec{HealthChecks: []api.HealthCheck{check}}, Status: api.ApplicationStatus{ReleaseRef: "retain-me", Phase: api.ApplicationFailed}}
	scheme := runtime.NewScheme()
	require.NoError(t, api.AddToScheme(scheme))
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&api.Application{}).WithObjects(app).Build()
	now := time.Unix(1800000000, 0).UTC()
	evaluator := health.NewCELEvaluator()
	r := NewApplicationReconciler(cl)
	r.HealthEval = evaluator
	r.now = func() time.Time { return now }
	require.NoError(t, r.reconcileHealthStatus(context.Background(), app))
	require.NoError(t, r.reconcileHealthStatus(context.Background(), app))
	require.EqualValues(t, 1, calls.Load(), "cached checks must not create synthetic uptime observations")
	status.Store(http.StatusServiceUnavailable)
	now = now.Add(30 * time.Second)
	require.NoError(t, r.reconcileHealthStatus(context.Background(), app))
	require.Equal(t, api.HealthDegraded, app.Status.HealthChecks[0].Status, "HTTP failure must fail even with a true CEL expression")
	// A new reconciler recovers evidence from Kubernetes status, not process memory.
	restored := &api.Application{}
	require.NoError(t, cl.Get(context.Background(), client.ObjectKeyFromObject(app), restored))
	require.Equal(t, "retain-me", restored.Status.ReleaseRef)
	require.Equal(t, api.ApplicationFailed, restored.Status.Phase)
	r = NewApplicationReconciler(cl)
	r.HealthEval = evaluator
	r.now = func() time.Time { return now }
	status.Store(http.StatusOK)
	now = now.Add(time.Minute)
	require.NoError(t, r.reconcileHealthStatus(context.Background(), restored))
	summary := health.SummarizeSLO(check, restored.Status.HealthChecks[0].SLOHistory, now)
	require.EqualValues(t, 2, summary.Healthy)
	require.EqualValues(t, 1, summary.Unhealthy)
	require.EqualValues(t, 1, summary.Unknown)
	require.Equal(t, api.HealthHealthy, restored.Status.HealthChecks[0].Status)
	require.Len(t, restored.Status.HealthChecks[0].RecentFailures, 1)
	failure := restored.Status.HealthChecks[0].RecentFailures[0]
	require.EqualValues(t, 503, failure.HTTPStatusCode)
	require.Equal(t, "UnexpectedStatus", failure.Reason)
	require.Equal(t, "Expected HTTP 200, received HTTP 503", failure.Message)
	require.Equal(t, 30*time.Second, nextHealthObservation(restored, now))
}
