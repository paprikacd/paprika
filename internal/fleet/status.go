package fleet

import (
	"sort"

	"k8s.io/apimachinery/pkg/types"
)

const defaultAttentionLimit uint32 = 20

type connectionReferenceKind uint8

const (
	connectionReferenceRepository connectionReferenceKind = iota
	connectionReferenceObservability
	connectionReferenceCluster
)

type unhealthyConnectionKey struct {
	kind     connectionReferenceKind
	identity types.NamespacedName
}

type attentionEntry struct {
	identity             types.NamespacedName
	healthSeverity       uint8
	syncSeverity         uint8
	blockedGates         uint32
	changeSeverity       uint8
	unhealthyConnections uint32
	resourceCount        uint32
	lastTransitionUnixMS int64
}

// StatusQuery is an authorized fleet-status request over one snapshot.
type StatusQuery struct {
	Filter         ApplicationFilter
	AttentionLimit uint32
}

// Status aggregates one authorized application selection and includes its
// highest-impact records that require operator attention.
type Status struct {
	Generation       uint64
	Total            uint64
	Health           map[Health]uint64
	Sync             map[SyncState]uint64
	AttentionTotal   uint64
	Attention        []ApplicationQueryResult
	HasMoreAttention bool
}

// QueryStatus aggregates only applications retained by authorization and the
// exact request filter. It performs no live reads.
func (s *Snapshot) QueryStatus(
	scope QueryScope,
	//nolint:gocritic // Fleet queries consistently accept immutable value objects.
	query StatusQuery,
) (Status, error) {
	filtered, err := s.FilterApplications(scope, query.Filter, "")
	if err != nil {
		return Status{}, err
	}

	result := Status{
		Generation: s.Generation,
		Total:      uint64(len(filtered.IDs)),
		Health:     newHealthStatusBuckets(),
		Sync:       newSyncStatusBuckets(),
	}
	attention := make([]attentionEntry, 0, len(filtered.IDs))
	for id := range filtered.IDs {
		summary := s.Applications[id]
		result.Health[statusHealthBucket(summary.Health)]++
		result.Sync[statusSyncBucket(summary.Sync)]++
		entry := newAttentionEntry(&summary)
		if needsAttention(&entry) {
			attention = append(attention, entry)
		}
	}

	sort.Slice(attention, func(left, right int) bool {
		return compareAttention(&attention[left], &attention[right]) < 0
	})
	result.AttentionTotal = uint64(len(attention))
	limit := query.AttentionLimit
	if limit == 0 {
		limit = defaultAttentionLimit
	}
	end := len(attention)
	if uint64(limit) < uint64(end) {
		end = int(limit)
	}
	result.Attention = make([]ApplicationQueryResult, 0, end)
	for _, entry := range attention[:end] {
		summary := s.Applications[entry.identity]
		result.Attention = append(result.Attention, ApplicationQueryResult{
			Summary:      cloneQueryApplicationSummary(&summary),
			Capabilities: scope.SortedCapabilities(summary.Project),
		})
	}
	result.HasMoreAttention = result.AttentionTotal > uint64(len(result.Attention))
	return result, nil
}

func newHealthStatusBuckets() map[Health]uint64 {
	return map[Health]uint64{
		HealthUnspecified: 0,
		HealthHealthy:     0,
		HealthProgressing: 0,
		HealthDegraded:    0,
		HealthFailed:      0,
		HealthUnknown:     0,
		HealthMissing:     0,
	}
}

func newSyncStatusBuckets() map[SyncState]uint64 {
	return map[SyncState]uint64{
		SyncStateUnspecified: 0,
		SyncStateSynced:      0,
		SyncStateOutOfSync:   0,
		SyncStateUnknown:     0,
	}
}

func statusHealthBucket(health Health) Health {
	if health > HealthMissing {
		return HealthUnspecified
	}
	return health
}

func statusSyncBucket(syncState SyncState) SyncState {
	if syncState > SyncStateUnknown {
		return SyncStateUnspecified
	}
	return syncState
}

func newAttentionEntry(summary *ApplicationSummary) attentionEntry {
	return attentionEntry{
		identity:             summary.Identity,
		healthSeverity:       healthSeverity(summary.Health),
		syncSeverity:         syncSeverity(summary.Sync),
		blockedGates:         summary.BlockedGateCount,
		changeSeverity:       changeSeverity(summary),
		unhealthyConnections: unhealthyConnectionCount(summary),
		resourceCount:        summary.ResourceCount,
		lastTransitionUnixMS: summary.LastTransitionUnixMS,
	}
}

func needsAttention(entry *attentionEntry) bool {
	return entry.healthSeverity >= healthSeverity(HealthUnknown) ||
		entry.syncSeverity >= syncSeverity(SyncStateUnknown) ||
		entry.blockedGates > 0 ||
		entry.changeSeverity >= 3 ||
		entry.unhealthyConnections > 0
}

func healthSeverity(health Health) uint8 {
	switch health {
	case HealthHealthy:
		return 0
	case HealthUnspecified:
		return 1
	case HealthUnknown:
		return 2
	case HealthProgressing:
		return 3
	case HealthDegraded:
		return 4
	case HealthMissing:
		return 5
	case HealthFailed:
		return 6
	default:
		return 1
	}
}

func syncSeverity(syncState SyncState) uint8 {
	switch syncState {
	case SyncStateSynced:
		return 0
	case SyncStateUnspecified:
		return 1
	case SyncStateUnknown:
		return 2
	case SyncStateOutOfSync:
		return 3
	default:
		return 1
	}
}

func changeSeverity(summary *ApplicationSummary) uint8 {
	release := releaseChangeSeverity(summary.ReleaseState)
	rollout := rolloutChangeSeverity(summary.RolloutState)
	if rollout > release {
		return rollout
	}
	return release
}

func releaseChangeSeverity(state ReleaseState) uint8 {
	switch state {
	case ReleaseStateComplete, ReleaseStateSuperseded:
		return 1
	case ReleaseStatePending,
		ReleaseStatePromoting,
		ReleaseStateCanarying,
		ReleaseStateVerifying:
		return 2
	case ReleaseStateAwaitingApproval:
		return 3
	case ReleaseStateRolledBack:
		return 4
	case ReleaseStateFailed:
		return 5
	case ReleaseStateUnspecified:
		return 0
	default:
		return 0
	}
}

func rolloutChangeSeverity(state RolloutState) uint8 {
	switch state {
	case RolloutStateHealthy:
		return 1
	case RolloutStatePending, RolloutStateProgressing:
		return 2
	case RolloutStatePaused:
		return 3
	case RolloutStateRolledBack:
		return 4
	case RolloutStateDegraded, RolloutStateFailed, RolloutStateAborted:
		return 5
	case RolloutStateUnspecified:
		return 0
	default:
		return 0
	}
}

func unhealthyConnectionCount(summary *ApplicationSummary) uint32 {
	identities := make(map[unhealthyConnectionKey]struct{}, len(summary.Targets)+2)
	if summary.RepositoryConnection == ConnectionStateUnhealthy && completeObjectKey(summary.Repository) {
		identities[unhealthyConnectionKey{
			kind: connectionReferenceRepository, identity: summary.Repository,
		}] = struct{}{}
	}
	if summary.ObservabilityConnection == ConnectionStateUnhealthy &&
		completeObjectKey(summary.EffectiveObservabilitySource) {
		identities[unhealthyConnectionKey{
			kind: connectionReferenceObservability, identity: summary.EffectiveObservabilitySource,
		}] = struct{}{}
	}
	for _, target := range summary.Targets {
		if target.ClusterConnection == ConnectionStateUnhealthy && completeObjectKey(target.Cluster) {
			identities[unhealthyConnectionKey{
				kind: connectionReferenceCluster, identity: target.Cluster,
			}] = struct{}{}
		}
	}
	return uint32(len(identities)) // #nosec G115 -- bounded by in-memory summary references.
}

func compareAttention(left, right *attentionEntry) int {
	for _, compared := range [...]int{
		compareOrdered(left.healthSeverity, right.healthSeverity),
		compareOrdered(left.syncSeverity, right.syncSeverity),
		compareOrdered(left.blockedGates, right.blockedGates),
		compareOrdered(left.changeSeverity, right.changeSeverity),
		compareOrdered(left.unhealthyConnections, right.unhealthyConnections),
		compareOrdered(left.resourceCount, right.resourceCount),
		compareOrdered(left.lastTransitionUnixMS, right.lastTransitionUnixMS),
	} {
		if compared != 0 {
			return -compared
		}
	}
	return compareObjectKeys(left.identity, right.identity)
}
