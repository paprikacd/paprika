package fleet

import (
	"errors"
	"sync/atomic"

	"k8s.io/apimachinery/pkg/types"
)

// Snapshot is an immutable-by-contract view of the fleet. Callers build a
// mutable value with NewSnapshot; Index.Install publishes a deep clone.
type Snapshot struct {
	Generation   uint64
	Applications map[types.NamespacedName]ApplicationSummary
	Projects     map[ProjectKey]ProjectSummary
	ByProject    map[ProjectKey]IDSet
	ByNamespace  map[string]IDSet
	ByCluster    map[ClusterKey]IDSet
	ByStage      map[string]IDSet
	ByHealth     map[Health]IDSet
	BySync       map[SyncState]IDSet
	ByRelease    map[ReleaseState]IDSet
	ByRollout    map[RolloutState]IDSet
	BySourceType map[SourceType]IDSet
	Trigrams     map[string]IDSet

	searchDocuments map[types.NamespacedName]searchDocument
}

// Index atomically publishes immutable snapshots and independent readiness
// health. Readers always observe one complete snapshot pointer.
type Index struct {
	snapshot atomic.Pointer[Snapshot]
	health   atomic.Pointer[HealthState]
}

// NewSnapshot returns an empty mutable snapshot builder with all maps ready
// for population.
func NewSnapshot(generation uint64) *Snapshot {
	return &Snapshot{
		Generation:      generation,
		Applications:    make(map[types.NamespacedName]ApplicationSummary),
		Projects:        make(map[ProjectKey]ProjectSummary),
		ByProject:       make(map[ProjectKey]IDSet),
		ByNamespace:     make(map[string]IDSet),
		ByCluster:       make(map[ClusterKey]IDSet),
		ByStage:         make(map[string]IDSet),
		ByHealth:        make(map[Health]IDSet),
		BySync:          make(map[SyncState]IDSet),
		ByRelease:       make(map[ReleaseState]IDSet),
		ByRollout:       make(map[RolloutState]IDSet),
		BySourceType:    make(map[SourceType]IDSet),
		Trigrams:        make(map[string]IDSet),
		searchDocuments: make(map[types.NamespacedName]searchDocument),
	}
}

// NewIndex returns an index with no serving snapshot and unavailable health.
func NewIndex() *Index {
	index := &Index{}
	index.health.Store(&HealthState{Reason: initialUnavailableReason})
	return index
}

// Install deep-clones builder, prepares its private search cache, and publishes
// the clone atomically. A successful install publishes the snapshot before it
// marks health ready, so readiness never advertises an absent snapshot.
func (i *Index) Install(builder *Snapshot) error {
	if builder == nil {
		return errors.New("fleet snapshot builder must not be nil")
	}

	snapshot := cloneSnapshot(builder)
	snapshot.rebuildSearchIndex()
	i.snapshot.Store(snapshot)
	i.health.Store(&HealthState{Ready: true})
	return nil
}

// LoadSnapshot returns the currently serving snapshot regardless of degraded
// health. The pointer is loaded exactly once and is immutable by contract.
func (i *Index) LoadSnapshot() (*Snapshot, error) {
	snapshot := i.snapshot.Load()
	if snapshot == nil {
		return nil, &ErrUnavailable{Reason: initialUnavailableReason}
	}
	return snapshot, nil
}

func cloneSnapshot(source *Snapshot) *Snapshot {
	clone := &Snapshot{
		Generation:      source.Generation,
		Applications:    cloneApplications(source.Applications),
		Projects:        cloneMap(source.Projects),
		ByProject:       cloneIDSetIndex(source.ByProject),
		ByNamespace:     cloneIDSetIndex(source.ByNamespace),
		ByCluster:       cloneIDSetIndex(source.ByCluster),
		ByStage:         cloneIDSetIndex(source.ByStage),
		ByHealth:        cloneIDSetIndex(source.ByHealth),
		BySync:          cloneIDSetIndex(source.BySync),
		ByRelease:       cloneIDSetIndex(source.ByRelease),
		ByRollout:       cloneIDSetIndex(source.ByRollout),
		BySourceType:    cloneIDSetIndex(source.BySourceType),
		Trigrams:        make(map[string]IDSet),
		searchDocuments: make(map[types.NamespacedName]searchDocument),
	}
	return clone
}

func cloneApplications(
	source map[types.NamespacedName]ApplicationSummary,
) map[types.NamespacedName]ApplicationSummary {
	if source == nil {
		return nil
	}

	clone := make(map[types.NamespacedName]ApplicationSummary, len(source))
	for id := range source {
		application := source[id]
		if application.Targets != nil {
			application.Targets = append([]StageTargetSummary(nil), application.Targets...)
		}
		clone[id] = application
	}
	return clone
}

func cloneMap[K comparable, V any](source map[K]V) map[K]V {
	if source == nil {
		return nil
	}

	clone := make(map[K]V, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func cloneIDSetIndex[K comparable](source map[K]IDSet) map[K]IDSet {
	if source == nil {
		return nil
	}

	clone := make(map[K]IDSet, len(source))
	for key, set := range source {
		clone[key] = set.Clone()
	}
	return clone
}
