package controller

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
		Client:        c,
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
	if err := r.Get(selfHealTestCtx, types.NamespacedName{Name: "release-1", Namespace: selfHealTestNS}, &release); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if _, ok := release.Annotations[key]; ok {
		t.Fatalf("annotation %s should not be set", key)
	}
}

func TestApplicationReconciler_reconcileSelfHeal_driftSyncAnnotatesCompleteRelease(t *testing.T) {
	release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
	app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
	r := selfHealReconciler(newSelfHealTestClient(release, app))

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	var updated pipelinesv1alpha1.Release
	if err := r.Get(selfHealTestCtx, types.NamespacedName{Name: "release-1", Namespace: selfHealTestNS}, &updated); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if got, want := updated.Annotations[resyncAnnotation], strconv.FormatInt(selfHealTestNow.Unix(), 10); got != want {
		t.Fatalf("resync annotation = %q, want %q", got, want)
	}
	if app.Status.LastSelfHealTime == nil || !app.Status.LastSelfHealTime.Equal(&metav1.Time{Time: selfHealTestNow}) {
		t.Fatalf("lastSelfHealTime not set to expected time")
	}
	requireSelfHealCondition(t, app, metav1.ConditionTrue, "DriftDetected")
}

func TestApplicationReconciler_reconcileSelfHeal_driftSyncBlockedByManualSync(t *testing.T) {
	release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
	app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
	app.Spec.SyncPolicy = pipelinesv1alpha1.SyncManual
	r := selfHealReconciler(newSelfHealTestClient(release, app))

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	requireNoAnnotation(t, r, resyncAnnotation)
	requireSelfHealCondition(t, app, metav1.ConditionFalse, "NoActionNeeded")
}

func TestApplicationReconciler_reconcileSelfHeal_cooldownPreventsSecondAction(t *testing.T) {
	release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
	app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
	app.Spec.SelfHeal.Cooldown = "10m"
	app.Status.LastSelfHealTime = &metav1.Time{Time: selfHealTestNow.Add(-5 * time.Minute)}
	r := selfHealReconciler(newSelfHealTestClient(release, app))

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	requireNoAnnotation(t, r, resyncAnnotation)
	requireSelfHealCondition(t, app, metav1.ConditionFalse, "CooldownActive")
}

func TestApplicationReconciler_reconcileSelfHeal_driftSyncReleaseNotFound(t *testing.T) {
	app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
	r := selfHealReconciler(newSelfHealTestClient())

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	requireNoSelfHealCondition(t, app)
}

func TestApplicationReconciler_reconcileSelfHeal_driftSyncSkippedWhenReleaseNotComplete(t *testing.T) {
	release := selfHealRelease("release-1", pipelinesv1alpha1.ReleasePromoting)
	app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
	r := selfHealReconciler(newSelfHealTestClient(release, app))

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	requireNoAnnotation(t, r, resyncAnnotation)
	requireNoSelfHealCondition(t, app)
}

func TestApplicationReconciler_reconcileSelfHeal_driftSyncSkippedWhenResyncAnnotationPresent(t *testing.T) {
	release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
	release.Annotations = map[string]string{resyncAnnotation: "existing"}
	app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
	r := selfHealReconciler(newSelfHealTestClient(release, app))

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	var updated pipelinesv1alpha1.Release
	if err := r.Get(selfHealTestCtx, types.NamespacedName{Name: "release-1", Namespace: selfHealTestNS}, &updated); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if got, want := updated.Annotations[resyncAnnotation], "existing"; got != want {
		t.Fatalf("resync annotation = %q, want %q", got, want)
	}
	requireNoSelfHealCondition(t, app)
}

func TestApplicationReconciler_reconcileSelfHeal_healthRevertAnnotatesRelease(t *testing.T) {
	onFailure := &pipelinesv1alpha1.FailureAction{Action: rollbackAction}
	release := selfHealReleaseWithOnFailure("release-1", pipelinesv1alpha1.ReleaseComplete, onFailure)
	app := selfHealApp(pipelinesv1alpha1.ApplicationDegraded, pipelinesv1alpha1.HealthDegraded, 0)
	r := selfHealReconciler(newSelfHealTestClient(release, app))

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	var updated pipelinesv1alpha1.Release
	if err := r.Get(selfHealTestCtx, types.NamespacedName{Name: "release-1", Namespace: selfHealTestNS}, &updated); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if got, want := updated.Annotations[rollbackAnnotation], strconv.FormatInt(selfHealTestNow.Unix(), 10); got != want {
		t.Fatalf("rollback annotation = %q, want %q", got, want)
	}
	if app.Status.LastSelfHealTime == nil || !app.Status.LastSelfHealTime.Equal(&metav1.Time{Time: selfHealTestNow}) {
		t.Fatalf("lastSelfHealTime not set to expected time")
	}
	requireSelfHealCondition(t, app, metav1.ConditionTrue, "HealthDegraded")
}

func TestApplicationReconciler_reconcileSelfHeal_healthRevertBlockedWhenReleaseNotComplete(t *testing.T) {
	onFailure := &pipelinesv1alpha1.FailureAction{Action: rollbackAction}
	release := selfHealReleaseWithOnFailure("release-1", pipelinesv1alpha1.ReleaseFailed, onFailure)
	app := selfHealApp(pipelinesv1alpha1.ApplicationDegraded, pipelinesv1alpha1.HealthDegraded, 0)
	r := selfHealReconciler(newSelfHealTestClient(release, app))

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	requireNoAnnotation(t, r, rollbackAnnotation)
}

func TestApplicationReconciler_reconcileSelfHeal_healthRevertBlockedWithoutRollbackOnFailure(t *testing.T) {
	release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
	app := selfHealApp(pipelinesv1alpha1.ApplicationDegraded, pipelinesv1alpha1.HealthDegraded, 0)
	r := selfHealReconciler(newSelfHealTestClient(release, app))

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	requireNoAnnotation(t, r, rollbackAnnotation)
}

func TestApplicationReconciler_reconcileSelfHeal_healthRevertSkippedWhenRollbackAnnotationPresent(t *testing.T) {
	onFailure := &pipelinesv1alpha1.FailureAction{Action: rollbackAction}
	release := selfHealReleaseWithOnFailure("release-1", pipelinesv1alpha1.ReleaseComplete, onFailure)
	release.Annotations = map[string]string{rollbackAnnotation: "existing"}
	app := selfHealApp(pipelinesv1alpha1.ApplicationDegraded, pipelinesv1alpha1.HealthDegraded, 0)
	r := selfHealReconciler(newSelfHealTestClient(release, app))

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	var updated pipelinesv1alpha1.Release
	if err := r.Get(selfHealTestCtx, types.NamespacedName{Name: "release-1", Namespace: selfHealTestNS}, &updated); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if got, want := updated.Annotations[rollbackAnnotation], "existing"; got != want {
		t.Fatalf("rollback annotation = %q, want %q", got, want)
	}
}

func TestApplicationReconciler_reconcileSelfHeal_driftTakesPrecedenceOverHealthRevert(t *testing.T) {
	onFailure := &pipelinesv1alpha1.FailureAction{Action: rollbackAction}
	release := selfHealReleaseWithOnFailure("release-1", pipelinesv1alpha1.ReleaseComplete, onFailure)
	app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthDegraded, 1)
	r := selfHealReconciler(newSelfHealTestClient(release, app))

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	var updated pipelinesv1alpha1.Release
	if err := r.Get(selfHealTestCtx, types.NamespacedName{Name: "release-1", Namespace: selfHealTestNS}, &updated); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if _, ok := updated.Annotations[resyncAnnotation]; !ok {
		t.Fatalf("expected resync annotation to be set")
	}
	if _, ok := updated.Annotations[rollbackAnnotation]; ok {
		t.Fatalf("rollback annotation should not be set when drift takes precedence")
	}
	requireSelfHealCondition(t, app, metav1.ConditionTrue, "DriftDetected")
}

func TestApplicationReconciler_reconcileSelfHeal_nilEventRecorderDoesNotPanic(t *testing.T) {
	release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
	app := selfHealApp(pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.HealthHealthy, 1)
	r := &ApplicationReconciler{
		Client: newSelfHealTestClient(release, app),
		now:    func() time.Time { return selfHealTestNow },
	}

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	requireSelfHealCondition(t, app, metav1.ConditionTrue, "DriftDetected")
}

func TestApplicationReconciler_reconcileSelfHeal_blockedPhaseSetsPhaseBlocked(t *testing.T) {
	release := selfHealRelease("release-1", pipelinesv1alpha1.ReleaseComplete)
	app := selfHealApp(pipelinesv1alpha1.ApplicationPromoting, pipelinesv1alpha1.HealthHealthy, 1)
	r := selfHealReconciler(newSelfHealTestClient(release, app))

	if err := r.reconcileSelfHeal(selfHealTestCtx, app); err != nil {
		t.Fatalf("reconcileSelfHeal failed: %v", err)
	}

	requireNoAnnotation(t, r, resyncAnnotation)
	requireSelfHealCondition(t, app, metav1.ConditionFalse, "PhaseBlocked")
}
