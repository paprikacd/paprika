package apiserver

import (
	"context"
	"encoding/json"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func detailTestApp() *pipelinesv1alpha1.Application {
	return &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-app", Namespace: "test-ns"},
		Spec:       pipelinesv1alpha1.ApplicationSpec{Project: "default"},
		Status: pipelinesv1alpha1.ApplicationStatus{
			ReleaseRef: "demo-app-release",
			Resources: []pipelinesv1alpha1.ResourceSync{
				{Kind: "Deployment", Name: "web", Namespace: "test-ns", Status: "Synced"},
				{Kind: "Service", Name: "web-svc", Namespace: "test-ns", Status: "Synced"},
			},
		},
	}
}

func detailTestClient(t *testing.T, objs ...client.Object) client.Client {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	return fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(objs...).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}, &pipelinesv1alpha1.Release{}).
		Build()
}

func TestIgnoreDriftedField_AddsScopedRule(t *testing.T) {
	srv := NewPaprikaServer(detailTestClient(t, detailTestApp()), nil)
	resp, err := srv.IgnoreDriftedField(context.Background(), connect.NewRequest(&paprikav1.IgnoreDriftedFieldRequest{
		Namespace: "test-ns", Name: "demo-app",
		Kind: "Deployment", ResourceName: "web", ResourceNamespace: "test-ns",
		JsonPointers: []string{"/spec/replicas"},
		Reason:       "HPA owns replicas",
	}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Rules, 1)
	rule := resp.Msg.Rules[0]
	require.Equal(t, "Deployment", rule.Kind)
	require.Equal(t, "web", rule.Name)
	require.Equal(t, []string{"/spec/replicas"}, rule.JsonPointers)
	require.Equal(t, "HPA owns replicas", rule.Reason)
}

func TestIgnoreDriftedField_MergesAndRemoves(t *testing.T) {
	srv := NewPaprikaServer(detailTestClient(t, detailTestApp()), nil)
	ctx := context.Background()

	for _, p := range []string{"/spec/replicas", "/spec/paused"} {
		_, err := srv.IgnoreDriftedField(ctx, connect.NewRequest(&paprikav1.IgnoreDriftedFieldRequest{
			Namespace: "test-ns", Name: "demo-app",
			Kind: "Deployment", ResourceName: "web", ResourceNamespace: "test-ns",
			JsonPointers: []string{p},
		}))
		require.NoError(t, err)
	}

	// Distinct scope lands as a separate rule.
	_, err := srv.IgnoreDriftedField(ctx, connect.NewRequest(&paprikav1.IgnoreDriftedFieldRequest{
		Namespace: "test-ns", Name: "demo-app",
		Kind: "Service", ResourceName: "web-svc", ResourceNamespace: "test-ns",
		JsonPointers: []string{"/spec/clusterIP"},
	}))
	require.NoError(t, err)

	var app pipelinesv1alpha1.Application
	require.NoError(t, srv.client.Get(ctx, client.ObjectKey{Namespace: "test-ns", Name: "demo-app"}, &app))
	require.Len(t, app.Spec.IgnoreDifferences, 2)
	require.ElementsMatch(t, []string{"/spec/replicas", "/spec/paused"}, app.Spec.IgnoreDifferences[0].JSONPointers)

	// Remove one pointer; the rule survives with the other.
	resp, err := srv.IgnoreDriftedField(ctx, connect.NewRequest(&paprikav1.IgnoreDriftedFieldRequest{
		Namespace: "test-ns", Name: "demo-app",
		Kind: "Deployment", ResourceName: "web", ResourceNamespace: "test-ns",
		JsonPointers: []string{"/spec/replicas"},
		Remove:       true,
	}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Rules, 2)
	require.Equal(t, []string{"/spec/paused"}, resp.Msg.Rules[0].JsonPointers)

	// Removing the last pointer drops the rule entirely.
	resp, err = srv.IgnoreDriftedField(ctx, connect.NewRequest(&paprikav1.IgnoreDriftedFieldRequest{
		Namespace: "test-ns", Name: "demo-app",
		Kind: "Deployment", ResourceName: "web", ResourceNamespace: "test-ns",
		JsonPointers: []string{"/spec/paused"},
		Remove:       true,
	}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Rules, 1)
	require.Equal(t, "Service", resp.Msg.Rules[0].Kind)
}

func TestIgnoreDriftedField_RequiresPointers(t *testing.T) {
	srv := NewPaprikaServer(detailTestClient(t, detailTestApp()), nil)
	_, err := srv.IgnoreDriftedField(context.Background(), connect.NewRequest(&paprikav1.IgnoreDriftedFieldRequest{
		Namespace: "test-ns", Name: "demo-app", Kind: "Deployment", ResourceName: "web",
	}))
	require.Error(t, err)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func patchTestServer(t *testing.T, live *unstructured.Unstructured) *PaprikaServer {
	t.Helper()
	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-app-release", Namespace: "test-ns"},
		Spec:       pipelinesv1alpha1.ReleaseSpec{Target: "prod"},
	}
	stage := &pipelinesv1alpha1.Stage{
		ObjectMeta: metav1.ObjectMeta{Name: "prod", Namespace: "test-ns"},
		// Empty ClusterRef resolves in-cluster — the dynamic client can reach it.
	}
	dynScheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(dynScheme))
	dyn := dynamicfake.NewSimpleDynamicClient(dynScheme, live)
	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{{Group: "apps", Version: "v1"}})
	mapper.AddSpecific(
		schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"},
		schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"},
		schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployment"},
		meta.RESTScopeNamespace,
	)
	return NewPaprikaServer(detailTestClient(t, detailTestApp(), release, stage), nil,
		WithDynamicClient(dyn), WithRESTMapper(mapper))
}

func managedDeployment() *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]any{
			"name":      "web",
			"namespace": "test-ns",
			"labels": map[string]any{
				"app.paprika.io/name":       "demo-app",
				"app.paprika.io/managed-by": "paprika",
			},
		},
		"spec": map[string]any{"replicas": int64(1)},
	}}
}

func TestApplyResourcePatch_DryRunPreviewsWithoutMutating(t *testing.T) {
	srv := patchTestServer(t, managedDeployment())
	resp, err := srv.ApplyResourcePatch(context.Background(), connect.NewRequest(&paprikav1.ApplyResourcePatchRequest{
		Namespace: "test-ns", Name: "demo-app",
		Group: "apps", Version: "v1", Kind: "Deployment",
		ResourceName: "web", ResourceNamespace: "test-ns",
		PatchType: paprikav1.PatchType_PATCH_TYPE_MERGE_PATCH,
		Patch:     `{"spec":{"replicas":5}}`,
		Confirm:   false,
	}))
	require.NoError(t, err)
	require.True(t, resp.Msg.DryRun)
	require.False(t, resp.Msg.Applied)
	require.Contains(t, resp.Msg.Diff, "replicas")
	require.NotEmpty(t, resp.Msg.Warning)
}

func TestApplyResourcePatch_ConfirmApplies(t *testing.T) {
	srv := patchTestServer(t, managedDeployment())
	resp, err := srv.ApplyResourcePatch(context.Background(), connect.NewRequest(&paprikav1.ApplyResourcePatchRequest{
		Namespace: "test-ns", Name: "demo-app",
		Group: "apps", Version: "v1", Kind: "Deployment",
		ResourceName: "web", ResourceNamespace: "test-ns",
		PatchType: paprikav1.PatchType_PATCH_TYPE_MERGE_PATCH,
		Patch:     `{"spec":{"replicas":5}}`,
		Confirm:   true,
	}))
	require.NoError(t, err)
	require.True(t, resp.Msg.Applied)
	require.NotZero(t, resp.Msg.AppliedAtUnixMs)
}

func TestApplyResourcePatch_RefusesUnmanagedResource(t *testing.T) {
	unmanaged := managedDeployment()
	unmanaged.SetLabels(map[string]string{"app.kubernetes.io/name": "someone-else"})
	srv := patchTestServer(t, unmanaged)
	_, err := srv.ApplyResourcePatch(context.Background(), connect.NewRequest(&paprikav1.ApplyResourcePatchRequest{
		Namespace: "test-ns", Name: "demo-app",
		Group: "apps", Version: "v1", Kind: "Deployment",
		ResourceName: "web", ResourceNamespace: "test-ns",
		PatchType: paprikav1.PatchType_PATCH_TYPE_MERGE_PATCH,
		Patch:     `{"spec":{"replicas":5}}`,
		Confirm:   true,
	}))
	require.Error(t, err)
	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
}

func TestApplyResourcePatch_RefusesRemoteTarget(t *testing.T) {
	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-app-release", Namespace: "test-ns"},
		Spec:       pipelinesv1alpha1.ReleaseSpec{Target: "remote-stage"},
	}
	stage := &pipelinesv1alpha1.Stage{
		ObjectMeta: metav1.ObjectMeta{Name: "remote-stage", Namespace: "test-ns"},
		Spec: pipelinesv1alpha1.StageSpec{
			Cluster: pipelinesv1alpha1.ClusterRef{Mode: pipelinesv1alpha1.ClusterModeAgent},
		},
	}
	dynScheme := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(dynScheme))
	dyn := dynamicfake.NewSimpleDynamicClient(dynScheme, managedDeployment())
	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{{Group: "apps", Version: "v1"}})
	mapper.AddSpecific(
		schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"},
		schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"},
		schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployment"},
		meta.RESTScopeNamespace,
	)
	srv := NewPaprikaServer(detailTestClient(t, detailTestApp(), release, stage), nil,
		WithDynamicClient(dyn), WithRESTMapper(mapper))

	_, err := srv.ApplyResourcePatch(context.Background(), connect.NewRequest(&paprikav1.ApplyResourcePatchRequest{
		Namespace: "test-ns", Name: "demo-app",
		Group: "apps", Version: "v1", Kind: "Deployment",
		ResourceName: "web", ResourceNamespace: "test-ns",
		PatchType: paprikav1.PatchType_PATCH_TYPE_MERGE_PATCH,
		Patch:     `{"spec":{"replicas":5}}`,
		Confirm:   true,
	}))
	require.Error(t, err)
	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
}

func TestApplyResourcePatch_RejectsBadPatchType(t *testing.T) {
	srv := patchTestServer(t, managedDeployment())
	_, err := srv.ApplyResourcePatch(context.Background(), connect.NewRequest(&paprikav1.ApplyResourcePatchRequest{
		Namespace: "test-ns", Name: "demo-app",
		Group: "apps", Version: "v1", Kind: "Deployment",
		ResourceName: "web", Patch: `{"x":1}`,
		PatchType: paprikav1.PatchType_PATCH_TYPE_UNSPECIFIED,
	}))
	require.Error(t, err)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestSyncResources_DryRunReportsMatches(t *testing.T) {
	srv := NewPaprikaServer(detailTestClient(t, detailTestApp()), nil)
	resp, err := srv.SyncResources(context.Background(), connect.NewRequest(&paprikav1.SyncResourcesRequest{
		Namespace: "test-ns", Name: "demo-app",
		Resources: []*paprikav1.ResourceSelector{
			{Kind: "Deployment", Name: "web", Namespace: "test-ns"},
			{Kind: "Service", Name: "web-svc", Namespace: "test-ns"},
		},
	}))
	require.NoError(t, err)
	require.True(t, resp.Msg.Accepted)
	require.True(t, resp.Msg.DryRun)
	require.Equal(t, uint32(2), resp.Msg.SelectedCount)
}

func TestSyncResources_UnmatchedSelectorRefuses(t *testing.T) {
	srv := NewPaprikaServer(detailTestClient(t, detailTestApp()), nil)
	resp, err := srv.SyncResources(context.Background(), connect.NewRequest(&paprikav1.SyncResourcesRequest{
		Namespace: "test-ns", Name: "demo-app",
		Resources: []*paprikav1.ResourceSelector{
			{Kind: "Deployment", Name: "web", Namespace: "test-ns"},
			{Kind: "StatefulSet", Name: "nonexistent", Namespace: "test-ns"},
		},
		Confirm: true,
	}))
	require.NoError(t, err)
	require.False(t, resp.Msg.Accepted)
	require.Len(t, resp.Msg.Unmatched, 1)
}

func TestSyncResources_ConfirmStampsRelease(t *testing.T) {
	app := detailTestApp()
	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-app-release", Namespace: "test-ns"},
	}
	srv := NewPaprikaServer(detailTestClient(t, app, release), nil)
	resp, err := srv.SyncResources(context.Background(), connect.NewRequest(&paprikav1.SyncResourcesRequest{
		Namespace: "test-ns", Name: "demo-app",
		Resources: []*paprikav1.ResourceSelector{
			{Kind: "Deployment", Name: "web", Namespace: "test-ns"},
		},
		Reason:  "retry flaky deployment",
		Confirm: true,
	}))
	require.NoError(t, err)
	require.False(t, resp.Msg.DryRun)
	require.NotEmpty(t, resp.Msg.SyncToken)

	var got pipelinesv1alpha1.Release
	require.NoError(t, srv.client.Get(context.Background(),
		client.ObjectKey{Namespace: "test-ns", Name: "demo-app-release"}, &got))
	require.Equal(t, resp.Msg.SyncToken, got.Annotations["paprika.io/resync"])
	var payload map[string]any
	require.NoError(t, json.Unmarshal([]byte(got.Annotations["paprika.io/sync-resources"]), &payload))
	require.Len(t, payload["resources"], 1)
}
