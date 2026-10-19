package fleet

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"

	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// SatelliteIdentityLabel selects a logical application name within its
// namespace. Namespaces always remain part of the identity and authorization
// boundary, even when multiple clusters declare the same label.
const SatelliteIdentityLabel = "app.paprika.io/identity"

// SatelliteSnapshot contains only compact observations from one registered
// cluster. Cluster identity and connection state come from the control plane,
// rather than trusting a satellite to choose its own placement.
type SatelliteSnapshot struct {
	Cluster      ClusterSummary
	Applications []ApplicationSummary
}

// SatelliteSource is an in-memory source of immutable cluster observations.
// Generation changes whenever observations or their connection state change.
// Implementations must not perform Kubernetes or remote reads.
type SatelliteSource interface {
	FleetSnapshots() (generation uint64, snapshots []SatelliteSnapshot)
}

// SatelliteReader combines the local projection with satellite observations.
// It rebuilds only when either source changes and publishes one complete view
// for every query, preserving the local runtime's readiness contract.
type SatelliteReader struct {
	local   Reader
	source  SatelliteSource
	queries *Index

	mu                  sync.Mutex
	localSnapshot       *Snapshot
	satelliteGeneration uint64
	generation          uint64
	combined            *Snapshot
}

var _ Reader = (*SatelliteReader)(nil)

func NewSatelliteReader(local Reader, source SatelliteSource) (*SatelliteReader, error) {
	if local == nil || source == nil {
		return nil, errors.New("satellite fleet reader is not configured")
	}
	return &SatelliteReader{local: local, source: source, queries: NewIndex()}, nil
}

func (r *SatelliteReader) CheckReady() error {
	if err := r.local.CheckReady(); err != nil {
		return fmt.Errorf("local fleet readiness: %w", err)
	}
	if source, ok := r.source.(interface{ CheckReady() error }); ok {
		if err := source.CheckReady(); err != nil {
			return fmt.Errorf("satellite fleet readiness: %w", err)
		}
	}
	return nil
}

func (r *SatelliteReader) LoadSnapshot() (*Snapshot, error) {
	if source, ok := r.source.(interface{ CheckReady() error }); ok {
		if err := source.CheckReady(); err != nil {
			return nil, fmt.Errorf("satellite fleet readiness: %w", err)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	local, err := r.local.LoadSnapshot()
	if err != nil {
		return nil, fmt.Errorf("load local fleet snapshot: %w", err)
	}
	version, satellites := r.source.FleetSnapshots()
	r.queries.health.Store(&HealthState{Degraded: r.local.CheckReady() != nil})
	if r.combined != nil && r.localSnapshot == local && r.satelliteGeneration == version {
		return r.combined, nil
	}
	generation := r.generation + 1
	if generation < local.Generation {
		generation = local.Generation
	}
	combined, err := MergeSatelliteSnapshots(local, satellites, generation)
	if err != nil {
		return nil, err
	}
	r.localSnapshot = local
	r.satelliteGeneration = version
	r.generation = generation
	r.combined = combined
	r.queries.snapshot.Store(combined)
	return combined, nil
}

func (r *SatelliteReader) ProjectKeys(ctx context.Context, namespaces []string) ([]ProjectKey, error) {
	if _, err := r.LoadSnapshot(); err != nil {
		return nil, err
	}
	return r.queries.ProjectKeys(ctx, namespaces)
}

//nolint:gocritic // Reader accepts immutable query values.
func (r *SatelliteReader) QueryApplications(ctx context.Context, scope QueryScope, query ApplicationQuery, cursor string) (ApplicationPage, error) {
	if _, err := r.LoadSnapshot(); err != nil {
		return ApplicationPage{}, err
	}
	return r.queries.QueryApplications(ctx, scope, query, cursor)
}

//nolint:gocritic // Reader accepts immutable query values.
func (r *SatelliteReader) QueryMap(ctx context.Context, scope QueryScope, query FleetMapQuery) (FleetMap, error) {
	if _, err := r.LoadSnapshot(); err != nil {
		return FleetMap{}, err
	}
	return r.queries.QueryMap(ctx, scope, query)
}

//nolint:gocritic // Reader accepts immutable query values.
func (r *SatelliteReader) QueryMatrix(ctx context.Context, scope QueryScope, query FleetMatrixQuery) (FleetMatrix, error) {
	if _, err := r.LoadSnapshot(); err != nil {
		return FleetMatrix{}, err
	}
	return r.queries.QueryMatrix(ctx, scope, query)
}

// SatelliteApplicationIdentity returns a namespace-scoped logical identity.
// Invalid explicit names fall back to the original object name.
func SatelliteApplicationIdentity(namespace, name, explicit string) types.NamespacedName {
	explicit = strings.TrimSpace(explicit)
	if explicit != "" && len(validation.IsDNS1123Subdomain(explicit)) == 0 {
		name = explicit
	}
	return types.NamespacedName{Namespace: namespace, Name: name}
}

// ProjectSatelliteApplication projects an observed Application without
// importing its desired configuration, credentials, or child resources into
// the central index.
func ProjectSatelliteApplication(app *pipelinesv1alpha1.Application, cluster ClusterSummary) ApplicationSummary {
	if app == nil {
		return ApplicationSummary{}
	}
	summary, _ := projectApplication(&projectionInput{application: app})
	summary.Identity = SatelliteApplicationIdentity(app.Namespace, app.Name, app.Labels[SatelliteIdentityLabel])
	summary.SatelliteOnly = true
	summary.CurrentCluster = cluster.Identity
	summary.CurrentClusterLabel = cluster.DisplayName
	summary.Targets = []StageTargetSummary{{
		StableID: satelliteTargetID(cluster.Identity, types.NamespacedName{Namespace: app.Namespace, Name: app.Name}),
		Stage:    app.Status.CurrentStage, Cluster: cluster.Identity,
		ClusterLabel: cluster.DisplayName, ClusterConnection: cluster.Connection, Health: summary.Health,
	}}
	return summary
}

// MergeSatelliteSnapshots builds a defensively owned, searchable snapshot.
// A placement joins an existing logical application only when its project
// agrees, so a satellite cannot reveal another project's record through a
// same-name association. The local control record retains release metadata.
func MergeSatelliteSnapshots(local *Snapshot, satellites []SatelliteSnapshot, generation uint64) (*Snapshot, error) {
	if local == nil {
		return nil, errors.New("local fleet snapshot must not be nil")
	}
	result := NewSnapshot(generation)
	result.Projects = cloneMap(local.Projects)
	result.Repositories = cloneMap(local.Repositories)
	result.Clusters = cloneMap(local.Clusters)
	result.Sources = cloneMap(local.Sources)
	groups := cloneApplications(local.Applications)
	aliases, ambiguousAliases := localSatelliteAliases(local.Applications)
	ordered := append([]SatelliteSnapshot(nil), satellites...)
	sort.Slice(ordered, func(i, j int) bool {
		return compareObjectKeys(ordered[i].Cluster.Identity, ordered[j].Cluster.Identity) < 0
	})
	replacedLocal := make(IDSet)
	seenClusters := make(map[ClusterKey]struct{})
	for i := range ordered {
		satellite := &ordered[i]
		cluster := satellite.Cluster
		if !completeObjectKey(cluster.Identity) {
			continue
		}
		if _, duplicate := seenClusters[cluster.Identity]; duplicate {
			continue
		}
		seenClusters[cluster.Identity] = struct{}{}
		result.Clusters[cluster.Identity] = cluster
		observations := coalesceSatelliteObservations(satellite, aliases, ambiguousAliases)
		for j := range observations {
			mergeSatellitePlacement(groups, local, replacedLocal, &observations[j], cluster.Identity)
		}
	}
	for _, id := range sortedIDs(applicationIDs(groups)) {
		app := groups[id]
		addApplicationMutable(result, &app)
	}
	if err := validateSnapshot(result); err != nil {
		return nil, err
	}
	result.rebuildSearchIndex()
	return result, nil
}

func mergeSatellitePlacement(groups map[types.NamespacedName]ApplicationSummary, local *Snapshot, replacedLocal IDSet, observed *ApplicationSummary, cluster ClusterKey) {
	current, exists := groups[observed.Identity]
	if exists && current.Project != observed.Project {
		return
	}
	if !exists {
		groups[observed.Identity] = *observed
		return
	}
	base, isLocal := local.Applications[observed.Identity]
	_, replaced := replacedLocal[observed.Identity]
	if isLocal && !replaced && base.CurrentCluster == cluster {
		replacedLocal[observed.Identity] = struct{}{}
		current.ResourceCount -= base.ResourceCount
		current.DriftCount -= base.DriftCount
		current.MissingResourceCount -= base.MissingResourceCount
		current.BlockedGateCount -= base.BlockedGateCount
	}
	mergeSatelliteApplication(&current, observed)
	groups[observed.Identity] = current
}

func coalesceSatelliteObservations(satellite *SatelliteSnapshot, aliases map[types.NamespacedName]types.NamespacedName, ambiguous IDSet) []ApplicationSummary {
	groups := make(map[types.NamespacedName]ApplicationSummary)
	seenInstances := make(map[string]struct{})
	for i := range satellite.Applications {
		observed := satellite.Applications[i]
		if !completeObjectKey(observed.Identity) || !completeObjectKey(observed.Project) {
			continue
		}
		if _, conflict := ambiguous[observed.Identity]; conflict {
			continue
		}
		normalizeSatelliteObservation(&observed, satellite.Cluster)
		instance := observed.Targets[0].StableID
		if _, duplicate := seenInstances[instance]; duplicate {
			continue
		}
		seenInstances[instance] = struct{}{}
		if canonical, exists := aliases[observed.Identity]; exists {
			observed.Identity = canonical
		}
		if previous, exists := groups[observed.Identity]; exists {
			if previous.Project == observed.Project {
				mergeSatelliteApplication(&previous, &observed)
				groups[observed.Identity] = previous
			}
		} else {
			groups[observed.Identity] = observed
		}
	}
	result := make([]ApplicationSummary, 0, len(groups))
	for _, id := range sortedIDs(applicationIDs(groups)) {
		result = append(result, groups[id])
	}
	return result
}

func localSatelliteAliases(applications map[types.NamespacedName]ApplicationSummary) (map[types.NamespacedName]types.NamespacedName, IDSet) {
	aliases := make(map[types.NamespacedName]types.NamespacedName)
	ambiguous := make(IDSet)
	for id := range applications {
		app := applications[id]
		logical := SatelliteApplicationIdentity(id.Namespace, id.Name, app.LogicalIdentityName)
		if previous, exists := aliases[logical]; exists && previous != id {
			ambiguous[logical] = struct{}{}
		}
		aliases[logical] = id
	}
	return aliases, ambiguous
}

func applicationIDs(applications map[types.NamespacedName]ApplicationSummary) IDSet {
	ids := make(IDSet, len(applications))
	for id := range applications {
		ids[id] = struct{}{}
	}
	return ids
}

func normalizeSatelliteObservation(app *ApplicationSummary, cluster ClusterSummary) {
	app.SatelliteOnly = true
	app.CurrentCluster = cluster.Identity
	app.CurrentClusterLabel = cluster.DisplayName
	app.Repository = RepositoryKey{}
	app.RepositoryConnection = ConnectionStateNotConfigured
	app.EffectiveObservabilitySource = SourceKey{}
	app.ObservabilityBindings = nil
	app.ObservabilityConnection = ConnectionStateNotConfigured
	if cluster.Connection != ConnectionStateHealthy {
		app.Health = HealthUnknown
		app.Sync = SyncStateUnknown
		app.AttentionLabel = "satellite unavailable"
		app.AttentionDetail = "Cluster observations are stale until the satellite reconnects."
		app.AttentionResource = ""
		app.AttentionSeverity = attentionSeverityResource
	}
	app.Targets = append([]StageTargetSummary(nil), app.Targets...)
	if len(app.Targets) == 0 {
		app.Targets = []StageTargetSummary{{StableID: satelliteTargetID(cluster.Identity, app.Identity), Stage: app.CurrentStage}}
	}
	for i := range app.Targets {
		target := &app.Targets[i]
		target.Cluster = cluster.Identity
		target.ClusterLabel = cluster.DisplayName
		target.ClusterConnection = cluster.Connection
		target.UnmanagedInlineCluster = false
		if target.StableID == "" {
			target.StableID = satelliteTargetID(cluster.Identity, app.Identity) + ":" + canonicalComponent(target.Stage)
		}
		target.Health = app.Health
	}
}

func mergeSatelliteApplication(current, observed *ApplicationSummary) {
	current.ResourceCount = saturatingAdd(current.ResourceCount, observed.ResourceCount)
	current.DriftCount = saturatingAdd(current.DriftCount, observed.DriftCount)
	current.MissingResourceCount = saturatingAdd(current.MissingResourceCount, observed.MissingResourceCount)
	current.BlockedGateCount = saturatingAdd(current.BlockedGateCount, observed.BlockedGateCount)
	if unhealthySeverity(observed.Health) > unhealthySeverity(current.Health) {
		current.Health = observed.Health
	}
	if satelliteSyncSeverity(observed.Sync) > satelliteSyncSeverity(current.Sync) {
		current.Sync = observed.Sync
	}
	if observed.LastTransitionUnixMS > current.LastTransitionUnixMS {
		current.LastTransitionUnixMS = observed.LastTransitionUnixMS
	}
	if observed.AttentionSeverity > current.AttentionSeverity {
		current.AttentionLabel = observed.AttentionLabel
		current.AttentionDetail = observed.AttentionDetail
		current.AttentionResource = observed.AttentionResource
		current.AttentionSeverity = observed.AttentionSeverity
	}
	mergeSatelliteTargets(current, observed.Targets)
}

func mergeSatelliteTargets(current *ApplicationSummary, targets []StageTargetSummary) {
	for _, target := range targets {
		replaced := false
		for i := range current.Targets {
			if current.Targets[i].Cluster == target.Cluster && (target.Stage == "" || current.Targets[i].Stage == target.Stage) {
				if !current.SatelliteOnly || unhealthySeverity(target.Health) > unhealthySeverity(current.Targets[i].Health) {
					current.Targets[i].Health = target.Health
				}
				current.Targets[i].ClusterLabel = target.ClusterLabel
				current.Targets[i].ClusterConnection = target.ClusterConnection
				replaced = true
			}
		}
		if !replaced {
			current.Targets = append(current.Targets, target)
		}
	}
	sortStageTargets(current.Targets)
}

func satelliteSyncSeverity(state SyncState) uint8 {
	switch state {
	case SyncStateOutOfSync:
		return 3
	case SyncStateUnknown:
		return 2
	case SyncStateUnspecified:
		return 1
	case SyncStateSynced:
		return 0
	default:
		return 0
	}
}

func saturatingAdd(left, right uint32) uint32 {
	if math.MaxUint32-left < right {
		return math.MaxUint32
	}
	return left + right
}

func satelliteTargetID(cluster ClusterKey, app types.NamespacedName) string {
	return "satellite:" + canonicalObjectIdentity(cluster) + ":" + canonicalObjectIdentity(app)
}
