package pipelines

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	ktesting "k8s.io/client-go/testing"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/traffic"
	trafficmocks "github.com/benebsworth/paprika/internal/traffic/mocks"
)

func TestRegisteredClusterRoutingUsesAuthoritativeModeAndCredentialNamespace(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name          string
		mode          paprikav1.ClusterMode
		ref           paprikav1.ClusterRef
		configure     func(*clustersv1alpha1.Cluster)
		errContains   string
		wantNamespace string
	}{
		{name: "in-cluster", mode: paprikav1.ClusterModeInCluster, wantNamespace: "registrations"},
		{name: "direct defaults credentials to registration namespace", mode: paprikav1.ClusterModeDirect,
			configure: func(c *clustersv1alpha1.Cluster) {
				c.Spec.KubeconfigSecretRef = &clustersv1alpha1.SecretRef{Name: "remote-kubeconfig"}
			}, wantNamespace: "registrations"},
		{name: "direct explicit credential namespace", mode: paprikav1.ClusterModeDirect,
			configure: func(c *clustersv1alpha1.Cluster) {
				c.Spec.KubeconfigSecretRef = &clustersv1alpha1.SecretRef{Name: "remote-kubeconfig", Namespace: "credentials"}
			}, wantNamespace: "credentials"},
		{name: "classic registered agent keeps service discovery", mode: paprikav1.ClusterModeAgent, wantNamespace: "registrations"},
		{name: "explicit mode conflict", mode: paprikav1.ClusterModeAgent, ref: paprikav1.ClusterRef{Mode: paprikav1.ClusterModeInCluster}, errContains: "does not match registered"},
		{name: "disabled cluster", mode: paprikav1.ClusterModeInCluster, configure: func(c *clustersv1alpha1.Cluster) { c.Spec.Disabled = true }, errContains: "disabled"},
		{name: "direct server is insufficient", mode: paprikav1.ClusterModeDirect, configure: func(c *clustersv1alpha1.Cluster) { c.Spec.Server = "https://remote.example" }, errContains: "requires a kubeconfigSecretRef"},
		{name: "inline credentials do not override registration", mode: paprikav1.ClusterModeDirect, ref: paprikav1.ClusterRef{KubeconfigSecret: "inline"}, errContains: "requires a kubeconfigSecretRef"},
		{name: "custom kubeconfig key fails clearly", mode: paprikav1.ClusterModeDirect,
			configure: func(c *clustersv1alpha1.Cluster) {
				c.Spec.KubeconfigSecretRef = &clustersv1alpha1.SecretRef{Name: "remote-kubeconfig", Key: "other-key"}
			}, errContains: "key to be kubeconfig"},
		{name: "empty registered mode fails closed", errContains: "no deployment mode"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			cluster := &clustersv1alpha1.Cluster{ObjectMeta: metav1.ObjectMeta{Namespace: "registrations", Name: "remote"}, Spec: clustersv1alpha1.ClusterSpec{Mode: tc.mode}}
			if tc.configure != nil {
				tc.configure(cluster)
			}
			r := routingReconciler(t, cluster)
			ref := tc.ref
			ref.Name, ref.Namespace = cluster.Name, cluster.Namespace
			resolved, err := r.resolveClusterRef(context.Background(), &ref, "workloads")
			if tc.errContains != "" {
				require.ErrorContains(t, err, tc.errContains)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.mode, resolved.Mode)
			require.Equal(t, tc.wantNamespace, resolved.Namespace)
		})
	}
}

func TestMissingClusterRegistrationRequiresDeliberateInlineTransport(t *testing.T) {
	t.Parallel()
	r := routingReconciler(t, nil)
	for _, ref := range []paprikav1.ClusterRef{{Name: "missing"}, {Name: "missing", Mode: paprikav1.ClusterModeAgent}, {Name: "missing", Server: "https://remote.example"}} {
		_, err := r.resolveClusterRef(context.Background(), &ref, "workloads")
		require.ErrorContains(t, err, "not registered")
	}
	for _, tc := range []struct {
		ref  paprikav1.ClusterRef
		mode paprikav1.ClusterMode
	}{
		{ref: paprikav1.ClusterRef{}, mode: ""},
		{ref: paprikav1.ClusterRef{Name: "legacy", Mode: paprikav1.ClusterModeInCluster}, mode: paprikav1.ClusterModeInCluster},
		{ref: paprikav1.ClusterRef{Name: "legacy", KubeconfigSecret: "remote-kubeconfig"}, mode: paprikav1.ClusterModeDirect}, //nolint:gosec // Fake Kubernetes Secret name, not credential material.
		{ref: paprikav1.ClusterRef{Name: "legacy", AgentAddress: "https://agent.example"}, mode: paprikav1.ClusterModeAgent},
	} {
		resolved, err := r.resolveClusterRef(context.Background(), &tc.ref, "workloads")
		require.NoError(t, err)
		require.Equal(t, tc.mode, resolved.Mode)
	}
	_, err := r.resolveDynamicClient(context.Background(), "remote-kubeconfig", "workloads")
	require.ErrorContains(t, err, "connection manager is not configured")
}

func TestRemoteApplyAndHooksSeparateCredentialsFromWorkloadNamespace(t *testing.T) {
	t.Parallel()
	cluster := &clustersv1alpha1.Cluster{ObjectMeta: metav1.ObjectMeta{Namespace: "registrations", Name: "remote"}, Spec: clustersv1alpha1.ClusterSpec{
		Mode: paprikav1.ClusterModeDirect, KubeconfigSecretRef: &clustersv1alpha1.SecretRef{Name: "remote-kubeconfig"},
	}}
	r := routingReconciler(t, cluster)
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	appliedNamespace := ""
	dyn.PrependReactor("patch", "configmaps", func(action ktesting.Action) (bool, runtime.Object, error) {
		appliedNamespace = action.GetNamespace()
		return true, &unstructured.Unstructured{Object: map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]any{"name": "config", "namespace": action.GetNamespace()}}}, nil
	})
	pool := &routingClusterClientGetter{client: dyn}
	r.ClusterMgr = pool
	stage := &paprikav1.Stage{Spec: paprikav1.StageSpec{Cluster: paprikav1.ClusterRef{Name: cluster.Name, Namespace: cluster.Namespace}}}
	release := &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Namespace: "workloads", Name: "release", Labels: map[string]string{"app.paprika.io/name": "checkout"}}}
	require.NoError(t, r.applyPromotedManifests(context.Background(), release, stage, []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: config\n")))
	require.Equal(t, "remote-kubeconfig", pool.secret)
	require.Equal(t, "registrations", pool.namespace)
	require.Equal(t, "workloads", appliedNamespace)
	hooksClient, err := r.dynClientForStage(context.Background(), stage, release.Namespace)
	require.NoError(t, err)
	require.Same(t, dyn, hooksClient)
	require.Equal(t, "registrations", pool.namespace)

	cluster.Spec.Mode = paprikav1.ClusterModeAgent
	cluster.Spec.KubeconfigSecretRef = nil
	r = routingReconciler(t, cluster)
	stage.Spec.Cluster.AgentAddress = "https://agent.example"
	_, err = r.dynClientForStage(context.Background(), stage, release.Namespace)
	require.ErrorContains(t, err, "hook lifecycle is not supported")
}

func TestRemoteCanaryReadinessUsesCredentialNamespace(t *testing.T) {
	t.Parallel()
	r, _, release := buildCanaryReadinessReconciler(t, &paprikav1.CanaryConfig{Steps: []int{0, 100}}, 0, 0, time.Minute, testLiveDeployment(2, 2, 2, 2, 2, 2))
	getter, ok := r.ClusterMgr.(*fakeClusterClientGetter)
	require.True(t, ok)
	pool := &routingClusterClientGetter{client: getter.dyn}
	r.ClusterMgr = pool
	var stage paprikav1.Stage
	require.NoError(t, r.client.Get(context.Background(), types.NamespacedName{Namespace: release.Namespace, Name: release.Spec.Target}, &stage))
	stage.Spec.Cluster.Namespace = "credentials"
	ready, _, err := r.canaryWorkloadsReady(context.Background(), release, &stage)
	require.NoError(t, err)
	require.True(t, ready)
	require.Equal(t, "kc", pool.secret)
	require.Equal(t, "credentials", pool.namespace)
}

func TestRemoteTrafficRouterUsesTargetAndRejectsAgentTransport(t *testing.T) {
	t.Parallel()
	cluster := &clustersv1alpha1.Cluster{ObjectMeta: metav1.ObjectMeta{Namespace: "registrations", Name: "remote"}, Spec: clustersv1alpha1.ClusterSpec{
		Mode: paprikav1.ClusterModeDirect, KubeconfigSecretRef: &clustersv1alpha1.SecretRef{Name: "remote-kubeconfig"},
	}}
	r := routingReconciler(t, cluster)
	central := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	remote := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	r.DynamicClient = central
	r.ClusterMgr = &routingClusterClientGetter{client: remote}
	called := false
	r.TrafficRouterFactory = func(_ *paprikav1.TrafficRouter, target dynamic.Interface, _, _, _ string) (traffic.WeightRouter, error) {
		called = true
		require.Same(t, remote, target)
		return &trafficmocks.MockWeightRouter{}, nil
	}
	stage := &paprikav1.Stage{Spec: paprikav1.StageSpec{Cluster: paprikav1.ClusterRef{Name: cluster.Name, Namespace: cluster.Namespace}, TrafficRouter: &paprikav1.TrafficRouter{Provider: "gateway-api"}}}
	release := &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: "release", Namespace: "workloads"}}
	_, err := r.routerForStage(context.Background(), stage, release)
	require.NoError(t, err)
	require.True(t, called)
	require.Empty(t, central.Actions())

	cluster.Spec.Mode = paprikav1.ClusterModeAgent
	cluster.Spec.KubeconfigSecretRef = nil
	require.NoError(t, r.client.Update(context.Background(), cluster))
	stage.Spec.Cluster.AgentAddress = "https://agent.example"
	called = false
	_, err = r.routerForStage(context.Background(), stage, release)
	require.ErrorContains(t, err, "traffic routing is not supported")
	require.False(t, called)
	require.Empty(t, central.Actions())
}

func TestReleaseCleanupVisitsUniqueReferencedTargetsAndLeavesCentralClusterUntouched(t *testing.T) {
	t.Parallel()
	cluster := &clustersv1alpha1.Cluster{ObjectMeta: metav1.ObjectMeta{Namespace: "registrations", Name: "east"}, Spec: clustersv1alpha1.ClusterSpec{
		Mode: paprikav1.ClusterModeDirect, KubeconfigSecretRef: &clustersv1alpha1.SecretRef{Name: "east-kubeconfig"},
	}}
	r := routingReconciler(t, cluster)
	west := cluster.DeepCopy()
	west.Name, west.Spec.KubeconfigSecretRef.Name = "west", "west-kubeconfig"
	west.ResourceVersion = ""
	require.NoError(t, r.client.Create(context.Background(), west))
	for _, pair := range []struct{ stage, cluster string }{{"east-stage", "east"}, {"east-again", "east"}, {"west-stage", "west"}} {
		stage := &paprikav1.Stage{ObjectMeta: metav1.ObjectMeta{Name: pair.stage, Namespace: "workloads"}, Spec: paprikav1.StageSpec{Cluster: paprikav1.ClusterRef{Name: pair.cluster, Namespace: "registrations"}}}
		require.NoError(t, r.client.Create(context.Background(), stage))
	}
	snapshot := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "snapshot", Namespace: "workloads"}, Data: map[string]string{"manifests.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: owned\n"}}
	require.NoError(t, r.client.Create(context.Background(), snapshot))
	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	owned := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "owned", Namespace: "workloads", Labels: map[string]string{engine.ReleaseNameLabelKey: "release"}}}
	central := dynamicfake.NewSimpleDynamicClient(scheme, owned.DeepCopy())
	eastClient := dynamicfake.NewSimpleDynamicClient(scheme, owned.DeepCopy())
	westClient := dynamicfake.NewSimpleDynamicClient(scheme, owned.DeepCopy())
	pool := &routingClusterClientGetter{clients: map[string]dynamic.Interface{"east-kubeconfig": eastClient, "west-kubeconfig": westClient}}
	r.DynamicClient, r.ClusterMgr = central, pool
	release := &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: "release", Namespace: "workloads"}, Spec: paprikav1.ReleaseSpec{Target: "west-stage", From: "east-stage"}, Status: paprikav1.ReleaseStatus{
		CurrentStage: "east-again", RenderedManifestSnapshot: snapshot.Name, PromotionHistory: []paprikav1.PromotionEntry{{Stage: "east-stage"}, {Stage: "west-stage"}},
	}}
	require.NoError(t, r.cleanup(context.Background(), release))
	require.Equal(t, []string{"east-kubeconfig", "west-kubeconfig"}, pool.calls)
	require.Empty(t, central.Actions())
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}
	for _, target := range []dynamic.Interface{eastClient, westClient} {
		_, err := target.Resource(gvr).Namespace("workloads").Get(context.Background(), owned.Name, metav1.GetOptions{})
		require.True(t, apierrors.IsNotFound(err))
	}
	_, err := central.Resource(gvr).Namespace("workloads").Get(context.Background(), owned.Name, metav1.GetOptions{})
	require.NoError(t, err)
}

func TestMissingCleanupStagePreservesFinalizerAndManifestSnapshot(t *testing.T) {
	t.Parallel()
	r := routingReconciler(t, nil)
	dynamicClient := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	r.DynamicClient = dynamicClient
	release := &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: "release", Namespace: "workloads", Finalizers: []string{releaseFinalizer}}, Spec: paprikav1.ReleaseSpec{Target: "missing-stage"}, Status: paprikav1.ReleaseStatus{RenderedManifestSnapshot: "snapshot"}}
	require.NoError(t, r.client.Create(context.Background(), release))
	snapshot := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "snapshot", Namespace: "workloads"}}
	require.NoError(t, r.client.Create(context.Background(), snapshot))
	_, err := r.handleReleaseDeletion(context.Background(), release)
	require.ErrorContains(t, err, "get stage workloads/missing-stage")
	var saved paprikav1.Release
	require.NoError(t, r.client.Get(context.Background(), types.NamespacedName{Namespace: release.Namespace, Name: release.Name}, &saved))
	require.Contains(t, saved.Finalizers, releaseFinalizer)
	require.NoError(t, r.client.Get(context.Background(), types.NamespacedName{Namespace: snapshot.Namespace, Name: snapshot.Name}, &corev1.ConfigMap{}))
	require.Empty(t, dynamicClient.Actions())
}

func routingReconciler(t *testing.T, cluster *clustersv1alpha1.Cluster) *ReleaseReconciler {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, clustersv1alpha1.AddToScheme(scheme))
	require.NoError(t, paprikav1.AddToScheme(scheme))
	require.NoError(t, corev1.AddToScheme(scheme))
	builder := fake.NewClientBuilder().WithScheme(scheme)
	if cluster != nil {
		builder = builder.WithObjects(cluster)
	}
	return &ReleaseReconciler{client: builder.Build(), Scheme: scheme}
}

type routingClusterClientGetter struct {
	client    dynamic.Interface
	clients   map[string]dynamic.Interface
	calls     []string
	secret    string
	namespace string
}

func (p *routingClusterClientGetter) GetClient(_ context.Context, secret, namespace string) (dynamic.Interface, error) {
	p.secret, p.namespace = secret, namespace
	p.calls = append(p.calls, secret)
	if p.clients != nil {
		return p.clients[secret], nil
	}
	return p.client, nil
}
