package pipelines

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/health"
	"github.com/benebsworth/paprika/internal/source"
)

func setHealthFailureThreshold(t *testing.T, config *api.SelfHealConfig, threshold int) {
	t.Helper()
	require.NoError(t, json.Unmarshal([]byte(`{"healthFailureThreshold":`+strconv.Itoa(threshold)+`}`), config))
}
func healthFailureCount(t *testing.T, result api.HealthCheckResult) int {
	t.Helper()
	encoded, err := json.Marshal(result)
	require.NoError(t, err)
	var value struct {
		Count int `json:"consecutiveFailures"`
	}
	require.NoError(t, json.Unmarshal(encoded, &value))
	return value.Count
}
func setHealthFailureCount(t *testing.T, result *api.HealthCheckResult, count int) {
	t.Helper()
	require.NoError(t, json.Unmarshal([]byte(`{"consecutiveFailures":`+strconv.Itoa(count)+`}`), result))
}

func TestSelfHealThresholdRequiresDistinctPersistedFailures(t *testing.T) {
	var calls atomic.Int32
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer endpoint.Close()
	now := selfHealTestNow
	app := selfHealApp(api.ApplicationHealthy, api.HealthHealthy, 0)
	setHealthFailureThreshold(t, app.Spec.SelfHeal, 3)
	app.Spec.HealthChecks = []api.HealthCheck{{Name: "ready", Interval: "30s", Expression: "http.statusCode == 200", HTTPProbe: &api.HTTPProbe{URL: endpoint.URL, Timeout: 1}}}
	release := selfHealReleaseWithOnFailure("release-1", api.ReleaseComplete, &api.FailureAction{Action: rollbackAction})
	scheme := runtime.NewScheme()
	require.NoError(t, api.AddToScheme(scheme))
	cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, release).WithStatusSubresource(app, release).Build()
	r := selfHealReconciler(cl)
	r.HealthEval = health.NewCELEvaluator()
	r.now = func() time.Time { return now }
	require.NoError(t, r.reconcileHealthStatus(t.Context(), app))
	require.NoError(t, r.reconcileSelfHeal(t.Context(), app))
	requireNoAnnotation(t, r, rollbackAnnotation)
	require.Equal(t, 1, healthFailureCount(t, app.Status.HealthChecks[0]))
	for range 3 {
		now = now.Add(time.Second)
		require.NoError(t, r.reconcileHealthStatus(t.Context(), app))
		require.NoError(t, r.reconcileSelfHeal(t.Context(), app))
	}
	require.EqualValues(t, 1, calls.Load(), "cached reconciles do not measure another failure")
	require.Equal(t, 1, healthFailureCount(t, app.Status.HealthChecks[0]))
	requireNoAnnotation(t, r, rollbackAnnotation)
	restored := &api.Application{}
	require.NoError(t, cl.Get(t.Context(), client.ObjectKeyFromObject(app), restored))
	app = restored
	r = selfHealReconciler(cl)
	r.HealthEval = health.NewCELEvaluator()
	r.now = func() time.Time { return now }
	for attempt := 2; attempt <= 3; attempt++ {
		now = selfHealTestNow.Add(time.Duration(attempt-1) * 30 * time.Second)
		require.NoError(t, r.reconcileHealthStatus(t.Context(), app))
		require.NoError(t, r.reconcileSelfHeal(t.Context(), app))
		require.Equal(t, attempt, healthFailureCount(t, app.Status.HealthChecks[0]))
		if attempt < 3 {
			requireNoAnnotation(t, r, rollbackAnnotation)
		}
	}
	requireAnnotation(t, r, rollbackAnnotation, strconv.FormatInt(now.Unix(), 10))
	require.EqualValues(t, 3, calls.Load())
}

func TestHealthFailureStreakResetsAndBounds(t *testing.T) {
	check := api.HealthCheck{Name: "ready", Interval: "30s", Expression: "true"}
	now := metav1.NewTime(selfHealTestNow)
	previous := observationResult(check, nil, health.EvalResult{Name: check.Name, Status: api.HealthDegraded}, now, 0)
	require.Equal(t, 1, healthFailureCount(t, previous))
	setHealthFailureCount(t, &previous, 2)
	for _, tc := range []struct {
		name   string
		status api.HealthStatus
		age    time.Duration
		change bool
		want   int
	}{
		{"next failure", api.HealthDegraded, 30 * time.Second, false, 3},
		{"same observation", api.HealthDegraded, 0, false, 2},
		{"recovery", api.HealthHealthy, 30 * time.Second, false, 0},
		{"unknown", api.HealthUnknown, 30 * time.Second, false, 0},
		{"progressing", api.HealthProgressing, 30 * time.Second, false, 0},
		{"configuration changed", api.HealthDegraded, 30 * time.Second, true, 1},
		{"missing observation gap", api.HealthDegraded, 3 * time.Minute, false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			currentCheck := check
			if tc.change {
				currentCheck.Expression = "false"
			}
			current := observationResult(currentCheck, &previous, health.EvalResult{Name: check.Name, Status: tc.status}, metav1.NewTime(now.Add(tc.age)), 0)
			require.Equal(t, tc.want, healthFailureCount(t, current))
		})
	}
	setHealthFailureCount(t, &previous, 10)
	current := observationResult(check, &previous, health.EvalResult{Name: check.Name, Status: api.HealthDegraded}, metav1.NewTime(now.Add(30*time.Second)), 0)
	require.Equal(t, 10, healthFailureCount(t, current), "long incidents cannot grow the status counter without bound")
	recovered := observationResult(check, &previous, health.EvalResult{Name: check.Name, Status: api.HealthHealthy}, metav1.NewTime(now.Add(30*time.Second)), 0)
	current = observationResult(check, &recovered, health.EvalResult{Name: check.Name, Status: api.HealthDegraded}, metav1.NewTime(now.Add(time.Minute)), 0)
	require.Equal(t, 1, healthFailureCount(t, current))
}

func TestSelfHealThresholdRejectsMissingStaleOrOtherCheckEvidence(t *testing.T) {
	for _, mode := range []string{"missing", "stale", "future", "changed", "unknown", "separate-checks"} {
		t.Run(mode, func(t *testing.T) {
			app := selfHealApp(api.ApplicationHealthy, api.HealthDegraded, 0)
			setHealthFailureThreshold(t, app.Spec.SelfHeal, 3)
			check := api.HealthCheck{Name: "ready", Interval: "30s", Expression: "true"}
			app.Spec.HealthChecks = []api.HealthCheck{check}
			result := observationResult(check, nil, health.EvalResult{Name: check.Name, Status: api.HealthDegraded}, metav1.NewTime(selfHealTestNow), 0)
			setHealthFailureCount(t, &result, 3)
			switch mode {
			case "missing":
				result.CheckedAt = nil
			case "stale":
				result.CheckedAt = &metav1.Time{Time: selfHealTestNow.Add(-time.Minute)}
			case "future":
				result.CheckedAt = &metav1.Time{Time: selfHealTestNow.Add(time.Minute)}
			case "changed":
				result.ConfigurationHash = "previous-config"
			case "unknown":
				result.Status = api.HealthUnknown
			case "separate-checks":
				setHealthFailureCount(t, &result, 2)
				other := result
				other.Name = "other"
				app.Status.HealthChecks = append(app.Status.HealthChecks, other)
			}
			app.Status.HealthChecks = append(app.Status.HealthChecks, result)
			release := selfHealReleaseWithOnFailure("release-1", api.ReleaseComplete, &api.FailureAction{Action: rollbackAction})
			r := selfHealReconciler(newSelfHealTestClient(app, release))
			require.NoError(t, r.reconcileSelfHeal(t.Context(), app))
			requireNoAnnotation(t, r, rollbackAnnotation)
		})
	}
}

func TestSelfHealPendingActionsAreMutuallyExclusive(t *testing.T) {
	for _, pending := range []string{rollbackAnnotation, resyncAnnotation} {
		t.Run(pending, func(t *testing.T) {
			app := selfHealApp(api.ApplicationHealthy, api.HealthDegraded, 0)
			opposite := rollbackAnnotation
			if pending == rollbackAnnotation {
				app.Status.OutOfSync = 1
				opposite = resyncAnnotation
			}
			release := selfHealReleaseWithOnFailure("release-1", api.ReleaseComplete, &api.FailureAction{Action: rollbackAction})
			release.Annotations = map[string]string{pending: "already-requested"}
			r := selfHealReconciler(newSelfHealTestClient(app, release))
			require.NoError(t, r.reconcileSelfHeal(t.Context(), app))
			requireNoAnnotation(t, r, opposite)
			requireAnnotation(t, r, pending, "already-requested")
			require.Nil(t, app.Status.LastSelfHealTime)
		})
	}
}

type recoveryDiff struct{ calls int }

func (d *recoveryDiff) ComputeDiff(context.Context, []unstructured.Unstructured, *engine.DiffOptions) (*engine.DiffResult, error) {
	d.calls++
	return &engine.DiffResult{Unchanged: []engine.ResourceDiff{{Kind: "Deployment", Namespace: "default", Name: "web", Action: "Unchanged"}}, Live: []unstructured.Unstructured{{Object: map[string]any{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]any{"name": "web", "namespace": "default", "generation": int64(3)}, "spec": map[string]any{"replicas": int64(1)}, "status": map[string]any{"observedGeneration": int64(3), "replicas": int64(1), "updatedReplicas": int64(1), "readyReplicas": int64(1), "availableReplicas": int64(1)}}}}}, nil
}
func TestHeldReleaseRefreshesLiveObservationsWithoutRemediation(t *testing.T) {
	app := selfHealApp(api.ApplicationRolledBack, api.HealthHealthy, 7)
	app.Spec.Source = api.ApplicationSource{Type: api.SourceTypeGit, RepoURL: "https://example.com/repo.git", Revision: "main"}
	app.Spec.Stages = []api.ApplicationPromotionStage{{Name: "prod", Ring: 1, Cluster: api.ClusterRef{Mode: api.ClusterModeInCluster}}}
	app.Status.SourceHash = "same"
	app.Status.SourceRevision = "same-revision"
	app.Status.ReleaseRef = applicationReleaseName(app, &app.Spec.Stages[0])
	app.Status.ResourceHealth = []api.ResourceHealth{{Kind: "Deployment", Namespace: "default", Name: "web", Health: "Progressing"}}
	release := selfHealRelease(app.Status.ReleaseRef, api.ReleaseRolledBack)
	release.Annotations = map[string]string{autoRetryCountAnnotation: "3", sourceHashAnnotation: "same"}
	template := &api.Template{ObjectMeta: metav1.ObjectMeta{Name: app.Name + "-template", Namespace: app.Namespace}}
	scheme := runtime.NewScheme()
	require.NoError(t, api.AddToScheme(scheme))
	cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, release, template).WithStatusSubresource(app, release).Build()
	diff := &recoveryDiff{}
	r := &ApplicationReconciler{client: cl, Scheme: scheme, DiffEngine: diff, TemplateRenderer: &staticSourceRenderer{result: &source.ResolveResult{Hash: "same", Revision: "same-revision"}}}
	_, err := r.handleHealthyPhase(t.Context(), app)
	require.NoError(t, err)
	require.Equal(t, 1, diff.calls, "holding the release must not freeze live observations")
	stored := &api.Application{}
	require.NoError(t, cl.Get(t.Context(), client.ObjectKeyFromObject(app), stored))
	require.Equal(t, api.ApplicationRolledBack, stored.Status.Phase)
	require.Equal(t, release.Name, stored.Status.ReleaseRef)
	require.Zero(t, stored.Status.OutOfSync)
	require.Len(t, stored.Status.ResourceHealth, 1)
	require.Equal(t, "Healthy", stored.Status.ResourceHealth[0].Health)
	require.True(t, conditionIsTrue(stored, releaseRetriesExhaustedCondition))
	unchanged := &api.Release{}
	require.NoError(t, cl.Get(t.Context(), client.ObjectKeyFromObject(release), unchanged))
	require.Equal(t, api.ReleaseRolledBack, unchanged.Status.Phase)
	require.Empty(t, unchanged.Annotations[resyncAnnotation])
	require.Empty(t, unchanged.Annotations[rollbackAnnotation])
	require.Equal(t, "3", unchanged.Annotations[autoRetryCountAnnotation])
}

type racingSelfHealClient struct {
	client.Client
	pending  string
	injected bool
}

func (c *racingSelfHealClient) Patch(ctx context.Context, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
	if _, ok := obj.(*api.Release); ok && !c.injected {
		c.injected = true
		latest := &api.Release{}
		if err := c.Client.Get(ctx, client.ObjectKeyFromObject(obj), latest); err != nil {
			return err
		}
		if latest.Annotations == nil {
			latest.Annotations = map[string]string{}
		}
		latest.Annotations[c.pending] = "concurrent-action"
		if err := c.Client.Update(ctx, latest); err != nil {
			return err
		}
	}
	return c.Client.Patch(ctx, obj, patch, opts...)
}
func TestSelfHealActionPatchRejectsConcurrentOppositeAction(t *testing.T) {
	for _, pending := range []string{rollbackAnnotation, resyncAnnotation} {
		t.Run(pending, func(t *testing.T) {
			app := selfHealApp(api.ApplicationHealthy, api.HealthDegraded, 0)
			opposite := rollbackAnnotation
			if pending == rollbackAnnotation {
				app.Status.OutOfSync = 1
				opposite = resyncAnnotation
			}
			release := selfHealReleaseWithOnFailure("release-1", api.ReleaseComplete, &api.FailureAction{Action: rollbackAction})
			racing := &racingSelfHealClient{Client: newSelfHealTestClient(app, release), pending: pending}
			r := selfHealReconciler(racing)
			require.Error(t, r.reconcileSelfHeal(t.Context(), app), "the stale action must conflict rather than adding a second request")
			requireNoAnnotation(t, r, opposite)
			requireAnnotation(t, r, pending, "concurrent-action")
			require.Nil(t, app.Status.LastSelfHealTime)
		})
	}
}
