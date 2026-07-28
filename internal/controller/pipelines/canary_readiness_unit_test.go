package pipelines

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
)

// fakeClusterClientGetter satisfies ClusterClientGetter so readiness fetches
// resolve to a fake dynamic client via the same path the apply flow uses.
type fakeClusterClientGetter struct {
	dyn dynamic.Interface
	err error
}

func (f *fakeClusterClientGetter) GetClient(context.Context, string, string) (dynamic.Interface, error) {
	return f.dyn, f.err
}

const canaryTestDeploymentManifest = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: default
spec:
  replicas: 2
`

func testLiveDeployment(gen, obsGen int64, spec, updated, ready, available int32) *appsv1.Deployment {
	return &appsv1.Deployment{
		TypeMeta:   metav1.TypeMeta{APIVersion: "apps/v1", Kind: "Deployment"},
		ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default", Generation: gen},
		Spec:       appsv1.DeploymentSpec{Replicas: &spec},
		Status: appsv1.DeploymentStatus{
			ObservedGeneration: obsGen,
			UpdatedReplicas:    updated,
			ReadyReplicas:      ready,
			AvailableReplicas:  available,
		},
	}
}

// buildCanaryReadinessReconciler wires a ReleaseReconciler with a fake mgmt
// client (release + stage + canary snapshot ConfigMap) and a fake dynamic
// client (live Deployment state on the "target cluster"), resolved through
// ClusterMgr exactly like the apply path.
func buildCanaryReadinessReconciler(t *testing.T, canaryCfg *pipelinesv1alpha1.CanaryConfig, stepIdx, weight int, stepStartedAgo time.Duration, live *appsv1.Deployment) (*ReleaseReconciler, *clock.Fake, *pipelinesv1alpha1.Release) {
	t.Helper()

	scheme := runtime.NewScheme()
	if err := pipelinesv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add pipelines scheme: %v", err)
	}
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("add corev1 scheme: %v", err)
	}

	// Whole-second base: metav1.Time round-trips through the fake client at
	// second precision, so sub-second times would spuriously fail the
	// CanaryStepStartedAt equality assertions.
	fakeClock := clock.NewFake(time.Now().Truncate(time.Second))
	stage := &pipelinesv1alpha1.Stage{
		ObjectMeta: metav1.ObjectMeta{Name: "web-stage", Namespace: "default"},
		Spec: pipelinesv1alpha1.StageSpec{
			Name:      "web-stage",
			Ring:      1,
			Templates: nil,
			Cluster:   pipelinesv1alpha1.ClusterRef{KubeconfigSecret: "kc"},
			Canary:    canaryCfg,
		},
	}

	startedAt := metav1.NewTime(fakeClock.Now().Add(-stepStartedAgo))
	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "web-release",
			Namespace: "default",
		},
		Spec: pipelinesv1alpha1.ReleaseSpec{
			Target:      "web-stage",
			SyncOptions: &pipelinesv1alpha1.SyncOptions{Replace: true},
		},
		Status: pipelinesv1alpha1.ReleaseStatus{
			Phase:               pipelinesv1alpha1.ReleaseCanarying,
			CanaryStepIndex:     stepIdx,
			CanaryWeight:        weight,
			CanaryStepStartedAt: &startedAt,
		},
	}

	snapshot := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      canarySnapshotName(stage, weight),
			Namespace: "default",
		},
		Data: map[string]string{"manifests.yaml": canaryTestDeploymentManifest},
	}

	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(stage, release, snapshot).
		WithStatusSubresource(&pipelinesv1alpha1.Release{}).
		Build()

	dynScheme := runtime.NewScheme()
	if err := appsv1.AddToScheme(dynScheme); err != nil {
		t.Fatalf("add appsv1 scheme: %v", err)
	}
	var dyn dynamic.Interface
	if live != nil {
		dyn = dynamicfake.NewSimpleDynamicClient(dynScheme, live)
	} else {
		dyn = dynamicfake.NewSimpleDynamicClient(dynScheme)
	}

	r := NewReleaseReconciler(c)
	r.Scheme = scheme
	r.Clock = fakeClock
	r.ClusterMgr = &fakeClusterClientGetter{dyn: dyn}
	r.TemplateRenderer = &fakeAllTemplatesRenderer{manifests: []byte(canaryTestDeploymentManifest)}
	return r, fakeClock, release
}

func TestDeploymentConverged(t *testing.T) {
	t.Parallel()

	build := func(gen, obs, spec, updated, ready, avail int64) *unstructured.Unstructured {
		obj := &unstructured.Unstructured{Object: map[string]interface{}{
			"apiVersion": "apps/v1",
			"kind":       "Deployment",
			"metadata":   map[string]interface{}{"name": "web", "namespace": "default"},
			"spec":       map[string]interface{}{"replicas": spec},
			"status": map[string]interface{}{
				"observedGeneration": obs,
				"updatedReplicas":    updated,
				"readyReplicas":      ready,
				"availableReplicas":  avail,
			},
		}}
		obj.SetGeneration(gen)
		return obj
	}

	tests := []struct {
		name string
		obj  *unstructured.Unstructured
		want bool
	}{
		{"converged", build(2, 2, 3, 3, 3, 3), true},
		{"stale generation", build(3, 2, 3, 3, 3, 3), false},
		{"unready replicas", build(2, 2, 3, 3, 2, 2), false},
		{"not updated", build(2, 2, 3, 1, 3, 3), false},
		{"unavailable", build(2, 2, 3, 3, 3, 0), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, reason := deploymentConverged(tc.obj)
			if got != tc.want {
				t.Fatalf("deploymentConverged = %v (%s), want %v", got, reason, tc.want)
			}
		})
	}

	t.Run("defaults spec replicas to one", func(t *testing.T) {
		t.Parallel()
		obj := build(1, 1, 0, 1, 1, 1)
		unstructured.RemoveNestedField(obj.Object, "spec", "replicas")
		if ok, reason := deploymentConverged(obj); !ok {
			t.Fatalf("expected converged with defaulted replicas, got %s", reason)
		}
	})
}

// (a) The canary must not advance while a rendered Deployment is unready, and
// waiting reconciles must not reset CanaryStepStartedAt.
func TestReleaseReconciler_reconcileCanary_doesNotAdvanceWhileDeploymentUnready(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	canaryCfg := &pipelinesv1alpha1.CanaryConfig{Steps: []int{10, 50, 100}, IntervalSeconds: 30}
	// Live deployment observed but only 1/2 replicas ready.
	live := testLiveDeployment(2, 2, 2, 2, 1, 1)
	r, _, release := buildCanaryReadinessReconciler(t, canaryCfg, 1, 10, 40*time.Second, live)
	originalStartedAt := release.Status.CanaryStepStartedAt.Time

	var result string
	for i := 0; i < 2; i++ {
		res, err := r.reconcileCanary(ctx, release, time.Now(), &result)
		if err != nil {
			t.Fatalf("reconcileCanary attempt %d: %v", i, err)
		}
		if res.RequeueAfter != canaryReadinessRequeueInterval {
			t.Fatalf("attempt %d RequeueAfter = %v, want %v", i, res.RequeueAfter, canaryReadinessRequeueInterval)
		}
	}

	var updated pipelinesv1alpha1.Release
	if err := r.client.Get(ctx, types.NamespacedName{Name: "web-release", Namespace: "default"}, &updated); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if updated.Status.CanaryStepIndex != 1 {
		t.Errorf("CanaryStepIndex = %d, want 1 (must not advance)", updated.Status.CanaryStepIndex)
	}
	if updated.Status.CanaryWeight != 10 {
		t.Errorf("CanaryWeight = %d, want 10", updated.Status.CanaryWeight)
	}
	if updated.Status.CanaryStepStartedAt == nil || !updated.Status.CanaryStepStartedAt.Time.Equal(originalStartedAt) {
		t.Errorf("CanaryStepStartedAt = %v, want unchanged %v", updated.Status.CanaryStepStartedAt, originalStartedAt)
	}
	if updated.Status.Phase != pipelinesv1alpha1.ReleaseCanarying {
		t.Errorf("phase = %s, want Canarying", updated.Status.Phase)
	}
}

// (b) Advancement proceeds once the previous step's Deployment has converged.
func TestReleaseReconciler_reconcileCanary_advancesOnceDeploymentReady(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	canaryCfg := &pipelinesv1alpha1.CanaryConfig{Steps: []int{10, 50, 100}, IntervalSeconds: 30}
	live := testLiveDeployment(2, 2, 2, 2, 2, 2)
	r, fakeClock, release := buildCanaryReadinessReconciler(t, canaryCfg, 1, 10, 40*time.Second, live)

	var result string
	res, err := r.reconcileCanary(ctx, release, time.Now(), &result)
	if err != nil {
		t.Fatalf("reconcileCanary: %v", err)
	}
	if want := r.getCanaryInterval(canaryCfg); res.RequeueAfter != want {
		t.Fatalf("RequeueAfter = %v, want canary interval %v", res.RequeueAfter, want)
	}

	var updated pipelinesv1alpha1.Release
	if err := r.client.Get(ctx, types.NamespacedName{Name: "web-release", Namespace: "default"}, &updated); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if updated.Status.CanaryStepIndex != 2 {
		t.Errorf("CanaryStepIndex = %d, want 2 (advanced)", updated.Status.CanaryStepIndex)
	}
	if updated.Status.CanaryWeight != 50 {
		t.Errorf("CanaryWeight = %d, want 50", updated.Status.CanaryWeight)
	}
	if updated.Status.CanaryStepStartedAt == nil || !updated.Status.CanaryStepStartedAt.Time.Equal(fakeClock.Now()) {
		t.Errorf("CanaryStepStartedAt = %v, want reset to now %v", updated.Status.CanaryStepStartedAt, fakeClock.Now())
	}

	// The new step's render must have been snapshotted for the next gate.
	var cm corev1.ConfigMap
	if err := r.client.Get(ctx, types.NamespacedName{Name: "web-stage-canary-50", Namespace: "default"}, &cm); err != nil {
		t.Errorf("expected canary snapshot for weight 50: %v", err)
	}
}

// (c) Exceeding the progress deadline while unready fails the release with
// reason ProgressDeadlineExceeded.
func TestReleaseReconciler_reconcileCanary_progressDeadlineExceededFailsRelease(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	canaryCfg := &pipelinesv1alpha1.CanaryConfig{Steps: []int{10, 50, 100}, IntervalSeconds: 30, ProgressDeadlineSeconds: 60}
	live := testLiveDeployment(2, 2, 2, 2, 0, 0)
	r, _, release := buildCanaryReadinessReconciler(t, canaryCfg, 1, 10, 120*time.Second, live)

	var result string
	res, err := r.reconcileCanary(ctx, release, time.Now(), &result)
	if err != nil {
		t.Fatalf("reconcileCanary: %v", err)
	}
	if res.RequeueAfter != 0 {
		t.Errorf("RequeueAfter = %v, want 0 (terminal failure)", res.RequeueAfter)
	}

	var updated pipelinesv1alpha1.Release
	if err := r.client.Get(ctx, types.NamespacedName{Name: "web-release", Namespace: "default"}, &updated); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if updated.Status.Phase != pipelinesv1alpha1.ReleaseFailed {
		t.Fatalf("phase = %s, want Failed", updated.Status.Phase)
	}
	var cond *metav1.Condition
	for i := range updated.Status.Conditions {
		if updated.Status.Conditions[i].Type == "CanaryFailed" {
			cond = &updated.Status.Conditions[i]
		}
	}
	if cond == nil {
		t.Fatalf("expected CanaryFailed condition, got %+v", updated.Status.Conditions)
	}
	if cond.Reason != progressDeadlineExceededReason {
		t.Errorf("condition reason = %q, want %q", cond.Reason, progressDeadlineExceededReason)
	}
	if !strings.Contains(cond.Message, "did not converge") {
		t.Errorf("condition message = %q, want convergence failure detail", cond.Message)
	}
}

// Promotion is gated too: with all steps applied but the final step's
// Deployment unready, the release must stay Canarying rather than promote.
func TestReleaseReconciler_reconcileCanary_promotionWaitsForReadiness(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	canaryCfg := &pipelinesv1alpha1.CanaryConfig{Steps: []int{10, 100}, IntervalSeconds: 1}
	live := testLiveDeployment(2, 1, 2, 0, 0, 0) // generation not yet observed
	r, _, release := buildCanaryReadinessReconciler(t, canaryCfg, 2, 100, 30*time.Second, live)

	var result string
	res, err := r.reconcileCanary(ctx, release, time.Now(), &result)
	if err != nil {
		t.Fatalf("reconcileCanary: %v", err)
	}
	if res.RequeueAfter != canaryReadinessRequeueInterval {
		t.Fatalf("RequeueAfter = %v, want %v", res.RequeueAfter, canaryReadinessRequeueInterval)
	}

	var updated pipelinesv1alpha1.Release
	if err := r.client.Get(ctx, types.NamespacedName{Name: "web-release", Namespace: "default"}, &updated); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if updated.Status.Phase != pipelinesv1alpha1.ReleaseCanarying {
		t.Fatalf("phase = %s, want Canarying (promotion must be gated)", updated.Status.Phase)
	}
}

// Fail-safe: live-state fetch errors are treated as NOT ready (requeue toward
// the deadline), never as ready.
func TestReleaseReconciler_gateCanaryAdvance_fetchErrorTreatedAsNotReady(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	canaryCfg := &pipelinesv1alpha1.CanaryConfig{Steps: []int{10, 50}, IntervalSeconds: 1}
	r, _, release := buildCanaryReadinessReconciler(t, canaryCfg, 1, 10, 5*time.Second, nil)
	r.ClusterMgr = &fakeClusterClientGetter{err: errors.New("cluster unreachable")}

	var stage pipelinesv1alpha1.Stage
	if err := r.client.Get(ctx, types.NamespacedName{Name: "web-stage", Namespace: "default"}, &stage); err != nil {
		t.Fatalf("get stage: %v", err)
	}

	var result string
	res, blocked, err := r.gateCanaryAdvance(ctx, release, &stage, canaryCfg, &result)
	if err != nil {
		t.Fatalf("gateCanaryAdvance: %v", err)
	}
	if !blocked {
		t.Fatal("expected gate to block when live state cannot be fetched")
	}
	if res.RequeueAfter != canaryReadinessRequeueInterval {
		t.Errorf("RequeueAfter = %v, want %v", res.RequeueAfter, canaryReadinessRequeueInterval)
	}
}

// Agent-mode clusters have no live read path from the management cluster; the
// gate deliberately skips them instead of wedging every canary into a
// deadline failure.
func TestReleaseReconciler_gateCanaryAdvance_agentModeSkipsGate(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	canaryCfg := &pipelinesv1alpha1.CanaryConfig{Steps: []int{10, 50}, IntervalSeconds: 1}
	r, _, release := buildCanaryReadinessReconciler(t, canaryCfg, 1, 10, 5*time.Second, nil)

	stage := &pipelinesv1alpha1.Stage{
		ObjectMeta: metav1.ObjectMeta{Name: "web-stage", Namespace: "default"},
		Spec: pipelinesv1alpha1.StageSpec{
			Name:    "web-stage",
			Cluster: pipelinesv1alpha1.ClusterRef{Mode: pipelinesv1alpha1.ClusterModeAgent, AgentAddress: "http://agent:8083"},
			Canary:  canaryCfg,
		},
	}

	var result string
	res, blocked, err := r.gateCanaryAdvance(ctx, release, stage, canaryCfg, &result)
	if err != nil {
		t.Fatalf("gateCanaryAdvance: %v", err)
	}
	if blocked {
		t.Fatalf("expected agent-mode gate skip, got blocked with %+v", res)
	}
}

// Resurrected releases must restart the canary from step 0: handleResyncAnnotation
// resets canary progress alongside the phase, so a stale CanaryStepStartedAt
// cannot instantly trip the new progress deadline.
func TestReleaseReconciler_handleResyncAnnotation_resetsCanaryProgress(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	scheme := runtime.NewScheme()
	if err := pipelinesv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add scheme: %v", err)
	}
	startedAt := metav1.NewTime(time.Now().Add(-2 * time.Hour))
	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "resync-release",
			Namespace:   "default",
			Annotations: map[string]string{resyncAnnotation: "1"},
		},
		Status: pipelinesv1alpha1.ReleaseStatus{
			Phase:               pipelinesv1alpha1.ReleaseRolledBack,
			CanaryWeight:        100,
			CanaryStepIndex:     3,
			CanaryStepStartedAt: &startedAt,
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(release).WithStatusSubresource(release).Build()
	r := &ReleaseReconciler{client: c, Scheme: scheme}

	var result string
	if _, handled, err := r.handleResyncAnnotation(ctx, release, &result); err != nil || !handled {
		t.Fatalf("handleResyncAnnotation handled=%v err=%v", handled, err)
	}

	var updated pipelinesv1alpha1.Release
	if err := c.Get(ctx, types.NamespacedName{Name: "resync-release", Namespace: "default"}, &updated); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if updated.Status.Phase != pipelinesv1alpha1.ReleasePending {
		t.Errorf("phase = %s, want Pending", updated.Status.Phase)
	}
	if updated.Status.CanaryStepIndex != 0 || updated.Status.CanaryWeight != 0 || updated.Status.CanaryStepStartedAt != nil {
		t.Errorf("canary progress not reset: index=%d weight=%d startedAt=%v",
			updated.Status.CanaryStepIndex, updated.Status.CanaryWeight, updated.Status.CanaryStepStartedAt)
	}
}

// A successful completion clears the auto-retry counter: the cap only counts
// consecutive failed automatic re-runs.
func TestReleaseReconciler_completeRelease_clearsAutoRetryCounter(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	scheme := runtime.NewScheme()
	if err := pipelinesv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add scheme: %v", err)
	}
	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "complete-release",
			Namespace:   "default",
			Annotations: map[string]string{autoRetryCountAnnotation: "2"},
		},
		Status: pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleaseVerifying},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(release).WithStatusSubresource(release).Build()
	r := &ReleaseReconciler{client: c, Scheme: scheme}

	var result string
	if _, err := r.completeRelease(ctx, release, &result); err != nil {
		t.Fatalf("completeRelease: %v", err)
	}

	var updated pipelinesv1alpha1.Release
	if err := c.Get(ctx, types.NamespacedName{Name: "complete-release", Namespace: "default"}, &updated); err != nil {
		t.Fatalf("get release: %v", err)
	}
	if updated.Status.Phase != pipelinesv1alpha1.ReleaseComplete {
		t.Errorf("phase = %s, want Complete", updated.Status.Phase)
	}
	if _, ok := updated.Annotations[autoRetryCountAnnotation]; ok {
		t.Errorf("auto-retry counter still present: %v", updated.Annotations)
	}
}
