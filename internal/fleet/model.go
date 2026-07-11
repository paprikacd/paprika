package fleet

import "k8s.io/apimachinery/pkg/types"

// ProjectKey identifies a project without coupling fleet queries to a provider
// or Kubernetes custom resource type.
type ProjectKey = types.NamespacedName

// ClusterKey identifies a cluster without coupling fleet queries to a provider
// or Kubernetes custom resource type.
type ClusterKey = types.NamespacedName

// RepositoryKey identifies a namespaced repository connection without
// retaining provider configuration or credentials in the fleet index.
type RepositoryKey = types.NamespacedName

// SourceKey identifies an optional namespaced operational data source.
type SourceKey = types.NamespacedName

// IDSet is a set of application identities.
type IDSet map[types.NamespacedName]struct{}

// Clone returns a set that can be mutated independently of s.
func (s IDSet) Clone() IDSet {
	clone := make(IDSet, len(s))
	for id := range s {
		clone[id] = struct{}{}
	}
	return clone
}

// Intersect returns a new set containing identities present in both sets.
// A nil or empty operand fails closed and produces an empty set.
func (s IDSet) Intersect(other IDSet) IDSet {
	intersection := make(IDSet)
	if len(s) == 0 || len(other) == 0 {
		return intersection
	}

	if len(s) > len(other) {
		s, other = other, s
	}
	for id := range s {
		if _, ok := other[id]; ok {
			intersection[id] = struct{}{}
		}
	}
	return intersection
}

// Health is the provider-neutral aggregate health of an application or target.
type Health uint8

const (
	HealthUnspecified Health = 0
	HealthHealthy     Health = 1
	HealthProgressing Health = 2
	HealthDegraded    Health = 3
	HealthFailed      Health = 4
	HealthUnknown     Health = 5
	HealthMissing     Health = 6
)

// SyncState is the provider-neutral desired/live state relationship.
type SyncState uint8

const (
	SyncStateUnspecified SyncState = 0
	SyncStateSynced      SyncState = 1
	SyncStateOutOfSync   SyncState = 2
	SyncStateUnknown     SyncState = 3
)

// SourceType describes how an application's desired state is supplied.
type SourceType uint8

const (
	SourceTypeUnspecified SourceType = 0
	SourceTypeGit         SourceType = 1
	SourceTypeHelm        SourceType = 2
	SourceTypeKustomize   SourceType = 3
	SourceTypeS3          SourceType = 4
	SourceTypeOCI         SourceType = 5
	SourceTypeInline      SourceType = 6
)

// ReleaseState is the provider-neutral state of the current release.
type ReleaseState uint8

const (
	ReleaseStateUnspecified      ReleaseState = 0
	ReleaseStatePending          ReleaseState = 1
	ReleaseStatePromoting        ReleaseState = 2
	ReleaseStateCanarying        ReleaseState = 3
	ReleaseStateVerifying        ReleaseState = 4
	ReleaseStateComplete         ReleaseState = 5
	ReleaseStateFailed           ReleaseState = 6
	ReleaseStateRolledBack       ReleaseState = 7
	ReleaseStateSuperseded       ReleaseState = 8
	ReleaseStateAwaitingApproval ReleaseState = 9
)

// RolloutState is the provider-neutral state of the current rollout.
type RolloutState uint8

const (
	RolloutStateUnspecified RolloutState = 0
	RolloutStatePending     RolloutState = 1
	RolloutStateProgressing RolloutState = 2
	RolloutStatePaused      RolloutState = 3
	RolloutStateHealthy     RolloutState = 4
	RolloutStateDegraded    RolloutState = 5
	RolloutStateFailed      RolloutState = 6
	RolloutStateRolledBack  RolloutState = 7
	RolloutStateAborted     RolloutState = 8
)

// ConnectionState describes provider-neutral reachability of an external
// dependency used by a fleet record.
type ConnectionState uint8

const (
	ConnectionStateUnspecified   ConnectionState = 0
	ConnectionStateHealthy       ConnectionState = 1
	ConnectionStateUnhealthy     ConnectionState = 2
	ConnectionStateDisabled      ConnectionState = 3
	ConnectionStateNotConfigured ConnectionState = 4
)

// StageTargetSummary is immutable after its containing snapshot is installed.
type StageTargetSummary struct {
	StableID               string
	Stage                  string
	Ring                   int32
	Cluster                ClusterKey
	ClusterLabel           string
	Health                 Health
	ClusterConnection      ConnectionState
	UnmanagedInlineCluster bool
}

// ApplicationSummary contains only provider-neutral data required to answer
// fleet queries. Capabilities are intentionally absent: authorization derives
// them for each request instead of persisting them in a shared snapshot.
type ApplicationSummary struct {
	Identity                     types.NamespacedName
	Project                      ProjectKey
	Targets                      []StageTargetSummary
	CurrentStage                 string
	CurrentCluster               ClusterKey
	CurrentClusterLabel          string
	SourceType                   SourceType
	SourceRevision               string
	Health                       Health
	Sync                         SyncState
	DriftCount                   uint32
	MissingResourceCount         uint32
	ReleaseState                 ReleaseState
	RolloutState                 RolloutState
	ResourceCount                uint32
	Repository                   types.NamespacedName
	RepositoryConnection         ConnectionState
	EffectiveObservabilitySource types.NamespacedName
	ObservabilityConnection      ConnectionState
	// ObservabilityBindings retains every normalized source dependency returned
	// by the optional projector. The first entry is the effective source; all
	// entries participate in reverse invalidation. It is immutable after install.
	ObservabilityBindings []types.NamespacedName
	BlockedGateCount      uint32
	LastTransitionUnixMS  int64
}

// ProjectSummary is the provider-neutral project metadata retained by a
// snapshot for grouping and display.
type ProjectSummary struct {
	Identity ProjectKey
}

// RepositorySummary is deliberately compact: provider URLs, credential
// references, messages, and raw Kubernetes objects never enter the index.
type RepositorySummary struct {
	Identity   RepositoryKey
	Connection ConnectionState
}

// ClusterSummary retains only the identity and display/connection data needed
// by fleet views. Connection configuration and Secret references are excluded.
type ClusterSummary struct {
	Identity    ClusterKey
	DisplayName string
	Connection  ConnectionState
}

// SourceSummary is the provider-neutral output of an optional source
// projector. Project enables fail-closed binding validation without importing
// a future provider CRD.
type SourceSummary struct {
	Identity   SourceKey
	Project    ProjectKey
	Connection ConnectionState
}
