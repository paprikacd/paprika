package fleet

import (
	"sort"

	"k8s.io/apimachinery/pkg/types"
)

// FacetDimension identifies one self-excluding filter dimension.
type FacetDimension uint8

const (
	FacetDimensionUnspecified FacetDimension = 0
	FacetDimensionProject     FacetDimension = 1
	FacetDimensionNamespace   FacetDimension = 2
	FacetDimensionCluster     FacetDimension = 3
	FacetDimensionStage       FacetDimension = 4
	FacetDimensionHealth      FacetDimension = 5
	FacetDimensionSync        FacetDimension = 6
	FacetDimensionRelease     FacetDimension = 7
	FacetDimensionRollout     FacetDimension = 8
	FacetDimensionSourceType  FacetDimension = 9
)

// FacetBucket uses Object for namespaced project/Cluster identities and Value
// for canonical scalar values. Dimension determines which key form is valid.
type FacetBucket struct {
	Dimension FacetDimension
	Object    types.NamespacedName
	Value     string
	Label     string
	Count     uint64
}

// Facets returns positive buckets in fixed dimension/key order. Authorization
// and name search are evaluated once before any aggregate is calculated; each
// dimension then applies every active filter except its own.
func (s *Snapshot) Facets(
	scope QueryScope,
	//nolint:gocritic // Public query methods consistently accept an immutable value object.
	filter ApplicationFilter,
	search string,
) ([]FacetBucket, error) {
	searched, err := s.authorizedSearch(scope, search)
	if err != nil {
		return nil, err
	}
	filter = filter.Normalized()

	buckets := make([]FacetBucket, 0)
	buckets = append(buckets, s.projectFacetBuckets(s.facetCandidates(searched.IDs, &filter, FacetDimensionProject))...)
	buckets = append(buckets, s.namespaceFacetBuckets(s.facetCandidates(searched.IDs, &filter, FacetDimensionNamespace))...)
	buckets = append(buckets, s.clusterFacetBuckets(s.facetCandidates(searched.IDs, &filter, FacetDimensionCluster))...)
	buckets = append(buckets, s.stageFacetBuckets(s.facetCandidates(searched.IDs, &filter, FacetDimensionStage))...)
	buckets = append(buckets, s.scalarFacetBuckets(
		FacetDimensionHealth,
		s.facetCandidates(searched.IDs, &filter, FacetDimensionHealth),
		func(app ApplicationSummary) string { return canonicalHealth(app.Health) },
	)...)
	buckets = append(buckets, s.scalarFacetBuckets(
		FacetDimensionSync,
		s.facetCandidates(searched.IDs, &filter, FacetDimensionSync),
		func(app ApplicationSummary) string { return canonicalSync(app.Sync) },
	)...)
	buckets = append(buckets, s.scalarFacetBuckets(
		FacetDimensionRelease,
		s.facetCandidates(searched.IDs, &filter, FacetDimensionRelease),
		func(app ApplicationSummary) string { return canonicalRelease(app.ReleaseState) },
	)...)
	buckets = append(buckets, s.scalarFacetBuckets(
		FacetDimensionRollout,
		s.facetCandidates(searched.IDs, &filter, FacetDimensionRollout),
		func(app ApplicationSummary) string { return canonicalRollout(app.RolloutState) },
	)...)
	buckets = append(buckets, s.scalarFacetBuckets(
		FacetDimensionSourceType,
		s.facetCandidates(searched.IDs, &filter, FacetDimensionSourceType),
		func(app ApplicationSummary) string { return canonicalSourceType(app.SourceType) },
	)...)
	return buckets, nil
}

func (s *Snapshot) facetCandidates(base IDSet, filter *ApplicationFilter, own FacetDimension) IDSet {
	ids := base
	if own != FacetDimensionProject {
		ids = intersectPostings(ids, s.ByProject, filter.Projects)
	}
	if own != FacetDimensionNamespace {
		ids = intersectPostings(ids, s.ByNamespace, filter.Namespaces)
	}
	if own != FacetDimensionCluster {
		ids = intersectPostings(ids, s.ByCluster, filter.Clusters)
	}
	if own != FacetDimensionStage {
		ids = intersectPostings(ids, s.ByStage, filter.Stages)
	}
	return s.facetStateCandidates(ids, filter, own)
}

func (s *Snapshot) facetStateCandidates(base IDSet, filter *ApplicationFilter, own FacetDimension) IDSet {
	ids := base
	if own != FacetDimensionHealth {
		ids = intersectPostings(ids, s.ByHealth, filter.Health)
	}
	if own != FacetDimensionSync {
		ids = intersectPostings(ids, s.BySync, filter.Sync)
	}
	if own != FacetDimensionRelease {
		ids = intersectPostings(ids, s.ByRelease, filter.ReleaseStates)
	}
	if own != FacetDimensionRollout {
		ids = intersectPostings(ids, s.ByRollout, filter.RolloutStates)
	}
	if own != FacetDimensionSourceType {
		ids = intersectPostings(ids, s.BySourceType, filter.SourceTypes)
	}
	return ids
}

func (s *Snapshot) projectFacetBuckets(ids IDSet) []FacetBucket {
	counts := make(map[types.NamespacedName]uint64)
	for id := range ids {
		project := s.Applications[id].Project
		if project != (ProjectKey{}) {
			counts[project]++
		}
	}
	return objectFacetBuckets(FacetDimensionProject, counts, func(key types.NamespacedName) string {
		return key.Name
	})
}

func (s *Snapshot) namespaceFacetBuckets(ids IDSet) []FacetBucket {
	counts := make(map[string]uint64)
	for id := range ids {
		if id.Namespace != "" {
			counts[id.Namespace]++
		}
	}
	return scalarBuckets(FacetDimensionNamespace, counts)
}

func (s *Snapshot) clusterFacetBuckets(ids IDSet) []FacetBucket {
	counts := make(map[types.NamespacedName]uint64)
	for id := range ids {
		seen := make(map[ClusterKey]struct{})
		for _, target := range s.Applications[id].Targets {
			if target.Cluster != (ClusterKey{}) {
				seen[target.Cluster] = struct{}{}
			}
		}
		for cluster := range seen {
			counts[cluster]++
		}
	}
	return objectFacetBuckets(FacetDimensionCluster, counts, s.clusterLabel)
}

func (s *Snapshot) clusterLabel(key types.NamespacedName) string {
	if label := s.Clusters[key].DisplayName; label != "" {
		return label
	}
	return key.Name
}

func (s *Snapshot) stageFacetBuckets(ids IDSet) []FacetBucket {
	counts := make(map[string]uint64)
	for id := range ids {
		seen := make(map[string]struct{})
		for _, target := range s.Applications[id].Targets {
			if target.Stage != "" {
				seen[target.Stage] = struct{}{}
			}
		}
		for stage := range seen {
			counts[stage]++
		}
	}
	return scalarBuckets(FacetDimensionStage, counts)
}

func (s *Snapshot) scalarFacetBuckets(
	dimension FacetDimension,
	ids IDSet,
	value func(ApplicationSummary) string,
) []FacetBucket {
	counts := make(map[string]uint64)
	for id := range ids {
		if canonical := value(s.Applications[id]); canonical != "" {
			counts[canonical]++
		}
	}
	return scalarBuckets(dimension, counts)
}

func objectFacetBuckets(
	dimension FacetDimension,
	counts map[types.NamespacedName]uint64,
	label func(types.NamespacedName) string,
) []FacetBucket {
	keys := make([]types.NamespacedName, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	keys = sortedUniqueObjectKeys(keys)
	buckets := make([]FacetBucket, 0, len(keys))
	for _, key := range keys {
		buckets = append(buckets, FacetBucket{
			Dimension: dimension,
			Object:    key,
			Label:     label(key),
			Count:     counts[key],
		})
	}
	return buckets
}

func scalarBuckets(dimension FacetDimension, counts map[string]uint64) []FacetBucket {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	buckets := make([]FacetBucket, 0, len(keys))
	for _, key := range keys {
		buckets = append(buckets, FacetBucket{
			Dimension: dimension,
			Value:     key,
			Label:     key,
			Count:     counts[key],
		})
	}
	return buckets
}

func canonicalHealth(value Health) string {
	switch value {
	case HealthHealthy:
		return "healthy"
	case HealthProgressing:
		return "progressing"
	case HealthDegraded:
		return "degraded"
	case HealthFailed:
		return "failed"
	case HealthUnknown:
		return "unknown"
	case HealthMissing:
		return "missing"
	case HealthUnspecified:
		return ""
	default:
		return ""
	}
}

func canonicalSync(value SyncState) string {
	switch value {
	case SyncStateSynced:
		return "synced"
	case SyncStateOutOfSync:
		return "out_of_sync"
	case SyncStateUnknown:
		return "unknown"
	case SyncStateUnspecified:
		return ""
	default:
		return ""
	}
}

var canonicalReleaseValues = [...]string{
	ReleaseStateUnspecified:      "",
	ReleaseStatePending:          "pending",
	ReleaseStatePromoting:        "promoting",
	ReleaseStateCanarying:        "canarying",
	ReleaseStateVerifying:        "verifying",
	ReleaseStateComplete:         "complete",
	ReleaseStateFailed:           "failed",
	ReleaseStateRolledBack:       "rolled_back",
	ReleaseStateSuperseded:       "superseded",
	ReleaseStateAwaitingApproval: "awaiting_approval",
}

func canonicalRelease(value ReleaseState) string {
	if int(value) >= len(canonicalReleaseValues) {
		return ""
	}
	return canonicalReleaseValues[value]
}

var canonicalRolloutValues = [...]string{
	RolloutStateUnspecified: "",
	RolloutStatePending:     "pending",
	RolloutStateProgressing: "progressing",
	RolloutStatePaused:      "paused",
	RolloutStateHealthy:     "healthy",
	RolloutStateDegraded:    "degraded",
	RolloutStateFailed:      "failed",
	RolloutStateRolledBack:  "rolled_back",
	RolloutStateAborted:     "aborted",
}

func canonicalRollout(value RolloutState) string {
	if int(value) >= len(canonicalRolloutValues) {
		return ""
	}
	return canonicalRolloutValues[value]
}

func canonicalSourceType(value SourceType) string {
	switch value {
	case SourceTypeGit:
		return "git"
	case SourceTypeHelm:
		return "helm"
	case SourceTypeKustomize:
		return "kustomize"
	case SourceTypeS3:
		return "s3"
	case SourceTypeOCI:
		return "oci"
	case SourceTypeInline:
		return "inline"
	case SourceTypeUnspecified:
		return ""
	default:
		return ""
	}
}
