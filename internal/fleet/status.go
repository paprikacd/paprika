package fleet

import (
	"sort"

	"k8s.io/apimachinery/pkg/types"
)

const defaultAttentionLimit uint32 = 20

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
	attention := make([]*ApplicationSummary, 0, len(filtered.IDs))
	for id := range filtered.IDs {
		summary := s.Applications[id]
		result.Health[statusHealthBucket(summary.Health)]++
		result.Sync[statusSyncBucket(summary.Sync)]++
		if needsAttention(&summary) {
			attention = append(attention, &summary)
		}
	}

	sort.Slice(attention, func(left, right int) bool {
		return compareAttention(attention[left], attention[right]) < 0
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
	for _, summary := range attention[:end] {
		result.Attention = append(result.Attention, ApplicationQueryResult{
			Summary:      cloneQueryApplicationSummary(summary),
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

func needsAttention(summary *ApplicationSummary) bool {
	switch summary.Health {
	case HealthProgressing, HealthDegraded, HealthFailed, HealthUnknown, HealthMissing:
		return true
	case HealthUnspecified, HealthHealthy:
	}
	if summary.Sync == SyncStateOutOfSync || summary.Sync == SyncStateUnknown {
		return true
	}
	return summary.BlockedGateCount > 0 ||
		changeSeverity(summary) >= 3 ||
		unhealthyConnectionCount(summary) > 0
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
	identities := make(map[types.NamespacedName]struct{}, len(summary.Targets)+2)
	if summary.RepositoryConnection == ConnectionStateUnhealthy && completeObjectKey(summary.Repository) {
		identities[summary.Repository] = struct{}{}
	}
	if summary.ObservabilityConnection == ConnectionStateUnhealthy &&
		completeObjectKey(summary.EffectiveObservabilitySource) {
		identities[summary.EffectiveObservabilitySource] = struct{}{}
	}
	for _, target := range summary.Targets {
		if target.ClusterConnection == ConnectionStateUnhealthy && completeObjectKey(target.Cluster) {
			identities[target.Cluster] = struct{}{}
		}
	}
	return uint32(len(identities)) // #nosec G115 -- bounded by in-memory summary references.
}

func compareAttention(left, right *ApplicationSummary) int {
	for _, compared := range [...]int{
		compareOrdered(healthSeverity(left.Health), healthSeverity(right.Health)),
		compareOrdered(syncSeverity(left.Sync), syncSeverity(right.Sync)),
		compareOrdered(left.BlockedGateCount, right.BlockedGateCount),
		compareOrdered(changeSeverity(left), changeSeverity(right)),
		compareOrdered(unhealthyConnectionCount(left), unhealthyConnectionCount(right)),
		compareOrdered(left.ResourceCount, right.ResourceCount),
		compareOrdered(left.LastTransitionUnixMS, right.LastTransitionUnixMS),
	} {
		if compared != 0 {
			return -compared
		}
	}
	return compareObjectKeys(left.Identity, right.Identity)
}
