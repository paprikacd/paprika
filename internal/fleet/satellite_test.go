package fleet

import (
	"context"
	stderrors "errors"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/cache"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestSatelliteMergeGroupsPlacementsWithoutNamespaceOrProjectCollisions(t *testing.T) {
	t.Parallel()
	first := satelliteFixture("east")
	second := satelliteFixture("west")
	first.Applications = []ApplicationSummary{
		satelliteAppFixture("shop", "checkout", HealthHealthy, 4),
		satelliteAppFixture("tenant-b", "checkout", HealthHealthy, 7),
	}
	second.Applications = []ApplicationSummary{satelliteAppFixture("shop", "checkout", HealthDegraded, 6)}
	second.Applications[0].DriftCount = 2
	second.Applications[0].Sync = SyncStateOutOfSync
	merged, err := MergeSatelliteSnapshots(NewSnapshot(1), []SatelliteSnapshot{second, first}, 2)
	require.NoError(t, err)
	require.Len(t, merged.Applications, 2)
	app := merged.Applications[fleetID("shop", "checkout")]
	require.True(t, app.SatelliteOnly)
	require.Equal(t, uint32(10), app.ResourceCount)
	require.Equal(t, uint32(2), app.DriftCount)
	require.Equal(t, HealthDegraded, app.Health)
	require.Equal(t, SyncStateOutOfSync, app.Sync)
	require.Len(t, app.Targets, 2)
	require.Contains(t, merged.ByCluster[first.Cluster.Identity], app.Identity)
	require.Contains(t, merged.ByCluster[second.Cluster.Identity], app.Identity)

	conflict := satelliteFixture("private")
	conflict.Applications = []ApplicationSummary{satelliteAppFixture("shop", "checkout", HealthFailed, 100)}
	conflict.Applications[0].Project = fleetID("shop", "secret")
	merged, err = MergeSatelliteSnapshots(merged, []SatelliteSnapshot{conflict}, 3)
	require.NoError(t, err)
	require.Equal(t, uint32(10), merged.Applications[app.Identity].ResourceCount)
	require.NotContains(t, merged.ByProject, fleetID("shop", "secret"))
}

func TestSatelliteMergeRetainsCentralIdentityAndAvoidsCountingItsPlacementTwice(t *testing.T) {
	t.Parallel()
	east, west := satelliteFixture("a-east"), satelliteFixture("z-west")
	local := NewSnapshot(4)
	central := satelliteAppFixture("shop", "checkout-control", HealthHealthy, 8)
	central.SatelliteOnly = false
	central.LogicalIdentityName = "checkout"
	central.CurrentCluster = west.Cluster.Identity
	central.ReleaseState = ReleaseStateCanarying
	central.SourceType = SourceTypeGit
	central.Targets = []StageTargetSummary{{StableID: "central-prod", Stage: "production", Cluster: west.Cluster.Identity, Health: HealthHealthy}}
	addApplicationMutable(local, &central)
	east.Applications = []ApplicationSummary{satelliteAppFixture("shop", "checkout", HealthHealthy, 4)}
	west.Applications = []ApplicationSummary{satelliteAppFixture("shop", "checkout", HealthDegraded, 6)}
	merged, err := MergeSatelliteSnapshots(local, []SatelliteSnapshot{east, west}, 5)
	require.NoError(t, err)
	require.Len(t, merged.Applications, 1)
	app := merged.Applications[central.Identity]
	require.False(t, app.SatelliteOnly)
	require.Equal(t, central.Identity, app.Identity)
	require.Equal(t, ReleaseStateCanarying, app.ReleaseState)
	require.Equal(t, SourceTypeGit, app.SourceType)
	require.Equal(t, uint32(10), app.ResourceCount)
	require.Len(t, app.Targets, 2)
	for _, target := range app.Targets {
		if target.Cluster == west.Cluster.Identity {
			require.Equal(t, "production", target.Stage)
			require.Equal(t, HealthDegraded, target.Health)
		}
	}
	require.Equal(t, uint32(8), local.Applications[central.Identity].ResourceCount)
	require.Equal(t, HealthHealthy, local.Applications[central.Identity].Targets[0].Health)
}

func TestSatelliteMergeCoalescesExplicitAliasesAndDuplicateReports(t *testing.T) {
	t.Parallel()
	cluster := satelliteFixture("production")
	first := satelliteAppFixture("shop", "checkout", HealthDegraded, 2)
	first.Targets = []StageTargetSummary{{StableID: "physical-a"}}
	second := satelliteAppFixture("shop", "checkout", HealthHealthy, 3)
	second.Targets = []StageTargetSummary{{StableID: "physical-b"}}
	cluster.Applications = []ApplicationSummary{first, second, first}
	merged, err := MergeSatelliteSnapshots(NewSnapshot(0), []SatelliteSnapshot{cluster}, 1)
	require.NoError(t, err)
	app := merged.Applications[first.Identity]
	require.Equal(t, uint32(5), app.ResourceCount)
	require.Len(t, app.Targets, 1)
	require.Equal(t, HealthDegraded, app.Targets[0].Health)
}

func TestSatelliteReaderCachesImmutableViewsAndClearsVirtualCapabilities(t *testing.T) {
	t.Parallel()
	index := NewIndex()
	require.NoError(t, index.Install(NewSnapshot(7)))
	source := &fixtureSatelliteSource{generation: 1, satellites: []SatelliteSnapshot{satelliteFixture("production")}}
	source.satellites[0].Applications = []ApplicationSummary{satelliteAppFixture("shop", "checkout", HealthHealthy, 3)}
	reader, err := NewSatelliteReader(index, source)
	require.NoError(t, err)
	first, err := reader.LoadSnapshot()
	require.NoError(t, err)
	second, err := reader.LoadSnapshot()
	require.NoError(t, err)
	require.Same(t, first, second)
	project := fleetID("shop", "default")
	scope := QueryScope{
		Projects:              ProjectSet{project: {}},
		CapabilitiesByProject: map[ProjectKey]CapabilitySet{project: {CapabilityApplicationSync: {}}},
	}
	// Direct snapshot users receive the same read-only contract as the reader.
	page, err := first.QueryApplications(scope, ApplicationQuery{}, "")
	require.NoError(t, err)
	require.Len(t, page.Applications, 1)
	require.Empty(t, page.Applications[0].Capabilities)

	source.generation++
	source.satellites[0].Cluster.Connection = ConnectionStateUnhealthy
	third, err := reader.LoadSnapshot()
	require.NoError(t, err)
	require.NotSame(t, first, third)
	require.Greater(t, third.Generation, first.Generation)
	id := fleetID("shop", "checkout")
	require.Equal(t, HealthUnknown, third.Applications[id].Health)
	require.Equal(t, SyncStateUnknown, third.Applications[id].Sync)
	require.Equal(t, HealthHealthy, first.Applications[id].Health)
	attention, err := third.QueryStatus(scope, StatusQuery{})
	require.NoError(t, err)
	require.Len(t, attention.Attention, 1)
	require.Empty(t, attention.Attention[0].Capabilities)
	source.satellites = nil
	source.generation++
	fourth, err := reader.LoadSnapshot()
	require.NoError(t, err)
	require.Empty(t, fourth.Applications)
	require.NoError(t, index.SetHealth(HealthState{Degraded: true, Reason: "cache unavailable"}))
	require.ErrorContains(t, reader.CheckReady(), "cache unavailable")
}

func TestSatelliteReaderWaitsForInitialClusterHandlerDeliveries(t *testing.T) {
	t.Parallel()
	index := NewIndex()
	require.NoError(t, index.Install(NewSnapshot(1)))
	informers := newFakeRuntimeInformerSource()
	source, err := NewClusterSatelliteSource(context.Background(), informers)
	require.NoError(t, err)
	reader, err := NewSatelliteReader(index, source)
	require.NoError(t, err)
	require.ErrorContains(t, source.CheckReady(), "initializing")
	require.ErrorContains(t, reader.CheckReady(), "initializing")
	view, err := reader.LoadSnapshot()
	require.ErrorContains(t, err, "initializing")
	require.Nil(t, view)

	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Namespace: "clusters", Name: "east"},
		Spec: clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeAgent,
			Satellite: &clustersv1alpha1.SatelliteSpec{}},
		Status: clustersv1alpha1.ClusterStatus{
			Phase: clustersv1alpha1.ClusterPhaseHealthy,
			Satellite: &clustersv1alpha1.SatelliteStatus{
				LastSeen: &metav1.Time{Time: time.Now()},
				Applications: []clustersv1alpha1.SatelliteApplication{
					{Namespace: "shop", Name: "checkout", Health: "Healthy", ResourceCount: 3},
				},
			},
		},
	}
	informer := informers.informerFor(cluster)
	informer.update(nil, cluster)
	// Receiving one object is insufficient until the handler's complete initial
	// delivery has finished, even though the local fleet is already available.
	require.Error(t, reader.CheckReady())
	informer.setSynced()
	require.NoError(t, reader.CheckReady())
	view, err = reader.LoadSnapshot()
	require.NoError(t, err)
	require.Equal(t, uint32(3), view.Applications[fleetID("shop", "checkout")].ResourceCount)
}

func TestSatelliteReportsDoNotRebuildUnchangedCentralPlacements(t *testing.T) {
	t.Parallel()
	base := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Namespace: "clusters", Name: "east", ResourceVersion: "1"},
		Spec: clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeAgent,
			Satellite: &clustersv1alpha1.SatelliteSpec{}},
		Status: clustersv1alpha1.ClusterStatus{Phase: clustersv1alpha1.ClusterPhaseHealthy},
	}
	for _, tc := range []struct {
		name      string
		configure func(*clustersv1alpha1.Cluster, *clustersv1alpha1.Cluster)
		wantQueue int
	}{
		{name: "report observations are handled by satellite source", configure: func(_, current *clustersv1alpha1.Cluster) {
			current.Status.Satellite = &clustersv1alpha1.SatelliteStatus{Sequence: 2,
				Applications: []clustersv1alpha1.SatelliteApplication{{Namespace: "shop", Name: "checkout", Health: "Failed"}}}
		}},
		{name: "connection change updates central targets", wantQueue: 1, configure: func(_, current *clustersv1alpha1.Cluster) {
			current.Status.Phase = clustersv1alpha1.ClusterPhaseUnhealthy
		}},
		{name: "renaming updates central targets", wantQueue: 1, configure: func(_, current *clustersv1alpha1.Cluster) {
			current.Spec.DisplayName = "Europe"
		}},
		{name: "removing satellite retains ordinary projection", wantQueue: 1, configure: func(_, current *clustersv1alpha1.Cluster) {
			current.Spec.Satellite = nil
		}},
		{name: "ordinary clusters retain existing updates", wantQueue: 1, configure: func(old, current *clustersv1alpha1.Cluster) {
			old.Spec.Satellite, current.Spec.Satellite = nil, nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, _, _ := populatedProjectionStore()
			runtime, err := NewRuntime(newFakeRuntimeInformerSource(), store, NewIndex())
			require.NoError(t, err)
			defer runtime.queue.ShutDown()
			old, current := base.DeepCopy(), base.DeepCopy()
			current.ResourceVersion = "2"
			tc.configure(old, current)
			runtime.eventHandler(ResourceCluster).OnUpdate(old, current)
			require.Equal(t, tc.wantQueue, runtime.queue.Len())
		})
	}
}

func TestClusterSatelliteSourceInitialProjectionStalenessReconnectAndDeletion(t *testing.T) {
	t.Parallel()
	informers := newFakeRuntimeInformerSource()
	source, err := NewClusterSatelliteSource(context.Background(), informers)
	require.NoError(t, err)
	clock := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
	source.now = func() time.Time { return clock }
	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Namespace: "clusters", Name: "east"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeAgent, Satellite: &clustersv1alpha1.SatelliteSpec{}},
		Status: clustersv1alpha1.ClusterStatus{
			Phase: clustersv1alpha1.ClusterPhaseHealthy,
			Satellite: &clustersv1alpha1.SatelliteStatus{
				LastSeen:     &metav1.Time{Time: clock},
				Applications: []clustersv1alpha1.SatelliteApplication{{Namespace: "shop", Name: "web-v2", Identity: "checkout", Health: "Healthy", ResourceCount: 3}},
			},
		},
	}
	informer := informers.informerFor(cluster)
	informer.update(nil, cluster)
	firstGeneration, snapshots := source.FleetSnapshots()
	require.Len(t, snapshots, 1)
	require.Equal(t, ConnectionStateHealthy, snapshots[0].Cluster.Connection)
	require.Equal(t, fleetID("shop", "checkout"), snapshots[0].Applications[0].Identity)
	require.Equal(t, fleetID("shop", "default"), snapshots[0].Applications[0].Project)
	require.Equal(t, SyncStateUnknown, snapshots[0].Applications[0].Sync)
	// Observation changes are coalesced into one published generation per
	// window, so a test that expects the next read to see an update advances the
	// clock past that window first.
	clock = clock.Add(minGenerationInterval)
	cluster.Status.Satellite.Applications[0].SyncKnown = true
	cluster.Spec.Mode = clustersv1alpha1.ClusterModeDirect
	informer.update(nil, cluster)
	_, snapshots = source.FleetSnapshots()
	require.Len(t, snapshots, 1)
	require.Equal(t, clustersv1alpha1.ClusterModeDirect, snapshots[0].Cluster.Mode)
	require.Equal(t, SyncStateSynced, snapshots[0].Applications[0].Sync)
	healthyGeneration, snapshots := source.FleetSnapshots()
	clock = clock.Add(20 * time.Second)
	cluster.Status.Satellite.LastSeen = &metav1.Time{Time: clock}
	informer.update(nil, cluster)
	heartbeatGeneration, heartbeatSnapshots := source.FleetSnapshots()
	require.Equal(t, healthyGeneration, heartbeatGeneration)
	require.Same(t, &snapshots[0], &heartbeatSnapshots[0])
	// The informer object can be reused or changed after delivery safely.
	cluster.Status.Satellite.Applications[0].ResourceCount = 900
	require.Equal(t, uint32(3), snapshots[0].Applications[0].ResourceCount)
	clock = clock.Add(91 * time.Second)
	staleGeneration, snapshots := source.FleetSnapshots()
	require.Greater(t, staleGeneration, firstGeneration)
	require.Equal(t, ConnectionStateUnhealthy, snapshots[0].Cluster.Connection)
	unchangedGeneration, _ := source.FleetSnapshots()
	require.Equal(t, staleGeneration, unchangedGeneration)
	clock = clock.Add(minGenerationInterval)
	cluster.Status.Satellite.LastSeen = &metav1.Time{Time: clock}
	informer.update(nil, cluster)
	freshGeneration, snapshots := source.FleetSnapshots()
	require.Greater(t, freshGeneration, staleGeneration)
	require.Equal(t, ConnectionStateHealthy, snapshots[0].Cluster.Connection)
	clock = clock.Add(minGenerationInterval)
	cluster.Spec.Disabled = true
	informer.update(nil, cluster)
	_, snapshots = source.FleetSnapshots()
	require.Equal(t, ConnectionStateDisabled, snapshots[0].Cluster.Connection)
	clock = clock.Add(minGenerationInterval)
	informer.remove(cache.DeletedFinalStateUnknown{Key: "clusters/east", Obj: cluster})
	_, snapshots = source.FleetSnapshots()
	require.Empty(t, snapshots)
}

func TestSatelliteProjectionIdentityAndSaturatingCounts(t *testing.T) {
	t.Parallel()
	for _, invalid := range []string{"", "different/namespace", "UPPERCASE", "bad name"} {
		require.Equal(t, fleetID("shop", "web"), SatelliteApplicationIdentity("shop", "web", invalid))
	}
	require.Equal(t, fleetID("shop", "checkout"), SatelliteApplicationIdentity("shop", "web", "checkout"))
	app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{
		Namespace: "shop", Name: "physical", Labels: map[string]string{SatelliteIdentityLabel: "checkout"},
	}}
	app.Status.Phase = pipelinesv1alpha1.ApplicationHealthy
	app.Status.Synced = true
	projected := ProjectSatelliteApplication(app, satelliteFixture("east").Cluster)
	require.Equal(t, fleetID("shop", "checkout"), projected.Identity)
	require.True(t, projected.SatelliteOnly)
	require.Equal(t, HealthHealthy, projected.Health)
	require.Equal(t, SyncStateSynced, projected.Sync)
	require.Equal(t, uint32(math.MaxUint32), saturatingAdd(math.MaxUint32-1, 2))
}

func TestSatelliteReaderPublishesAtomicObservationsDuringConcurrentUpdates(t *testing.T) {
	t.Parallel()
	informers := newFakeRuntimeInformerSource()
	source, err := NewClusterSatelliteSource(context.Background(), informers)
	require.NoError(t, err)
	informers.informerFor(&clustersv1alpha1.Cluster{}).setSynced()
	index := NewIndex()
	require.NoError(t, index.Install(NewSnapshot(1)))
	reader, err := NewSatelliteReader(index, source)
	require.NoError(t, err)
	var workers sync.WaitGroup
	errors := make(chan error, 4)
	workers.Add(1)
	go func() {
		defer workers.Done()
		for iteration := uint32(1); iteration <= 100; iteration++ {
			cluster := &clustersv1alpha1.Cluster{
				ObjectMeta: metav1.ObjectMeta{Namespace: "clusters", Name: "east"},
				Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeAgent, Satellite: &clustersv1alpha1.SatelliteSpec{}},
				Status: clustersv1alpha1.ClusterStatus{Phase: clustersv1alpha1.ClusterPhaseHealthy,
					Satellite: &clustersv1alpha1.SatelliteStatus{LastSeen: &metav1.Time{Time: time.Now()}, Applications: []clustersv1alpha1.SatelliteApplication{
						{Namespace: "shop", Name: "a", Health: "Healthy", ResourceCount: iteration},
						{Namespace: "shop", Name: "b", Health: "Healthy", ResourceCount: iteration},
					}},
				},
			}
			source.observe(cluster)
		}
	}()
	for worker := 0; worker < 4; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for iteration := 0; iteration < 150; iteration++ {
				snapshot, err := reader.LoadSnapshot()
				if err != nil {
					errors <- err
					return
				}
				if snapshot.Applications[fleetID("shop", "a")].ResourceCount != snapshot.Applications[fleetID("shop", "b")].ResourceCount {
					errors <- stderrors.New("one fleet generation combined different satellite observations")
					return
				}
			}
		}()
	}
	workers.Wait()
	close(errors)
	for err := range errors {
		require.NoError(t, err)
	}
}

type fixtureSatelliteSource struct {
	generation uint64
	satellites []SatelliteSnapshot
}

func (s *fixtureSatelliteSource) FleetSnapshots() (uint64, []SatelliteSnapshot) {
	return s.generation, s.satellites
}

func satelliteFixture(name string) SatelliteSnapshot {
	return SatelliteSnapshot{Cluster: ClusterSummary{
		Identity: fleetID("clusters", name), DisplayName: name,
		Connection: ConnectionStateHealthy, Mode: clustersv1alpha1.ClusterModeAgent,
	}}
}

func satelliteAppFixture(namespace, name string, health Health, resources uint32) ApplicationSummary {
	return ApplicationSummary{
		Identity: fleetID(namespace, name), Project: fleetID(namespace, "default"),
		Health: health, Sync: SyncStateSynced, ResourceCount: resources,
	}
}

// TestClusterSatelliteSourceCoalescesRapidUpdates pins the window: a fleet
// reporting continuously must not publish one generation per report.
//
// Every published generation makes the fleet reader merge the whole fleet
// (measured at 64ms for 500 clusters with distinct applications), so coalescing
// is what keeps that work bounded instead of proportional to report rate.
func TestClusterSatelliteSourceCoalescesRapidUpdates(t *testing.T) {
	t.Parallel()

	informers := newFakeRuntimeInformerSource()
	source, err := NewClusterSatelliteSource(context.Background(), informers)
	require.NoError(t, err)
	clock := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
	source.now = func() time.Time { return clock }
	cluster := &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Namespace: "clusters", Name: "east"},
		Spec:       clustersv1alpha1.ClusterSpec{Mode: clustersv1alpha1.ClusterModeAgent, Satellite: &clustersv1alpha1.SatelliteSpec{}},
		Status: clustersv1alpha1.ClusterStatus{Satellite: &clustersv1alpha1.SatelliteStatus{
			LastSeen: &metav1.Time{Time: clock},
		}},
	}
	informer := informers.informerFor(cluster)
	informer.update(nil, cluster)
	first, _ := source.FleetSnapshots()

	// Three reports inside the window: one published generation between them.
	for count := uint32(1); count <= 3; count++ {
		cluster.Status.Satellite.Applications = []clustersv1alpha1.SatelliteApplication{
			{Namespace: "shop", Name: "web", Health: "Healthy", ResourceCount: count},
		}
		informer.update(nil, cluster)
		generation, snapshots := source.FleetSnapshots()
		require.Equal(t, first, generation, "changes inside the window must not publish a new generation")
		require.Len(t, snapshots, 1)
	}

	// Once the window passes, the accumulated state is published once.
	clock = clock.Add(minGenerationInterval)
	generation, snapshots := source.FleetSnapshots()
	require.Greater(t, generation, first)
	require.Equal(t, uint32(3), snapshots[0].Applications[0].ResourceCount)

	// And the window restarts: the next read is cached again.
	cachedGeneration, _ := source.FleetSnapshots()
	require.Equal(t, generation, cachedGeneration)
}
