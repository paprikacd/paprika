package pipelines

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/health"
)

const remoteConfigManifest = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: config\ndata:\n  setting: desired\n"

func TestApplicationDiffUsesRemoteTargetAndSourceNamespaceWithoutChangingSharedEngine(t *testing.T) {
	t.Parallel()
	r, app, cluster := remoteApplicationDiffFixture(t, remoteConfigManifest)
	app.Spec.Source.TargetNamespace = "remote-workloads"
	remote := dynamicfake.NewSimpleDynamicClient(r.Scheme, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "config", Namespace: "remote-workloads", Labels: map[string]string{
		engine.ManagedByLabelKey: engine.ManagedByLabelValue, engine.ApplicationNameLabelKey: app.Name,
	}}, Data: map[string]string{"setting": "desired"}})
	shared := &applicationDiffRecorder{}
	r.DiffEngine = shared
	manager := &applicationDiffClusterManager{client: remote, config: &rest.Config{Host: "https://unused.example"}}
	r.ClusterMgr = manager
	result := r.evaluateDiff(context.Background(), app)
	require.NotNil(t, result)
	require.Equal(t, 0, result.OutOfSyncCount())
	require.Zero(t, shared.calls)
	require.Same(t, shared, r.DiffEngine)
	require.Equal(t, cluster.Spec.KubeconfigSecretRef.Name, manager.secret)
	require.Equal(t, cluster.Namespace, manager.namespace)
	require.Equal(t, "remote-workloads", app.Status.Resources[0].Namespace)
	// Config adaptation is defensive, leaving the manager's pooled config alone.
	require.Zero(t, manager.config.QPS)
	require.Zero(t, manager.config.Burst)
	require.Nil(t, manager.config.WrapTransport)
	r.evaluateResourceHealth(context.Background(), app, result)
	require.Equal(t, "Healthy", app.Status.ResourceHealth[0].Health)
}

func TestApplicationDiffUsesRemoteDiscoveryAndPreservesExplicitManifestNamespace(t *testing.T) {
	t.Parallel()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/apis/example.test/v1" {
			http.NotFound(w, req)
			return
		}
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"apiVersion":"v1","kind":"APIResourceList","groupVersion":"example.test/v1","resources":[{"name":"people","singularName":"person","namespaced":true,"kind":"Person","verbs":["get","list"]}]}`)
	}))
	defer server.Close()
	manifest := "apiVersion: example.test/v1\nkind: Person\nmetadata:\n  name: person\n  namespace: declared\nspec:\n  setting: desired\n"
	r, app, _ := remoteApplicationDiffFixture(t, manifest)
	app.Spec.Source.TargetNamespace = "fallback"
	object := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.test/v1", "kind": "Person", "metadata": map[string]any{
			"name": "person", "namespace": "declared", "labels": map[string]any{engine.ManagedByLabelKey: engine.ManagedByLabelValue, engine.ApplicationNameLabelKey: app.Name},
		}, "spec": map[string]any{"setting": "desired"},
	}}
	gvr := schema.GroupVersionResource{Group: "example.test", Version: "v1", Resource: "people"}
	remote := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{gvr: "PersonList"})
	_, err := remote.Resource(gvr).Namespace("declared").Create(context.Background(), object, metav1.CreateOptions{})
	require.NoError(t, err)
	remote.ClearActions()
	r.ClusterMgr = &applicationDiffClusterManager{client: remote, config: &rest.Config{Host: server.URL}}
	shared := &applicationDiffRecorder{}
	r.DiffEngine = shared
	result := r.evaluateDiff(context.Background(), app)
	require.NotNil(t, result)
	require.Equal(t, 0, result.OutOfSyncCount())
	require.Greater(t, requests.Load(), int32(0))
	require.Zero(t, shared.calls)
	require.Equal(t, "declared", app.Status.Resources[0].Namespace)
	for _, action := range remote.Actions() {
		require.Equal(t, gvr, action.GetResource())
		require.Equal(t, "declared", action.GetNamespace())
	}
}

func TestUnavailableApplicationTargetDoesNotUseCentralDiffHealthOrSelfHeal(t *testing.T) {
	t.Parallel()
	r, app, cluster := remoteApplicationDiffFixture(t, remoteConfigManifest)
	cluster.Spec.Mode, cluster.Spec.KubeconfigSecretRef = paprikav1.ClusterModeAgent, nil
	require.NoError(t, r.client.Update(context.Background(), cluster))
	shared := &applicationDiffRecorder{}
	r.DiffEngine = shared
	var healthReads atomic.Int32
	healthClient := fake.NewClientBuilder().WithScheme(r.Scheme).WithInterceptorFuncs(interceptor.Funcs{Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, object client.Object, opts ...client.GetOption) error {
		healthReads.Add(1)
		return c.Get(ctx, key, object, opts...)
	}}).Build()
	r.ResHealth = health.NewResourceHealthChecker(healthClient)
	app.Status.OutOfSync, app.Status.Synced = 5, true
	app.Status.Phase = paprikav1.ApplicationHealthy
	app.Status.Resources = []paprikav1.ResourceSync{{Kind: "ConfigMap", Name: "config", Namespace: app.Namespace, Status: "Missing"}}
	app.Spec.SyncPolicy = paprikav1.SyncAuto
	app.Spec.SelfHeal = &paprikav1.SelfHealConfig{AutoSyncOnDrift: true}
	result := r.evaluateDiff(context.Background(), app)
	require.Nil(t, result)
	require.Zero(t, shared.calls)
	require.True(t, applicationDiffUnavailable(app))
	require.False(t, app.Status.Synced)
	require.Equal(t, paprikav1.HealthUnknown, app.Status.Health)
	r.evaluateResourceHealth(context.Background(), app, result)
	require.Zero(t, healthReads.Load())
	require.Equal(t, "Unknown", app.Status.ResourceHealth[0].Health)
	require.NoError(t, r.reconcileSelfHeal(context.Background(), app))
	require.False(t, meta.IsStatusConditionTrue(app.Status.Conditions, selfHealConditionType))
	require.Nil(t, app.Status.LastSelfHealTime)
	var stored paprikav1.Application
	require.NoError(t, r.client.Get(context.Background(), types.NamespacedName{Namespace: app.Namespace, Name: app.Name}, &stored))
	require.Empty(t, stored.Annotations[syncAnnotation])
}

func TestApplicationDiffCannotFallbackAfterMissingRegistrationOrDiscoveryFailure(t *testing.T) {
	t.Parallel()
	for _, scenario := range []string{"missing registration", "missing stage", "discovery configuration failed"} {
		t.Run(scenario, func(t *testing.T) {
			r, app, cluster := remoteApplicationDiffFixture(t, remoteConfigManifest)
			shared := &applicationDiffRecorder{}
			r.DiffEngine = shared
			switch scenario {
			case "missing registration":
				require.NoError(t, r.client.Delete(context.Background(), cluster))
			case "missing stage":
				require.NoError(t, r.client.Delete(context.Background(), &paprikav1.Stage{ObjectMeta: metav1.ObjectMeta{Namespace: app.Namespace, Name: app.Name + "-production"}}))
			default:
				r.ClusterMgr = &applicationDiffClusterManager{client: dynamicfake.NewSimpleDynamicClient(r.Scheme), configErr: errors.New("config unavailable")}
			}
			require.Nil(t, r.evaluateDiff(context.Background(), app))
			require.Zero(t, shared.calls)
			require.True(t, applicationDiffUnavailable(app))
		})
	}
}

func TestApplicationLocalDiffKeepsExistingSharedEngineAndClearsUnavailableCondition(t *testing.T) {
	t.Parallel()
	r, app, cluster := remoteApplicationDiffFixture(t, remoteConfigManifest)
	cluster.Spec.Mode, cluster.Spec.KubeconfigSecretRef = paprikav1.ClusterModeInCluster, nil
	require.NoError(t, r.client.Update(context.Background(), cluster))
	shared := &applicationDiffRecorder{}
	r.DiffEngine = shared
	app.Status.Phase = paprikav1.ApplicationHealthy
	markApplicationDiffUnavailable(app)
	result := r.evaluateDiff(context.Background(), app)
	require.NotNil(t, result)
	require.Equal(t, 1, shared.calls)
	require.Same(t, shared, r.DiffEngine)
	require.False(t, applicationDiffUnavailable(app))
	require.True(t, app.Status.Synced)
}

func remoteApplicationDiffFixture(t *testing.T, manifest string) (*ApplicationReconciler, *paprikav1.Application, *clustersv1alpha1.Cluster) {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	require.NoError(t, paprikav1.AddToScheme(scheme))
	require.NoError(t, clustersv1alpha1.AddToScheme(scheme))
	cluster := &clustersv1alpha1.Cluster{ObjectMeta: metav1.ObjectMeta{Name: "remote", Namespace: "registrations"}, Spec: clustersv1alpha1.ClusterSpec{Mode: paprikav1.ClusterModeDirect, KubeconfigSecretRef: &clustersv1alpha1.SecretRef{Name: "remote-kubeconfig"}}}
	app := &paprikav1.Application{ObjectMeta: metav1.ObjectMeta{Name: "checkout", Namespace: "workloads"}, Spec: paprikav1.ApplicationSpec{Source: paprikav1.ApplicationSource{Type: paprikav1.SourceTypeInline}}, Status: paprikav1.ApplicationStatus{ReleaseRef: "release"}}
	stage := &paprikav1.Stage{ObjectMeta: metav1.ObjectMeta{Name: app.Name + "-production", Namespace: app.Namespace}, Spec: paprikav1.StageSpec{Cluster: paprikav1.ClusterRef{Name: cluster.Name, Namespace: cluster.Namespace}}}
	release := &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, Spec: paprikav1.ReleaseSpec{Target: stage.Name}, Status: paprikav1.ReleaseStatus{RenderedManifestSnapshot: "snapshot"}}
	snapshot := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "snapshot", Namespace: app.Namespace}, Data: map[string]string{"manifests.yaml": manifest}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(cluster, app, stage, release, snapshot).Build()
	return &ApplicationReconciler{client: c, Scheme: scheme}, app, cluster
}

type applicationDiffRecorder struct{ calls int }

func (r *applicationDiffRecorder) ComputeDiff(context.Context, []unstructured.Unstructured, *engine.DiffOptions) (*engine.DiffResult, error) {
	r.calls++
	return &engine.DiffResult{}, nil
}

type applicationDiffClusterManager struct {
	client    dynamic.Interface
	config    *rest.Config
	configErr error
	secret    string
	namespace string
}

func (m *applicationDiffClusterManager) GetClient(_ context.Context, secret, namespace string) (dynamic.Interface, error) {
	m.secret, m.namespace = secret, namespace
	return m.client, nil
}

func (m *applicationDiffClusterManager) GetRestConfig(_ context.Context, secret, namespace string) (*rest.Config, error) {
	m.secret, m.namespace = secret, namespace
	return m.config, m.configErr
}
