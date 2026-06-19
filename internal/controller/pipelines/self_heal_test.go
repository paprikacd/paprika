package pipelines

import (
	"context"
	"strconv"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

var (
	selfHealTestNow     = time.Now().UTC().Truncate(time.Second)
	selfHealTestCtx     = context.Background()
	selfHealTestNS      = "default"
	selfHealTestAppName = "self-heal-app"
)

func newSelfHealTestClient(objs ...client.Object) client.Client {
	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
}

func selfHealRelease(name string, phase pipelinesv1alpha1.ReleasePhase) *pipelinesv1alpha1.Release {
	return &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: selfHealTestNS,
		},
		Status: pipelinesv1alpha1.ReleaseStatus{
			Phase: phase,
		},
	}
}

func selfHealReleaseWithOnFailure(name string, phase pipelinesv1alpha1.ReleasePhase, onFailure *pipelinesv1alpha1.FailureAction) *pipelinesv1alpha1.Release {
	release := selfHealRelease(name, phase)
	release.Spec.OnFailure = onFailure
	return release
}

func selfHealApp(phase pipelinesv1alpha1.ApplicationPhase, health pipelinesv1alpha1.HealthStatus, outOfSync int) *pipelinesv1alpha1.Application {
	return &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{
			Name:      selfHealTestAppName,
			Namespace: selfHealTestNS,
		},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			SyncPolicy: pipelinesv1alpha1.SyncAuto,
			SelfHeal: &pipelinesv1alpha1.SelfHealConfig{
				AutoSyncOnDrift:           true,
				AutoRevertOnHealthFailure: true,
			},
		},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Phase:      phase,
			Health:     health,
			OutOfSync:  outOfSync,
			ReleaseRef: "release-1",
		},
	}
}

func selfHealReconciler(c client.Client) *ApplicationReconciler {
	return &ApplicationReconciler{
		client:        c,
		EventRecorder: record.NewFakeRecorder(10),
		now:           func() time.Time { return selfHealTestNow },
	}
}

func requireSelfHealCondition(t *testing.T, app *pipelinesv1alpha1.Application, wantStatus metav1.ConditionStatus, wantReason string) {
	t.Helper()
	cond := meta.FindStatusCondition(app.Status.Conditions, selfHealConditionType)
	if cond == nil {
		t.Fatalf("expected SelfHealed condition")
	}
	if cond.Status != wantStatus || cond.Reason != wantReason {
		t.Fatalf("condition status=%s reason=%s, want status=%s reason=%s", cond.Status, cond.Reason, wantStatus, wantReason)
	}
	if !cond.LastTransitionTime.Equal(&metav1.Time{Time: selfHealTestNow}) {
		t.Fatalf("condition LastTransitionTime = %v, want %v", cond.LastTransitionTime, selfHealTestNow)
	}
}

func requireNoSelfHealCondition(t *testing.T, app *pipelinesv1alpha1.Application) {
	t.Helper()
	if meta.FindStatusCondition(app.Status.Conditions, selfHealConditionType) != nil {
		t.Fatalf("expected no SelfHealed condition")
	}
}

func requireNoAnnotation(t *testing.T, r *ApplicationReconciler, key string) {
	t.Helper()
	var release pipelinesv1alpha1.Release
	if err := r.client.Get(selfHealTestCtx, types.NamespacedName{Name: "release-1", Namespace: selfHealTestNS}, &release); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if _, ok := release.Annotations[key]; ok {
		t.Fatalf("annotation %s should not be set", key)
	}
}

func requireAnnotation(t *testing.T, r *ApplicationReconciler, key, want string) {
	t.Helper()
	var release pipelinesv1alpha1.Release
	if err := r.client.Get(selfHealTestCtx, types.NamespacedName{Name: "release-1", Namespace: selfHealTestNS}, &release); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if got := release.Annotations[key]; got != want {
		t.Fatalf("annotation %s = %q, want %q", key, got, want)
	}
}

func TestApplicationReconciler_reconcileSelfHeal(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		setup func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application)
		want  func(t *testing.T, r *ApplicationReconciler, app *pipelinesv1alpha1.Application)
	}{
		{
			name: "drift sync annotates complete release",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
				app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
				return selfHealReconciler(newSelfHealTestClient(release, app)), app
			},
			want: func(t *testing.T, r *ApplicationReconciler, app *pipelinesv1alpha1.Application) {
				requireAnnotation(t, r, resyncAnnotation, strconv.FormatInt(selfHealTestNow.Unix(), 10))
				if app.Status.LastSelfHealTime == nil || !app.Status.LastSelfHealTime.Equal(&metav1.Time{Time: selfHealTestNow}) {
					t.Fatalf("lastSelfHealTime not set to expected time")
				}
				requireSelfHealCondition(t, app, metav1.ConditionTrue, "DriftDetected")
			},
		},
		{
			name: "drift sync blocked by manual sync",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
				app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
				app.Spec.SyncPolicy = pipelinesv1alpha1.SyncManual
				return selfHealReconciler(newSelfHealTestClient(release, app)), app
			},
			want: func(t *testing.T, r *ApplicationReconciler, app *pipelinesv1alpha1.Application) {
				requireNoAnnotation(t, r, resyncAnnotation)
				requireSelfHealCondition(t, app, metav1.ConditionFalse, "NoActionNeeded")
			},
		},
		{
			name: "cooldown prevents second action",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
				app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
				app.Spec.SelfHeal.Cooldown = "10m"
				app.Status.LastSelfHealTime = &metav1.Time{Time: selfHealTestNow.Add(-5 * time.Minute)}
				return selfHealReconciler(newSelfHealTestClient(release, app)), app
			},
			want: func(t *testing.T, r *ApplicationReconciler, app *pipelinesv1alpha1.Application) {
				requireNoAnnotation(t, r, resyncAnnotation)
				requireSelfHealCondition(t, app, metav1.ConditionFalse, "CooldownActive")
			},
		},
		{
			name: "drift sync release not found",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
				return selfHealReconciler(newSelfHealTestClient()), app
			},
			want: func(t *testing.T, _ *ApplicationReconciler, app *pipelinesv1alpha1.Application) {
				requireNoSelfHealCondition(t, app)
			},
		},
		{
			name: "drift sync skipped when release not complete",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				release := selfHealRelease("release-1", pipelinesv1alpha1.ReleasePromoting)
				app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
				return selfHealReconciler(newSelfHealTestClient(release, app)), app
			},
			want: func(t *testing.T, r *ApplicationReconciler, app *pipelinesv1alpha1.Application) {
				requireNoAnnotation(t, r, resyncAnnotation)
				requireNoSelfHealCondition(t, app)
			},
		},
		{
			name: "drift sync reports condition when resync annotation already present",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
				release.Annotations = map[string]string{resyncAnnotation: "existing"}
				app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
				return selfHealReconciler(newSelfHealTestClient(release, app)), app
			},
			want: func(t *testing.T, r *ApplicationReconciler, app *pipelinesv1alpha1.Application) {
				requireAnnotation(t, r, resyncAnnotation, "existing")
				requireSelfHealCondition(t, app, metav1.ConditionTrue, "DriftDetected")
			},
		},
		{
			name: "health revert annotates release",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				onFailure := &pipelinesv1alpha1.FailureAction{Action: rollbackAction}
				release := selfHealReleaseWithOnFailure("release-1", pipelinesv1alpha1.ReleaseComplete, onFailure)
				app := selfHealApp(pipelinesv1alpha1.ApplicationDegraded, pipelinesv1alpha1.HealthDegraded, 0)
				return selfHealReconciler(newSelfHealTestClient(release, app)), app
			},
			want: func(t *testing.T, r *ApplicationReconciler, app *pipelinesv1alpha1.Application) {
				requireAnnotation(t, r, rollbackAnnotation, strconv.FormatInt(selfHealTestNow.Unix(), 10))
				if app.Status.LastSelfHealTime == nil || !app.Status.LastSelfHealTime.Equal(&metav1.Time{Time: selfHealTestNow}) {
					t.Fatalf("lastSelfHealTime not set to expected time")
				}
				requireSelfHealCondition(t, app, metav1.ConditionTrue, "HealthDegraded")
			},
		},
		{
			name: "health revert blocked when release not complete",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				onFailure := &pipelinesv1alpha1.FailureAction{Action: rollbackAction}
				release := selfHealReleaseWithOnFailure("release-1", pipelinesv1alpha1.ReleaseFailed, onFailure)
				app := selfHealApp(pipelinesv1alpha1.ApplicationDegraded, pipelinesv1alpha1.HealthDegraded, 0)
				return selfHealReconciler(newSelfHealTestClient(release, app)), app
			},
			want: func(t *testing.T, r *ApplicationReconciler, _ *pipelinesv1alpha1.Application) {
				requireNoAnnotation(t, r, rollbackAnnotation)
			},
		},
		{
			name: "health revert blocked without rollback on failure",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
				app := selfHealApp(pipelinesv1alpha1.ApplicationDegraded, pipelinesv1alpha1.HealthDegraded, 0)
				return selfHealReconciler(newSelfHealTestClient(release, app)), app
			},
			want: func(t *testing.T, r *ApplicationReconciler, _ *pipelinesv1alpha1.Application) {
				requireNoAnnotation(t, r, rollbackAnnotation)
			},
		},
		{
			name: "health revert skipped when rollback annotation present",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				onFailure := &pipelinesv1alpha1.FailureAction{Action: rollbackAction}
				release := selfHealReleaseWithOnFailure("release-1", pipelinesv1alpha1.ReleaseComplete, onFailure)
				release.Annotations = map[string]string{rollbackAnnotation: "existing"}
				app := selfHealApp(pipelinesv1alpha1.ApplicationDegraded, pipelinesv1alpha1.HealthDegraded, 0)
				return selfHealReconciler(newSelfHealTestClient(release, app)), app
			},
			want: func(t *testing.T, r *ApplicationReconciler, _ *pipelinesv1alpha1.Application) {
				requireAnnotation(t, r, rollbackAnnotation, "existing")
			},
		},
		{
			name: "drift takes precedence over health revert",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				onFailure := &pipelinesv1alpha1.FailureAction{Action: rollbackAction}
				release := selfHealReleaseWithOnFailure("release-1", pipelinesv1alpha1.ReleaseComplete, onFailure)
				app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthDegraded, 1)
				return selfHealReconciler(newSelfHealTestClient(release, app)), app
			},
			want: func(t *testing.T, r *ApplicationReconciler, app *pipelinesv1alpha1.Application) {
				requireAnnotation(t, r, resyncAnnotation, strconv.FormatInt(selfHealTestNow.Unix(), 10))
				requireNoAnnotation(t, r, rollbackAnnotation)
				requireSelfHealCondition(t, app, metav1.ConditionTrue, "DriftDetected")
			},
		},
		{
			name: "nil event recorder does not panic",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
				app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
				return &ApplicationReconciler{
					client: newSelfHealTestClient(release, app),
					now:    func() time.Time { return selfHealTestNow },
				}, app
			},
			want: func(t *testing.T, _ *ApplicationReconciler, app *pipelinesv1alpha1.Application) {
				requireSelfHealCondition(t, app, metav1.ConditionTrue, "DriftDetected")
			},
		},
		{
			name: "blocked phase sets phase blocked",
			setup: func(t *testing.T) (*ApplicationReconciler, *pipelinesv1alpha1.Application) {
				release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
				app := selfHealApp(pipelinesv1alpha1.ApplicationPromoting, pipelinesv1alpha1.HealthHealthy, 1)
				return selfHealReconciler(newSelfHealTestClient(release, app)), app
			},
			want: func(t *testing.T, r *ApplicationReconciler, app *pipelinesv1alpha1.Application) {
				requireNoAnnotation(t, r, resyncAnnotation)
				requireSelfHealCondition(t, app, metav1.ConditionFalse, "PhaseBlocked")
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			r, app := tc.setup(t)
			if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
				t.Fatalf("reconcileSelfHeal failed: %v", err)
			}
			tc.want(t, r, app)
		})
	}
}
