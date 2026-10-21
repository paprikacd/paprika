package fleet

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/cache"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/obsstore"
	"github.com/benebsworth/paprika/internal/satellite"
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
// minGenerationInterval bounds how often observation changes advance the
// published generation.
//
// Every report that changes a registration's observations used to bump the
// generation, and the fleet reader merges the whole fleet for each new
// generation. Measured merge cost is 3ms at 100 clusters and 64ms at 500 with
// distinct applications, so a fleet reporting continuously would rebuild its
// entire view tens of times per second. Coalescing changes into at most one
// published generation per window bounds that work while delaying what a reader
// sees by less than a quarter second — invisible in a fleet view and far
// cheaper than the alternative.
const minGenerationInterval = 250 * time.Millisecond

type ClusterSatelliteSource struct {
	mu           sync.Mutex
	generation   uint64
	clusters     map[ClusterKey]clusterSatelliteObservation
	now          func() time.Time
	cacheVersion uint64
	cached       []SatelliteSnapshot
	nextExpiry   time.Time
	// lastBump and pendingBump implement the coalescing window: changes inside
	// it are published on the first read after it, not one generation per
	// report.
	lastBump    time.Time
	pendingBump bool
	// observations, when set, supplies each registration's latest report from a
	// backing store. The store is polled on a short interval and a digest of its
	// contents drives the same generation counter the informer uses, so a stored
	// report is published exactly like a status update.
	ctx           context.Context
	observations  ObservationReader
	storePoll     time.Duration
	lastStorePoll time.Time
	storeDigest   string
	stored        []obsstore.Observation
	registration  cache.ResourceEventHandlerRegistration
}

// ObservationReader supplies reports written to a backing store.
type ObservationReader interface {
	List(ctx context.Context) ([]obsstore.Observation, error)
}

// SetObservationReader makes the source read applications from a store instead
// of Cluster.status. Identity and connection state still come from the
// registration, which the informer already tracks.
func (s *ClusterSatelliteSource) SetObservationReader(reader ObservationReader) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.observations = reader
	if s.storePoll <= 0 {
		s.storePoll = time.Second
	}
}

// bump advances the published generation, coalescing changes that land inside
// the window. Callers hold s.mu.
func (s *ClusterSatelliteSource) bump(now time.Time) {
	if s.lastBump.IsZero() || now.Sub(s.lastBump) >= minGenerationInterval {
		s.generation++
		s.lastBump = now
		s.pendingBump = false
		return
	}
	s.pendingBump = true
}

// publishPending advances the generation for a coalesced change whose window
// has passed, so the next read sees everything that accumulated. Callers hold
// s.mu.
func (s *ClusterSatelliteSource) publishPending(now time.Time) {
	if !s.pendingBump || now.Sub(s.lastBump) < minGenerationInterval {
		return
	}
	s.generation++
	s.pendingBump = false
	s.lastBump = now
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
		clusters: make(map[ClusterKey]clusterSatelliteObservation), now: time.Now, ctx: ctx,
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
	s.bump(s.now())
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
		s.bump(s.now())
	}
}

func (s *ClusterSatelliteSource) FleetSnapshots() (uint64, []SatelliteSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.publishPending(now)
	s.pollObservations(now)
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
	s.applyStoredApplications(result)
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

// pollObservations refreshes the store-backed reports and advances the
// generation when their contents changed.
//
// The interval bounds work on the query path: Redis answers a fleet-wide read in
// about a millisecond, but doing it on every query would put the store in the
// path of idle traffic.
func (s *ClusterSatelliteSource) pollObservations(now time.Time) {
	if s.observations == nil {
		return
	}
	if s.storePoll <= 0 {
		s.storePoll = time.Second
	}
	if !s.lastStorePoll.IsZero() && now.Sub(s.lastStorePoll) < s.storePoll {
		return
	}
	s.lastStorePoll = now
	storeCtx := s.ctx
	if storeCtx == nil {
		storeCtx = context.Background()
	}
	stored, err := s.observations.List(storeCtx)
	if err != nil {
		// Keep serving the previous view; a store outage must not empty the fleet.
		return
	}
	digest := observationsDigest(stored)
	if digest == s.storeDigest && s.storeDigest != "" {
		return
	}
	s.storeDigest = digest
	s.stored = stored
	s.bump(now)
}

// applyStoredApplications replaces each registration's applications with the
// ones its latest stored report carries. A registration with no stored report
// keeps what its status projection produced, so a partially populated store
// degrades to the old behaviour instead of hiding clusters.
func (s *ClusterSatelliteSource) applyStoredApplications(result []SatelliteSnapshot) {
	if s.observations == nil || len(s.stored) == 0 {
		return
	}
	byCluster := make(map[ClusterKey]*satellite.Report, len(s.stored))
	for i := range s.stored {
		byCluster[ClusterKey{Namespace: s.stored[i].Cluster.Namespace, Name: s.stored[i].Cluster.Name}] = s.stored[i].Report
	}
	for i := range result {
		report := byCluster[result[i].Cluster.Identity]
		if report == nil {
			continue
		}
		applications := make([]ApplicationSummary, 0, len(report.Applications))
		for j := range report.Applications {
			observed := report.Applications[j]
			applications = append(applications, projectSatelliteStatusApplication(&clustersv1alpha1.SatelliteApplication{
				Namespace: observed.Namespace, Name: observed.Name, Identity: observed.Identity,
				Project: observed.Project, Health: observed.Health, Phase: observed.Phase,
				OutOfSync: observed.OutOfSync, SyncKnown: observed.SyncKnown,
				ResourceCount: observed.ResourceCount, SourceRevision: observed.SourceRevision,
			}, result[i].Cluster))
		}
		result[i].Applications = applications
	}
}

// observationsDigest is a cheap change signal over the stored reports: cluster
// identity plus the sequence each report carries. Sequence is monotonic per
// session, so a new report always changes it.
func observationsDigest(stored []obsstore.Observation) string {
	parts := make([]string, 0, len(stored))
	for i := range stored {
		parts = append(parts, fmt.Sprintf("%s/%s:%d:%s", stored[i].Cluster.Namespace, stored[i].Cluster.Name, stored[i].Report.Sequence, stored[i].Report.SessionID))
	}
	sort.Strings(parts)
	return strings.Join(parts, "|")
}
