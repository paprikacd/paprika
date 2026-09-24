package pipelines

import (
	"context"
	"strconv"
	"testing"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/source"
)

// rolloutFixture drives reconcileApp end-to-end for the rollout story tests:
// the fake client stands in for the API server and the tests play the role of
// the Release controller by advancing release.Status.Phase between reconciles.
type rolloutFixture struct {
	t   *testing.T
	c   client.Client
	r   *ApplicationReconciler
	app *pipelinesv1alpha1.Application
}

func newRolloutFixture(t *testing.T, app *pipelinesv1alpha1.Application, objs ...client.Object) *rolloutFixture {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := pipelinesv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("scheme: %v", err)
	}
	builder := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(append([]client.Object{app}, objs...)...).
		WithStatusSubresource(
			&pipelinesv1alpha1.Application{},
			&pipelinesv1alpha1.Release{},
			&pipelinesv1alpha1.Stage{},
			&pipelinesv1alpha1.Template{},
		)
	c := builder.Build()
	return &rolloutFixture{
		t: t,
		c: c,
		r: &ApplicationReconciler{
			client: c,
			Scheme: scheme,
			TemplateRenderer: &staticSourceRenderer{result: &source.ResolveResult{
				Hash:     "rollout-hash-1",
				Revision: "rev-1",
			}},
		},
		app: app,
	}
}

func newRolloutApp(name string) *pipelinesv1alpha1.Application {
	return &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Source: pipelinesv1alpha1.ApplicationSource{
				Type:     pipelinesv1alpha1.SourceTypeGit,
				RepoURL:  "https://example.com/repo.git",
				Revision: "main",
				Path:     ".",
			},
			SyncPolicy: pipelinesv1alpha1.SyncAuto,
			Stages:     []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
		},
	}
}

// reconcile runs one reconcileApp against the CURRENT stored application state
// and returns the persisted object.
func (f *rolloutFixture) reconcile() *pipelinesv1alpha1.Application {
	f.t.Helper()
	if err := f.c.Get(context.Background(), client.ObjectKeyFromObject(f.app), f.app); err != nil {
		f.t.Fatalf("get app: %v", err)
	}
	if _, err := f.r.reconcileApp(context.Background(), f.app); err != nil {
		f.t.Fatalf("reconcileApp: %v", err)
	}
	return f.fetch()
}

func (f *rolloutFixture) fetch() *pipelinesv1alpha1.Application {
	f.t.Helper()
	var app pipelinesv1alpha1.Application
	if err := f.c.Get(context.Background(), client.ObjectKeyFromObject(f.app), &app); err != nil {
		f.t.Fatalf("get app: %v", err)
	}
	return &app
}

// setReleasePhase plays the Release controller: advance the named release's
// phase as it would after processing apply/canary/verify work.
func (f *rolloutFixture) setReleasePhase(name string, phase pipelinesv1alpha1.ReleasePhase) {
	f.t.Helper()
	var release pipelinesv1alpha1.Release
	if err := f.c.Get(context.Background(), client.ObjectKey{Name: name, Namespace: "default"}, &release); err != nil {
		f.t.Fatalf("get release %s: %v", name, err)
	}
	release.Status.Phase = phase
	if err := f.c.Status().Update(context.Background(), &release); err != nil {
		f.t.Fatalf("update release phase: %v", err)
	}
}

func (f *rolloutFixture) release(name string) *pipelinesv1alpha1.Release {
	f.t.Helper()
	var release pipelinesv1alpha1.Release
	if err := f.c.Get(context.Background(), client.ObjectKey{Name: name, Namespace: "default"}, &release); err != nil {
		f.t.Fatalf("get release %s: %v", name, err)
	}
	return &release
}

// expectPhase asserts the persisted phase and that exactly one phase condition
// is True — the exclusivity invariant that regressed live (cuttlefish reported
// Healthy=True, Pending=True and RolledBack=True simultaneously).
func (f *rolloutFixture) expectPhase(app *pipelinesv1alpha1.Application, want pipelinesv1alpha1.ApplicationPhase) {
	f.t.Helper()
	if app.Status.Phase != want {
		f.t.Fatalf("phase = %s, want %s", app.Status.Phase, want)
	}
	var truePhases []string
	for _, phaseType := range applicationPhaseConditionTypes {
		cond := meta.FindStatusCondition(app.Status.Conditions, phaseType)
		if cond != nil && cond.Status == metav1.ConditionTrue {
			truePhases = append(truePhases, phaseType)
		}
	}
	if len(truePhases) != 1 || truePhases[0] != string(want) {
		f.t.Fatalf("true phase conditions = %v, want exactly [%s] (conditions: %+v)",
			truePhases, want, app.Status.Conditions)
	}
}

func conditionIsTrue(app *pipelinesv1alpha1.Application, condType string) bool {
	cond := meta.FindStatusCondition(app.Status.Conditions, condType)
	return cond != nil && cond.Status == metav1.ConditionTrue
}

// TestRolloutStory_PromoteToHealthy drives a full happy-path rollout through
// the real reconcileApp path and asserts phase-condition exclusivity at every
// step of Pending → Promoting → Canarying → Verifying → Healthy.
func TestRolloutStory_PromoteToHealthy(t *testing.T) {
	t.Parallel()

	fx := newRolloutFixture(t, newRolloutApp("story-app"))

	// First reconcile: template + stage are reconciled, the release is
	// created and the app promotes.
	app := fx.reconcile()
	fx.expectPhase(app, pipelinesv1alpha1.ApplicationPromoting)
	releaseName := app.Status.ReleaseRef
	if releaseName == "" {
		t.Fatal("expected a release to be created")
	}

	// Release controller progresses the rollout; each step must leave exactly
	// one phase condition True.
	for _, step := range []struct {
		releasePhase pipelinesv1alpha1.ReleasePhase
		wantAppPhase pipelinesv1alpha1.ApplicationPhase
	}{
		{pipelinesv1alpha1.ReleasePromoting, pipelinesv1alpha1.ApplicationPromoting},
		{pipelinesv1alpha1.ReleaseCanarying, pipelinesv1alpha1.ApplicationCanarying},
		{pipelinesv1alpha1.ReleaseVerifying, pipelinesv1alpha1.ApplicationVerifying},
		{pipelinesv1alpha1.ReleaseComplete, pipelinesv1alpha1.ApplicationHealthy},
	} {
		fx.setReleasePhase(releaseName, step.releasePhase)
		app = fx.reconcile()
		fx.expectPhase(app, step.wantAppPhase)
	}

	// The first Healthy reconcile pins the source hash, which changes the
	// release identity — a replacement release flow starts for the pinned
	// source (by design).
	app = fx.reconcile()
	fx.expectPhase(app, pipelinesv1alpha1.ApplicationPending)
	if app.Status.SourceHash != "rollout-hash-1" {
		t.Fatalf("sourceHash = %q, want rollout-hash-1 pinned", app.Status.SourceHash)
	}

	// The pinned-identity release is created (carrying the source annotations)
	// and completes — the app recovers to Healthy and surfaces the deployed
	// revision, which only populates once a release carries the annotation.
	app = fx.reconcile()
	fx.expectPhase(app, pipelinesv1alpha1.ApplicationPromoting)
	if app.Status.ReleaseRef == "" || app.Status.ReleaseRef == releaseName {
		t.Fatalf("expected a new release for the pinned identity, got %q", app.Status.ReleaseRef)
	}
	fx.setReleasePhase(app.Status.ReleaseRef, pipelinesv1alpha1.ReleaseComplete)
	app = fx.reconcile()
	fx.expectPhase(app, pipelinesv1alpha1.ApplicationHealthy)
	if app.Status.Revision != "rev-1" {
		t.Fatalf("status.revision = %q, want rev-1", app.Status.Revision)
	}

	// Steady state: a further reconcile changes nothing.
	app = fx.reconcile()
	fx.expectPhase(app, pipelinesv1alpha1.ApplicationHealthy)
}

// TestRolloutStory_RetryExhaustionAndRecovery drives the failure path: a
// release that keeps rolling back is auto-resynced until the retry budget is
// spent, then held — not resurrected — until a manual sync intervenes.
func TestRolloutStory_RetryExhaustionAndRecovery(t *testing.T) {
	t.Parallel()

	fx := newRolloutFixture(t, newRolloutApp("retry-app"))

	// Reach steady state: create the release, complete it, then let the
	// hash-pin replacement release complete so the app is truly Healthy with
	// a source-hash-annotated release.
	app := fx.reconcile()
	fx.setReleasePhase(app.Status.ReleaseRef, pipelinesv1alpha1.ReleaseComplete)
	fx.reconcile()       // Healthy (first completion)
	fx.reconcile()       // hash pinned → identity change → Pending
	app = fx.reconcile() // new release created → Promoting
	releaseName := app.Status.ReleaseRef
	if releaseName == "" {
		t.Fatal("expected replacement release for pinned identity")
	}
	fx.setReleasePhase(releaseName, pipelinesv1alpha1.ReleaseComplete)
	app = fx.reconcile()
	fx.expectPhase(app, pipelinesv1alpha1.ApplicationHealthy)

	// Each retry cycle: release rolls back → app RolledBack → superseded →
	// adopt marks it for resync (auto-retry count++) → Pending. Loop until
	// the budget is spent.
	for attempt := 1; attempt <= maxReleaseAutoRetries; attempt++ {
		fx.setReleasePhase(releaseName, pipelinesv1alpha1.ReleaseRolledBack)

		app = fx.reconcile()
		fx.expectPhase(app, pipelinesv1alpha1.ApplicationPending)

		app = fx.reconcile()
		fx.expectPhase(app, pipelinesv1alpha1.ApplicationPending)
		release := fx.release(releaseName)
		if release.Annotations[resyncAnnotation] == "" {
			t.Fatalf("attempt %d: expected resync annotation on release", attempt)
		}
		if got := release.Annotations[autoRetryCountAnnotation]; got != strconv.Itoa(attempt) {
			t.Fatalf("attempt %d: auto-retry count = %q, want %d", attempt, got, attempt)
		}

		// The release controller resurrects it; it fails again.
		fx.setReleasePhase(releaseName, pipelinesv1alpha1.ReleaseRolledBack)
		app = fx.reconcile()
		fx.expectPhase(app, pipelinesv1alpha1.ApplicationRolledBack)
	}

	// Budget spent: the app must HOLD the terminal release — no supersede, no
	// resync, latch set so operators see why nothing is happening.
	app = fx.reconcile()
	if app.Status.ReleaseRef != releaseName {
		t.Fatalf("releaseRef = %q, want held at %s", app.Status.ReleaseRef, releaseName)
	}
	if !conditionIsTrue(app, releaseRetriesExhaustedCondition) {
		t.Fatalf("want %s=True while held", releaseRetriesExhaustedCondition)
	}
	if got := fx.release(releaseName); got.Status.Phase != pipelinesv1alpha1.ReleaseRolledBack {
		t.Fatalf("held release phase = %s, want RolledBack (not resurrected)", got.Status.Phase)
	}

	// And it stays held — repeated reconciles don't resurrect it.
	app = fx.reconcile()
	if !conditionIsTrue(app, releaseRetriesExhaustedCondition) {
		t.Fatal("latch dropped while still held")
	}
	if got := fx.release(releaseName); got.Status.Phase != pipelinesv1alpha1.ReleaseRolledBack {
		t.Fatalf("release resurrected while held: phase = %s", got.Status.Phase)
	}

	// Manual sync is the documented escape hatch: it bypasses the cap and
	// resets the retry counter.
	fx.app = fx.fetch()
	fx.app.Annotations = map[string]string{
		syncAnnotation:       "now",
		manualSyncAnnotation: "now",
	}
	if err := fx.c.Update(context.Background(), fx.app); err != nil {
		t.Fatalf("annotate manual sync: %v", err)
	}
	app = fx.reconcile()
	fx.expectPhase(app, pipelinesv1alpha1.ApplicationPending)
	release := fx.release(releaseName)
	if _, ok := release.Annotations[autoRetryCountAnnotation]; ok {
		t.Fatalf("manual sync must reset the auto-retry counter, got %q",
			release.Annotations[autoRetryCountAnnotation])
	}

	// The resynced release completes: the app recovers to Healthy and the
	// latch clears on the transition.
	fx.setReleasePhase(releaseName, pipelinesv1alpha1.ReleaseComplete)
	app = fx.reconcile()
	fx.expectPhase(app, pipelinesv1alpha1.ApplicationHealthy)
	if cond := meta.FindStatusCondition(app.Status.Conditions, releaseRetriesExhaustedCondition); cond != nil && cond.Status == metav1.ConditionTrue {
		t.Fatalf("%s still true after recovery", releaseRetriesExhaustedCondition)
	}
}

// TestRolloutStory_SourceChangeWhileHeld covers the other escape hatch: a new
// commit produces a new release identity with a fresh retry budget, so the
// parked app un-wedges itself without operator action.
func TestRolloutStory_SourceChangeWhileHeld(t *testing.T) {
	t.Parallel()

	app := newRolloutApp("held-app")
	app.Status.Phase = pipelinesv1alpha1.ApplicationRolledBack
	app.Status.SourceHash = "rollout-hash-1"
	app.Status.SourceRevision = "rev-1"
	releaseName := applicationReleaseName(app, &app.Spec.Stages[0])
	app.Status.ReleaseRef = releaseName

	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:      releaseName,
			Namespace: "default",
			Annotations: map[string]string{
				autoRetryCountAnnotation: strconv.Itoa(maxReleaseAutoRetries),
				sourceHashAnnotation:     "rollout-hash-1",
			},
		},
		Status: pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleaseRolledBack},
	}

	fx := newRolloutFixture(t, app, release)
	// The renderer now resolves a different content hash — a new commit.
	fx.r.TemplateRenderer = &staticSourceRenderer{result: &source.ResolveResult{
		Hash:     "rollout-hash-2",
		Revision: "rev-2",
	}}

	got := fx.reconcile()
	fx.expectPhase(got, pipelinesv1alpha1.ApplicationPending)
	if got.Status.ReleaseRef != "" {
		t.Fatalf("releaseRef = %q, want cleared for the new-identity release", got.Status.ReleaseRef)
	}
	if got.Status.SourceHash != "rollout-hash-2" {
		t.Fatalf("sourceHash = %q, want rollout-hash-2", got.Status.SourceHash)
	}
	if conditionIsTrue(got, releaseRetriesExhaustedCondition) {
		t.Fatal("latch should be cleared once a fresh release flow starts")
	}
	if fx.release(releaseName).Status.Phase != pipelinesv1alpha1.ReleaseSuperseded {
		t.Fatal("old release should be superseded for the new flow")
	}

	// Next reconcile creates the replacement release under the new identity —
	// the exhausted release is not resurrected.
	got = fx.reconcile()
	if got.Status.ReleaseRef == "" || got.Status.ReleaseRef == releaseName {
		t.Fatalf("expected new release identity, got %q", got.Status.ReleaseRef)
	}
	newRelease := fx.release(got.Status.ReleaseRef)
	if _, ok := newRelease.Annotations[autoRetryCountAnnotation]; ok {
		t.Fatal("new release must start with a fresh retry budget")
	}
}

// TestSetApplicationPhase_RetiresStalePhaseConditions reproduces the live
// cuttlefish bug: conditions accumulated by the old non-exclusive writer must
// be retired even when the phase itself does not change (a parked app).
func TestSetApplicationPhase_RetiresStalePhaseConditions(t *testing.T) {
	t.Parallel()

	r := &ApplicationReconciler{}
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "stale-app", Namespace: "default"},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Phase: pipelinesv1alpha1.ApplicationRolledBack,
		},
	}
	// The mess the old writer left: every phase the app ever visited is True.
	for _, phaseType := range applicationPhaseConditionTypes {
		meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
			Type:               phaseType,
			Status:             metav1.ConditionTrue,
			LastTransitionTime: metav1.Now(),
			Reason:             "Legacy",
		})
	}

	changed := r.setApplicationPhase(context.Background(), app, pipelinesv1alpha1.ApplicationRolledBack, "StillRolledBack", "held")
	if !changed {
		t.Fatal("same-phase call must report the retired stale conditions")
	}

	var truePhases []string
	for _, phaseType := range applicationPhaseConditionTypes {
		if cond := meta.FindStatusCondition(app.Status.Conditions, phaseType); cond != nil && cond.Status == metav1.ConditionTrue {
			truePhases = append(truePhases, phaseType)
		}
	}
	if len(truePhases) != 1 || truePhases[0] != string(pipelinesv1alpha1.ApplicationRolledBack) {
		t.Fatalf("true phase conditions = %v, want exactly [RolledBack]", truePhases)
	}
}

// TestSetApplicationPhase_LatchLifecycle pins the ReleaseRetriesExhausted
// semantics: it survives non-Healthy transitions (it is not a phase), and
// clears on the transition INTO Healthy — not merely while Healthy.
func TestSetApplicationPhase_LatchLifecycle(t *testing.T) {
	t.Parallel()

	r := &ApplicationReconciler{}
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "latch-app", Namespace: "default"},
	}
	meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type:               releaseRetriesExhaustedCondition,
		Status:             metav1.ConditionTrue,
		LastTransitionTime: metav1.Now(),
		Reason:             "AutoRetryLimitReached",
	})

	// A non-Healthy transition keeps the latch — the retry budget is still spent.
	r.setApplicationPhase(context.Background(), app, pipelinesv1alpha1.ApplicationPending, "ManualSync", "retrying")
	if !conditionIsTrue(app, releaseRetriesExhaustedCondition) {
		t.Fatal("latch must survive a non-Healthy transition")
	}

	// Transition into Healthy clears it as the recovery backstop.
	r.setApplicationPhase(context.Background(), app, pipelinesv1alpha1.ApplicationHealthy, "ReleaseComplete", "done")
	if conditionIsTrue(app, releaseRetriesExhaustedCondition) {
		t.Fatal("latch must clear on transition to Healthy")
	}
}

// TestPatchAppStatus_NormalizesParkedConditions covers the live cleanup path:
// an app parked in one phase by holdExhaustedRelease never re-enters
// setApplicationPhase, so the status-patch path itself retires stale True
// phase conditions left by older versions.
func TestPatchAppStatus_NormalizesParkedConditions(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := pipelinesv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("scheme: %v", err)
	}

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "parked-app", Namespace: "default"},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Phase: pipelinesv1alpha1.ApplicationRolledBack,
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app).WithStatusSubresource(app).Build()
	r := &ApplicationReconciler{client: c, Scheme: scheme}

	for _, phaseType := range []string{"Pending", "Promoting", "Healthy"} {
		meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
			Type:               phaseType,
			Status:             metav1.ConditionTrue,
			LastTransitionTime: metav1.Now(),
			Reason:             "Legacy",
		})
	}

	if err := r.patchAppStatus(context.Background(), app); err != nil {
		t.Fatalf("patchAppStatus: %v", err)
	}

	var updated pipelinesv1alpha1.Application
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(app), &updated); err != nil {
		t.Fatalf("get app: %v", err)
	}
	var truePhases []string
	for _, phaseType := range applicationPhaseConditionTypes {
		if cond := meta.FindStatusCondition(updated.Status.Conditions, phaseType); cond != nil && cond.Status == metav1.ConditionTrue {
			truePhases = append(truePhases, phaseType)
		}
	}
	if len(truePhases) != 1 || truePhases[0] != string(pipelinesv1alpha1.ApplicationRolledBack) {
		t.Fatalf("true phase conditions = %v, want exactly [RolledBack]", truePhases)
	}
}

// TestEvaluateResourceHealth_UsesDiffSnapshot proves the reconcile path reads
// health off the diff's live objects — no second pass through the API — and
// that unsupported kinds assess from their own status instead of reporting
// Unknown forever.
func TestEvaluateResourceHealth_UsesDiffSnapshot(t *testing.T) {
	t.Parallel()

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "snap-app", Namespace: "default"},
		Status: pipelinesv1alpha1.ApplicationStatus{
			Resources: []pipelinesv1alpha1.ResourceSync{
				{Kind: "Deployment", Name: "web", Namespace: "default", Status: "Synced"},
				{Kind: "StatefulSet", Name: "db", Namespace: "default", Status: "Synced"},
				{Kind: "ServiceAccount", Name: "web", Namespace: "default", Status: "Synced"},
				{Kind: "PersistentVolumeClaim", Name: "data", Namespace: "default", Status: "Synced"},
				{Kind: "Certificate", Name: "tls", Namespace: "default", Status: "Synced"},
				{Kind: "Deployment", Name: "old", Namespace: "default", Status: "Pruned"},
			},
		},
	}

	live := []unstructured.Unstructured{
		// Deployment: all replicas available → Healthy.
		mustLiveObject("apps/v1", "Deployment", "web", "default", map[string]interface{}{
			"spec":   map[string]interface{}{"replicas": int64(3)},
			"status": map[string]interface{}{"availableReplicas": int64(3), "updatedReplicas": int64(3)},
		}),
		// StatefulSet short on replicas → Progressing (not Unknown).
		mustLiveObject("apps/v1", "StatefulSet", "db", "default", map[string]interface{}{
			"spec":   map[string]interface{}{"replicas": int64(3)},
			"status": map[string]interface{}{"readyReplicas": int64(1)},
		}),
		// Existence-only kind → Healthy.
		mustLiveObject("v1", "ServiceAccount", "web", "default", nil),
		// Certificate with a Ready condition → Healthy (was Unknown forever).
		mustLiveObject("cert-manager.io/v1", "Certificate", "tls", "default", map[string]interface{}{
			"status": map[string]interface{}{"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "True"},
			}},
		}),
		// PVC absent from live → Missing.
	}
	result := &engine.DiffResult{Live: live}

	// ResHealth is deliberately nil: any per-resource GET fallback would
	// panic, proving the snapshot path served every resource.
	r := &ApplicationReconciler{}
	r.evaluateResourceHealth(context.Background(), app, result)

	byName := map[string]pipelinesv1alpha1.ResourceHealth{}
	for _, h := range app.Status.ResourceHealth {
		byName[h.Kind+"/"+h.Name] = h
	}
	if len(app.Status.ResourceHealth) != 5 {
		t.Fatalf("got %d health results, want 5 (pruned resource skipped): %+v",
			len(app.Status.ResourceHealth), app.Status.ResourceHealth)
	}
	wantHealth := map[string]string{
		"Deployment/web":             "Healthy",
		"StatefulSet/db":             "Progressing",
		"ServiceAccount/web":         "Healthy",
		"Certificate/tls":            "Healthy",
		"PersistentVolumeClaim/data": "Missing",
	}
	for key, want := range wantHealth {
		got, ok := byName[key]
		if !ok {
			t.Fatalf("missing health entry for %s", key)
		}
		if got.Health != want {
			t.Fatalf("%s health = %s, want %s (msg %q)", key, got.Health, want, got.Message)
		}
	}
	if _, ok := byName["Deployment/old"]; ok {
		t.Fatal("pruned resource must not appear in resource health")
	}
}

func mustLiveObject(apiVersion, kind, name, namespace string, fields map[string]interface{}) unstructured.Unstructured {
	obj := unstructured.Unstructured{Object: map[string]interface{}{}}
	obj.SetAPIVersion(apiVersion)
	obj.SetKind(kind)
	obj.SetName(name)
	obj.SetNamespace(namespace)
	for k, v := range fields {
		obj.Object[k] = v
	}
	return obj
}
