package fleet

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/cache"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

type clusterSatelliteObservation struct {
	snapshot SatelliteSnapshot
	lastSeen time.Time
	timeout  time.Duration
	stale    bool
}

// ClusterSatelliteSource consumes the existing Cluster informer and retains
// compact observations only. It requires registration before cache startup,
// just like Runtime.Register; initial informer deliveries populate the source.
type ClusterSatelliteSource struct {
	mu           sync.Mutex
	generation   uint64
	clusters     map[ClusterKey]clusterSatelliteObservation
	now          func() time.Time
	cacheVersion uint64
	cached       []SatelliteSnapshot
	nextExpiry   time.Time
	registration cache.ResourceEventHandlerRegistration
}

var _ SatelliteSource = (*ClusterSatelliteSource)(nil)

func NewClusterSatelliteSource(ctx context.Context, source InformerSource) (*ClusterSatelliteSource, error) {
	if source == nil {
		return nil, errors.New("satellite cluster informer is not configured")
	}
	informer, err := source.GetInformer(ctx, &clustersv1alpha1.Cluster{})
	if err != nil {
		return nil, fmt.Errorf("get satellite cluster informer: %w", err)
	}
	satellites := &ClusterSatelliteSource{
		clusters: make(map[ClusterKey]clusterSatelliteObservation), now: time.Now,
	}
	satellites.registration, err = informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    satellites.observe,
		UpdateFunc: func(_, current any) { satellites.observe(current) },
		DeleteFunc: satellites.remove,
	})
	if err != nil {
		return nil, fmt.Errorf("register satellite cluster handler: %w", err)
	}
	return satellites, nil
}

// Initial deliveries run independently for each handler on the shared informer.
// Do not serve an apparently empty satellite fleet while our handler warms up.
func (s *ClusterSatelliteSource) CheckReady() error {
	if s.registration != nil && !s.registration.HasSynced() {
		return &ErrUnavailable{Reason: "satellite cluster observations are initializing"}
	}
	return nil
}

func sameSatelliteClusterProjection(oldObject, newObject any) bool {
	oldCluster, oldOK := oldObject.(*clustersv1alpha1.Cluster)
	newCluster, newOK := newObject.(*clustersv1alpha1.Cluster)
	return oldOK && newOK && oldCluster != nil && newCluster != nil &&
		oldCluster.Spec.Satellite != nil && newCluster.Spec.Satellite != nil &&
		projectClusterSummary(oldCluster) == projectClusterSummary(newCluster)
}

func (s *ClusterSatelliteSource) observe(object any) {
	cluster, ok := object.(*clustersv1alpha1.Cluster)
	if !ok || cluster == nil {
		return
	}
	key := ClusterKey{Namespace: cluster.Namespace, Name: cluster.Name}
	if (cluster.Spec.Mode != clustersv1alpha1.ClusterModeAgent && cluster.Spec.Mode != clustersv1alpha1.ClusterModeDirect) || cluster.Spec.Satellite == nil {
		s.remove(cluster)
		return
	}
	observation := projectClusterSatelliteObservation(cluster)
	s.mu.Lock()
	defer s.mu.Unlock()
	observation.stale = satelliteObservationStale(&observation, s.now())
	if current, exists := s.clusters[key]; exists && current.stale == observation.stale && reflect.DeepEqual(current.snapshot, observation.snapshot) {
		// Heartbeats extend freshness without rebuilding the fleet. An earlier
		// cached deadline may cause one conservative rescan; a shortened timeout
		// must advance that deadline so it never delays a stale transition.
		s.clusters[key] = observation
		advanceSatelliteExpiry(&s.nextExpiry, &observation)
		return
	}
	s.clusters[key] = observation
	s.generation++
}

func projectClusterSatelliteObservation(cluster *clustersv1alpha1.Cluster) clusterSatelliteObservation {
	observation := clusterSatelliteObservation{
		snapshot: SatelliteSnapshot{Cluster: projectClusterSummary(cluster)}, timeout: clustersv1alpha1.SatelliteTimeout(cluster),
	}
	state := cluster.Status.Satellite
	if state == nil {
		return observation
	}
	if state.LastSeen != nil {
		observation.lastSeen = state.LastSeen.Time
	}
	observation.snapshot.Applications = make([]ApplicationSummary, 0, len(state.Applications))
	for i := range state.Applications {
		observation.snapshot.Applications = append(observation.snapshot.Applications, projectSatelliteStatusApplication(&state.Applications[i], observation.snapshot.Cluster))
	}
	sort.Slice(observation.snapshot.Applications, func(i, j int) bool {
		left, right := &observation.snapshot.Applications[i], &observation.snapshot.Applications[j]
		if compared := compareObjectKeys(left.Identity, right.Identity); compared != 0 {
			return compared < 0
		}
		return left.Targets[0].StableID < right.Targets[0].StableID
	})
	return observation
}

func advanceSatelliteExpiry(nextExpiry *time.Time, observation *clusterSatelliteObservation) {
	if observation.stale {
		return
	}
	expires := observation.lastSeen.Add(observation.timeout)
	if nextExpiry.IsZero() || expires.Before(*nextExpiry) {
		*nextExpiry = expires
	}
}

func (s *ClusterSatelliteSource) remove(object any) {
	key, ok := runtimeObjectKey(object)
	if !ok {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.clusters[key]; exists {
		delete(s.clusters, key)
		s.generation++
	}
}

func (s *ClusterSatelliteSource) FleetSnapshots() (uint64, []SatelliteSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if s.cacheVersion == s.generation && (s.nextExpiry.IsZero() || !now.After(s.nextExpiry)) {
		return s.generation, s.cached
	}
	result := make([]SatelliteSnapshot, 0, len(s.clusters))
	changed := false
	var nextExpiry time.Time
	for key := range s.clusters {
		observation := s.clusters[key]
		stale := satelliteObservationStale(&observation, now)
		if stale != observation.stale {
			observation.stale = stale
			s.clusters[key] = observation
			changed = true
		}
		snapshot := observation.snapshot
		if stale && snapshot.Cluster.Connection != ConnectionStateDisabled {
			snapshot.Cluster.Connection = ConnectionStateUnhealthy
		}
		advanceSatelliteExpiry(&nextExpiry, &observation)
		result = append(result, snapshot)
	}
	if changed {
		s.generation++
	}
	sort.Slice(result, func(i, j int) bool {
		return compareObjectKeys(result[i].Cluster.Identity, result[j].Cluster.Identity) < 0
	})
	s.cacheVersion = s.generation
	s.cached = result
	s.nextExpiry = nextExpiry
	return s.generation, result
}

func satelliteObservationStale(observation *clusterSatelliteObservation, now time.Time) bool {
	return observation.lastSeen.IsZero() || now.Sub(observation.lastSeen) > observation.timeout
}

func projectSatelliteStatusApplication(app *clustersv1alpha1.SatelliteApplication, cluster ClusterSummary) ApplicationSummary {
	project := app.Project
	if project == "" {
		project = defaultProjectName
	}
	health := mapApplicationHealth(pipelinesv1alpha1.HealthStatus(app.Health), pipelinesv1alpha1.ApplicationPhase(app.Phase))
	switch app.Health {
	case "Missing":
		health = HealthMissing
	case "Failed":
		health = HealthFailed
	}
	summary := ApplicationSummary{
		Identity: SatelliteApplicationIdentity(app.Namespace, app.Name, app.Identity),
		Project:  ProjectKey{Namespace: app.Namespace, Name: project}, SatelliteOnly: true,
		Health: health, Sync: mapSyncState(app.OutOfSync, app.SyncKnown), DriftCount: app.OutOfSync,
		ResourceCount: app.ResourceCount, SourceRevision: app.SourceRevision,
		CurrentCluster: cluster.Identity, CurrentClusterLabel: cluster.DisplayName,
		Targets: []StageTargetSummary{{
			StableID: satelliteTargetID(cluster.Identity, types.NamespacedName{Namespace: app.Namespace, Name: app.Name}),
			Cluster:  cluster.Identity, ClusterLabel: cluster.DisplayName, Health: health, ClusterConnection: cluster.Connection,
		}},
	}
	if app.OutOfSync > 0 {
		summary.AttentionLabel = pluralizeAttention(app.OutOfSync, "resource", "out of sync")
		summary.AttentionSeverity = attentionSeverityCounts
	}
	return summary
}
