package pipelines

import (
	"context"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	ktesting "k8s.io/client-go/testing"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1 "k8s.io/api/core/v1"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
)

var (
	retentionRoleGVR   = schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "roles"}
	retentionDeployGVR = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
)

func retentionObject(apiVersion, kind, namespace, name, release string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": apiVersion,
		"kind":       kind,
		"metadata": map[string]interface{}{
			"name":      name,
			"namespace": namespace,
			"labels":    map[string]interface{}{engine.ReleaseNameLabelKey: release},
		},
	}}
}

func retentionCleanupFixture(t *testing.T, snapshot string, objs ...runtime.Object) (*ReleaseReconciler, *pipelinesv1alpha1.Release, *dynamicfake.FakeDynamicClient) {
	t.Helper()
	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	_ = corev1.AddToScheme(scheme)
	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "rel-1", Namespace: "paprika-system"},
		Status:     pipelinesv1alpha1.ReleaseStatus{RenderedManifestSnapshot: "rel-1-manifest-snapshot"},
	}
	cbuilder := fake.NewClientBuilder().WithScheme(scheme).WithObjects(release)
	if snapshot != "" {
		cbuilder = cbuilder.WithObjects(&corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: "rel-1-manifest-snapshot", Namespace: "paprika-system"},
			Data:       map[string]string{"manifests.yaml": snapshot},
		})
	}
	listKinds := map[schema.GroupVersionResource]string{retentionRoleGVR: "RoleList"}
	for _, gvr := range managedGVRs {
		listKinds[gvr] = "UnstructuredList"
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds, objs...)
	return &ReleaseReconciler{client: cbuilder.Build(), DynamicClient: dyn}, release, dyn
}

const retentionCrossNamespaceSnapshot = `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: runner
  namespace: ci-runners
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: runner
  namespace: ci-runners
`

func TestReleaseCleanup_DeletesInNamespacesTheReleaseApplied(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	ours := retentionObject("rbac.authorization.k8s.io/v1", "Role", "ci-runners", "runner", "rel-1")
	ourDeploy := retentionObject("apps/v1", "Deployment", "ci-runners", "runner", "rel-1")
	otherRelease := retentionObject("rbac.authorization.k8s.io/v1", "Role", "ci-runners", "other", "rel-2")
	otherNamespace := retentionObject("rbac.authorization.k8s.io/v1", "Role", "unrelated", "runner", "rel-1")
	r, release, dyn := retentionCleanupFixture(t, retentionCrossNamespaceSnapshot, ours, ourDeploy, otherRelease, otherNamespace)

	if err := r.cleanup(ctx, release); err != nil {
		t.Fatalf("cleanup: %v", err)
	}

	if _, err := dyn.Resource(retentionRoleGVR).Namespace("ci-runners").Get(ctx, "runner", metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Errorf("release Role in ci-runners should be deleted, err=%v", err)
	}
	if _, err := dyn.Resource(retentionDeployGVR).Namespace("ci-runners").Get(ctx, "runner", metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Errorf("release Deployment in ci-runners should be deleted, err=%v", err)
	}
	if _, err := dyn.Resource(retentionRoleGVR).Namespace("ci-runners").Get(ctx, "other", metav1.GetOptions{}); err != nil {
		t.Errorf("Role of another release must survive: %v", err)
	}
	if _, err := dyn.Resource(retentionRoleGVR).Namespace("unrelated").Get(ctx, "runner", metav1.GetOptions{}); err != nil {
		t.Errorf("object in a namespace the release never applied to must survive: %v", err)
	}
}

func TestReleaseCleanup_NeverListsReleaseNamespaceForCrossNamespaceRelease(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	ours := retentionObject("rbac.authorization.k8s.io/v1", "Role", "ci-runners", "runner", "rel-1")
	r, release, dyn := retentionCleanupFixture(t, retentionCrossNamespaceSnapshot, ours)
	// The controller ServiceAccount cannot list anything in the release namespace.
	dyn.PrependReactor("list", "*", func(action ktesting.Action) (bool, runtime.Object, error) {
		if action.GetNamespace() == "paprika-system" {
			return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "roles"}, "", nil)
		}
		return false, nil, nil
	})

	if err := r.cleanup(ctx, release); err != nil {
		t.Fatalf("a Forbidden in the release namespace must not wedge cleanup: %v", err)
	}
	if _, err := dyn.Resource(retentionRoleGVR).Namespace("ci-runners").Get(ctx, "runner", metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Errorf("release Role in ci-runners should still be deleted, err=%v", err)
	}
}

func TestReleaseCleanup_MissingSnapshotFallbackToleratesForbidden(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	r, release, dyn := retentionCleanupFixture(t, "")
	dyn.PrependReactor("list", "*", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "services"}, "", nil)
	})
	if err := r.cleanup(ctx, release); err != nil {
		t.Fatalf("guessed fallback listing must tolerate Forbidden: %v", err)
	}
}

func TestReleaseCleanup_RecordedNamespaceForbiddenStillFails(t *testing.T) {
	t.Parallel()
	r, release, dyn := retentionCleanupFixture(t, retentionCrossNamespaceSnapshot)
	dyn.PrependReactor("list", "roles", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "roles"}, "", nil)
	})
	if err := r.cleanup(context.Background(), release); err == nil {
		t.Fatal("Forbidden in a namespace the release applied to must surface, not hide leaked objects")
	}
}

func TestReleaseCleanup_UnscopedManifestUsesReleaseNamespace(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	ours := retentionObject("apps/v1", "Deployment", "paprika-system", "app", "rel-1")
	r, release, dyn := retentionCleanupFixture(t, "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\n", ours)
	if err := r.cleanup(ctx, release); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if _, err := dyn.Resource(retentionDeployGVR).Namespace("paprika-system").Get(ctx, "app", metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Errorf("manifest without a namespace was applied to the release namespace, err=%v", err)
	}
}

func TestReleaseCleanup_KeepsSnapshotSharedWithAnotherRelease(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	_ = corev1.AddToScheme(scheme)
	mk := func(name string) *pipelinesv1alpha1.Release {
		return &pipelinesv1alpha1.Release{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "tenant"},
			Spec:       pipelinesv1alpha1.ReleaseSpec{ManifestSource: &pipelinesv1alpha1.ManifestSource{ConfigMapRef: "app-bundle-abc"}},
			Status:     pipelinesv1alpha1.ReleaseStatus{RenderedManifestSnapshot: "app-bundle-abc"},
		}
	}
	bundle := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "app-bundle-abc", Namespace: "tenant"}}
	first, second := mk("rel-a"), mk("rel-b")
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(first, second, bundle).Build()
	_, _, dyn := retentionCleanupFixture(t, "")
	r := &ReleaseReconciler{client: c, DynamicClient: dyn}

	if err := r.cleanup(ctx, first); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if err := c.Get(ctx, client.ObjectKeyFromObject(bundle), &corev1.ConfigMap{}); err != nil {
		t.Fatalf("bundle still used by rel-b must survive: %v", err)
	}
	if err := c.Delete(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := r.cleanup(ctx, second); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if err := c.Get(ctx, client.ObjectKeyFromObject(bundle), &corev1.ConfigMap{}); !apierrors.IsNotFound(err) {
		t.Fatalf("last referencing release must remove the bundle, err=%v", err)
	}
}

func retentionApp() *pipelinesv1alpha1.Application {
	return &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: pruneTestAppName, Namespace: "default"},
		Status:     pipelinesv1alpha1.ApplicationStatus{ReleaseRef: "release-14"},
	}
}

func TestApplicationReconciler_pruneReleaseHistory_removesOldCompleteButNotActive(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	phases := make([]pipelinesv1alpha1.ReleasePhase, 15)
	for i := range phases {
		phases[i] = pipelinesv1alpha1.ReleaseComplete
	}
	phases[3] = pipelinesv1alpha1.ReleaseFailed
	phases[14] = pipelinesv1alpha1.ReleaseComplete // active
	objs := buildReleases(base, phases)
	// The active release is also the oldest: it must still survive.
	objs[0].(*pipelinesv1alpha1.Release).CreationTimestamp = metav1.Time{Time: base.Add(-24 * time.Hour)}
	app := retentionApp()
	app.Status.ReleaseRef = "release-00"
	r := &ApplicationReconciler{client: newPruneTestClient(objs...)}

	if err := r.pruneReleaseHistory(ctx, app); err != nil {
		t.Fatalf("pruneReleaseHistory: %v", err)
	}
	var list pipelinesv1alpha1.ReleaseList
	if err := r.client.List(ctx, &list, client.InNamespace("default")); err != nil {
		t.Fatal(err)
	}
	kept := releaseNames(&list)
	if len(kept) != maxReleaseHistory {
		t.Fatalf("kept %d releases, want %d", len(kept), maxReleaseHistory)
	}
	if !kept["release-00"] {
		t.Error("the active release must never be pruned")
	}
	if !kept["release-14"] || kept["release-01"] || kept["release-03"] {
		t.Errorf("oldest terminal releases should go first, kept=%v", kept)
	}
}

func TestApplicationReconciler_pruneReleaseHistory_keepsInFlightAndPromotionSources(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	phases := make([]pipelinesv1alpha1.ReleasePhase, 14)
	for i := range phases {
		phases[i] = pipelinesv1alpha1.ReleaseComplete
	}
	phases[1] = pipelinesv1alpha1.ReleasePromoting // still running: never terminal
	objs := buildReleases(base, phases)
	downstream := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "tenant-app", Namespace: "tenant"},
		Status: pipelinesv1alpha1.ApplicationStatus{Promotion: &pipelinesv1alpha1.ApplicationPromotionStatus{
			SourceApplication: pipelinesv1alpha1.ApplicationReference{Name: pruneTestAppName, Namespace: "default"},
			SourceRelease:     "release-00",
			Phase:             "Verifying",
		}},
	}
	app := retentionApp()
	app.Status.ReleaseRef = "release-13"
	r := &ApplicationReconciler{client: newPruneTestClient(append(objs, downstream)...)}

	if err := r.pruneReleaseHistory(ctx, app); err != nil {
		t.Fatalf("pruneReleaseHistory: %v", err)
	}
	var list pipelinesv1alpha1.ReleaseList
	if err := r.client.List(ctx, &list, client.InNamespace("default")); err != nil {
		t.Fatal(err)
	}
	kept := releaseNames(&list)
	if !kept["release-00"] {
		t.Error("the promotion source release must survive")
	}
	if !kept["release-01"] {
		t.Error("a non-terminal release must survive")
	}
	if kept["release-02"] || kept["release-03"] {
		t.Errorf("oldest unprotected terminal releases should be pruned, kept=%v", kept)
	}
}
