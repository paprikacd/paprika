package satellitecontrol_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/version"
	"k8s.io/apimachinery/pkg/watch"
	discoveryfake "k8s.io/client-go/discovery/fake"
	kubernetesfake "k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/tools/cache"
	crcache "sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	"github.com/benebsworth/paprika/internal/fleet"
	"github.com/benebsworth/paprika/internal/satellite"
	"github.com/benebsworth/paprika/internal/satellitecontrol"
)

func TestCollectorReceiverPersistsAndMergesClusterObservations(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	require.NoError(t, clustersv1alpha1.AddToScheme(scheme))
	const registrationNamespace = "paprika-system"
	eastToken, westToken := strings.Repeat("e", 64), strings.Repeat("w", 64)
	central := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clustersv1alpha1.Cluster{}).
		WithObjects(integrationTokenSecret("east", eastToken), integrationTokenSecret("west", westToken)).Build()
	eastKey := client.ObjectKey{Namespace: registrationNamespace, Name: "east"}
	westKey := client.ObjectKey{Namespace: registrationNamespace, Name: "west"}
	for _, key := range []client.ObjectKey{eastKey, westKey} {
		require.True(t, apierrors.IsNotFound(central.Get(ctx, key, &clustersv1alpha1.Cluster{})), "cluster must not be pre-registered")
	}
	mux := http.NewServeMux()
	mux.Handle(satellite.ReportPath, satellitecontrol.NewHandler(central))
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	// Consume the persisted Cluster objects through the production fleet source,
	// using a real shared informer backed by the fake central API's List/Watch.
	watchStarted := make(chan struct{}, 1)
	informer := cache.NewSharedIndexInformer(integrationClusterListWatch{&cache.ListWatch{
		ListWithContextFunc: func(ctx context.Context, _ metav1.ListOptions) (runtime.Object, error) {
			var list clustersv1alpha1.ClusterList
			return &list, central.List(ctx, &list)
		},
		WatchFuncWithContext: func(ctx context.Context, _ metav1.ListOptions) (watch.Interface, error) {
			stream, err := central.Watch(ctx, &clustersv1alpha1.ClusterList{})
			if err == nil {
				select {
				case watchStarted <- struct{}{}:
				default:
				}
			}
			return stream, err
		},
	}}, &clustersv1alpha1.Cluster{}, 0, cache.Indexers{})
	source, err := fleet.NewClusterSatelliteSource(ctx, integrationClusterInformer{informer})
	require.NoError(t, err)
	informerContext, stopInformer := context.WithCancel(ctx)
	informerDone := make(chan struct{})
	go func() { defer close(informerDone); informer.Run(informerContext.Done()) }()
	t.Cleanup(func() {
		stopInformer()
		select {
		case <-informerDone:
		case <-time.After(3 * time.Second):
			t.Error("central Cluster informer did not stop")
		}
	})
	select {
	case <-watchStarted:
	case <-ctx.Done():
		t.Fatal("central Cluster watch did not start")
	}

	east := startIntegrationCollector(ctx, t, server.URL, "east", eastToken)
	west := startIntegrationCollector(ctx, t, server.URL, "west", westToken)
	initialEast := awaitIntegrationCluster(ctx, t, central, eastKey, func(cluster *clustersv1alpha1.Cluster) bool {
		return cluster.Status.Satellite != nil && len(cluster.Status.Satellite.Applications) == 1
	})
	initialWest := awaitIntegrationCluster(ctx, t, central, westKey, func(cluster *clustersv1alpha1.Cluster) bool {
		return cluster.Status.Satellite != nil && len(cluster.Status.Satellite.Applications) == 1
	})
	for _, cluster := range []*clustersv1alpha1.Cluster{initialEast, initialWest} {
		require.Equal(t, clustersv1alpha1.ClusterModeAgent, cluster.Spec.Mode)
		require.Equal(t, cluster.Name+"-satellite-token", cluster.Spec.Satellite.TokenSecretRef.Name)
		require.Equal(t, "token", cluster.Spec.Satellite.TokenSecretRef.Key)
		require.Equal(t, "physical-"+cluster.Name, cluster.Status.Satellite.ClusterUID)
		require.NotEmpty(t, cluster.Status.Satellite.SessionID)
		require.GreaterOrEqual(t, cluster.Status.Satellite.Sequence, int64(1))
		require.NotEmpty(t, cluster.Status.Satellite.ReportDigest)
		require.NotNil(t, cluster.Status.Satellite.LastSeen)
		require.Equal(t, clustersv1alpha1.ClusterPhaseHealthy, cluster.Status.Phase)
		require.Equal(t, "v1.36.2", cluster.Status.Version)
		require.Equal(t, int32(1), cluster.Status.Inventory.NodeCount)
		require.Equal(t, int32(1), cluster.Status.Inventory.ReadyNodeCount)
		require.Equal(t, int32(1), cluster.Status.Inventory.PodCount)
		require.Equal(t, int32(1), cluster.Status.Inventory.RunningPodCount)
		require.Equal(t, int32(2), cluster.Status.Inventory.NamespaceCount)
		app := cluster.Status.Satellite.Applications[0]
		require.Equal(t, "production", app.Namespace)
		require.Equal(t, "payments", app.Name)
		require.Equal(t, "Healthy", app.Health)
		require.False(t, app.SyncKnown, "native workloads have no Paprika desired-state comparison")
	}

	appID := types.NamespacedName{Namespace: "production", Name: "payments"}
	merged := awaitIntegrationFleet(ctx, t, source, func(snapshot *fleet.Snapshot) bool {
		return len(snapshot.Applications[appID].Targets) == 2
	})
	require.Len(t, merged.Applications, 1, "same namespace/name must form one logical app")
	app := merged.Applications[appID]
	require.True(t, app.SatelliteOnly)
	require.Equal(t, uint32(2), app.ResourceCount)
	require.Equal(t, fleet.HealthHealthy, app.Health)
	require.Equal(t, fleet.SyncStateUnknown, app.Sync)
	require.NotEqual(t, app.Targets[0].StableID, app.Targets[1].StableID)
	for _, key := range []client.ObjectKey{eastKey, westKey} {
		require.Contains(t, merged.ByCluster[key], appID)
	}
	page, err := merged.QueryApplications(fleet.QueryScope{
		Projects: fleet.ProjectSet{app.Project: {}},
		CapabilitiesByProject: map[fleet.ProjectKey]fleet.CapabilitySet{
			app.Project: {fleet.CapabilityApplicationSync: {}},
		},
	}, fleet.ApplicationQuery{}, "")
	require.NoError(t, err)
	require.Len(t, page.Applications, 1)
	require.Empty(t, page.Applications[0].Capabilities, "observed apps must remain read-only even for authorized project operators")

	workload, err := east.AppsV1().Deployments("production").Get(ctx, "payments-web", metav1.GetOptions{})
	require.NoError(t, err)
	workload.Status.AvailableReplicas = 0
	_, err = east.AppsV1().Deployments("production").UpdateStatus(ctx, workload, metav1.UpdateOptions{})
	require.NoError(t, err)
	updatedEast := awaitIntegrationCluster(ctx, t, central, eastKey, func(cluster *clustersv1alpha1.Cluster) bool {
		state := cluster.Status.Satellite
		return state != nil && state.Sequence > initialEast.Status.Satellite.Sequence && len(state.Applications) == 1 && state.Applications[0].Health == "Degraded"
	})
	require.Equal(t, initialEast.Status.Satellite.SessionID, updatedEast.Status.Satellite.SessionID)
	updatedFleet := awaitIntegrationFleet(ctx, t, source, func(snapshot *fleet.Snapshot) bool {
		return snapshot.Applications[appID].Health == fleet.HealthDegraded
	})
	require.Len(t, updatedFleet.Applications[appID].Targets, 2)
	placementHealth := map[fleet.ClusterKey]fleet.Health{eastKey: fleet.HealthDegraded, westKey: fleet.HealthHealthy}
	for _, target := range updatedFleet.Applications[appID].Targets {
		require.Equal(t, placementHealth[target.Cluster], target.Health)
	}
	require.Equal(t, fleet.HealthHealthy, merged.Applications[appID].Health, "previous fleet snapshots must remain immutable")

	require.NoError(t, east.AppsV1().Deployments("production").Delete(ctx, "payments-web", metav1.DeleteOptions{}))
	deletedEast := awaitIntegrationCluster(ctx, t, central, eastKey, func(cluster *clustersv1alpha1.Cluster) bool {
		state := cluster.Status.Satellite
		return state != nil && state.Sequence > updatedEast.Status.Satellite.Sequence && len(state.Applications) == 0
	})
	require.Equal(t, updatedEast.Status.Satellite.SessionID, deletedEast.Status.Satellite.SessionID)
	afterDelete := awaitIntegrationFleet(ctx, t, source, func(snapshot *fleet.Snapshot) bool {
		app := snapshot.Applications[appID]
		return len(app.Targets) == 1 && app.Targets[0].Cluster == westKey
	})
	require.Equal(t, uint32(1), afterDelete.Applications[appID].ResourceCount)
	require.Equal(t, fleet.HealthHealthy, afterDelete.Applications[appID].Health)
	require.NotContains(t, afterDelete.ByCluster[eastKey], appID)

	require.NoError(t, west.AppsV1().Deployments("production").Delete(ctx, "payments-web", metav1.DeleteOptions{}))
	awaitIntegrationCluster(ctx, t, central, westKey, func(cluster *clustersv1alpha1.Cluster) bool {
		return cluster.Status.Satellite != nil && len(cluster.Status.Satellite.Applications) == 0
	})
	final := awaitIntegrationFleet(ctx, t, source, func(snapshot *fleet.Snapshot) bool { return len(snapshot.Applications) == 0 })
	require.Len(t, final.Clusters, 2, "deleting workloads must retain cluster registrations")
}

func integrationTokenSecret(name, token string) *corev1.Secret {
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: "paprika-system", Name: name + "-satellite-token",
			Labels: map[string]string{satellitecontrol.CredentialLabel: name},
		},
		Data: map[string][]byte{"token": []byte(token)},
	}
}

func startIntegrationCollector(ctx context.Context, t *testing.T, url, name, token string) *kubernetesfake.Clientset {
	t.Helper()
	core := kubernetesfake.NewClientset(
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "kube-system", UID: types.UID("physical-" + name)}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "production", UID: types.UID(name + "-production")}},
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node", UID: types.UID(name + "-node")}, Status: corev1.NodeStatus{
			Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}},
		}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "payments-pod", Namespace: "production", UID: types.UID(name + "-pod")}, Status: corev1.PodStatus{Phase: corev1.PodRunning}},
		&appsv1.Deployment{
			ObjectMeta: metav1.ObjectMeta{
				Name: "payments-web", Namespace: "production", UID: types.UID(name + "-workload"), Generation: 1,
				Labels: map[string]string{"app.kubernetes.io/part-of": "payments"},
			},
			Status: appsv1.DeploymentStatus{ObservedGeneration: 1, UpdatedReplicas: 1, AvailableReplicas: 1, ReadyReplicas: 1},
		},
	)
	discovery, ok := core.Discovery().(*discoveryfake.FakeDiscovery)
	require.True(t, ok)
	discovery.FakedServerVersion = &version.Info{GitVersion: "v1.36.2"}
	tokenFile := filepath.Join(t.TempDir(), "token")
	require.NoError(t, os.WriteFile(tokenFile, []byte(token), 0600))
	collector, err := satellite.NewCollector(core, nil, satellite.Config{
		ControlPlaneURL: url, ClusterName: name, ClusterNamespace: "paprika-system", DisplayName: name + " region",
		TokenFile: tokenFile, BatchInterval: 100 * time.Millisecond, HeartbeatInterval: time.Second,
	})
	require.NoError(t, err)
	collectorContext, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- collector.Run(collectorContext) }()
	t.Cleanup(func() {
		stop()
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(3 * time.Second):
			t.Errorf("%s collector did not stop", name)
		}
	})
	return core
}

func awaitIntegrationCluster(ctx context.Context, t *testing.T, central client.Client, key client.ObjectKey, match func(*clustersv1alpha1.Cluster) bool) *clustersv1alpha1.Cluster {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	var last clustersv1alpha1.Cluster
	for {
		err := central.Get(ctx, key, &last)
		if err == nil && match(&last) {
			return last.DeepCopy()
		}
		if err != nil && !apierrors.IsNotFound(err) {
			require.NoError(t, err)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("timed out awaiting %s persisted observation: %+v", key, last.Status)
		case <-ticker.C:
		}
	}
}

func awaitIntegrationFleet(ctx context.Context, t *testing.T, source *fleet.ClusterSatelliteSource, match func(*fleet.Snapshot) bool) *fleet.Snapshot {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	var observations []fleet.SatelliteSnapshot
	var readyError error
	for {
		readyError = source.CheckReady()
		if readyError == nil {
			var generation uint64
			generation, observations = source.FleetSnapshots()
			merged, err := fleet.MergeSatelliteSnapshots(fleet.NewSnapshot(0), observations, generation)
			require.NoError(t, err)
			if match(merged) {
				return merged
			}
		}
		select {
		case <-ctx.Done():
			t.Fatalf("timed out awaiting merged satellite fleet: readiness=%v observations=%+v", readyError, observations)
		case <-ticker.C:
		}
	}
}

type integrationClusterInformer struct{ cache.SharedIndexInformer }

func (i integrationClusterInformer) GetInformer(context.Context, client.Object, ...crcache.InformerGetOption) (crcache.Informer, error) {
	return i.SharedIndexInformer, nil
}

type integrationClusterListWatch struct{ *cache.ListWatch }

// The controller-runtime fake supports ordinary List/Watch, without initial
// watch events or bookmarks. Keep this local to the fake instead of changing
// process-wide client-go feature gates.
func (integrationClusterListWatch) IsWatchListSemanticsUnSupported() bool { return true }
