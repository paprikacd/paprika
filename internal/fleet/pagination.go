package fleet

import (
	"sort"
	"strings"

	"k8s.io/apimachinery/pkg/types"
)

// ApplicationQueryResult is one authorized fleet record plus the caller's
// project-scoped capabilities. Capabilities are never read from the shared
// snapshot and therefore cannot become a visibility signal.
type ApplicationQueryResult struct {
	Summary      ApplicationSummary
	Capabilities []Capability
}

// ApplicationPage is a live, replica-safe page over one immutable snapshot.
// Total and facets describe the complete current authorized query, not only the
// records remaining after the cursor boundary.
type ApplicationPage struct {
	Applications []ApplicationQueryResult
	Total        uint64
	NextCursor   string
	Generation   uint64
	Facets       []FacetBucket
}

type applicationPageEntry struct {
	summary  ApplicationSummary
	boundary PageBoundary
}

// QueryApplications authorizes and filters before sorting or seeking. Cursors
// contain only deterministic tuples, so another replica or a later generation
// can resume by seeking to the first tuple strictly after the saved boundary.
func (s *Snapshot) QueryApplications(
	scope QueryScope,
	//nolint:gocritic // The query is an immutable request value.
	query ApplicationQuery,
	cursor string,
) (ApplicationPage, error) {
	normalized, err := query.Normalized()
	if err != nil {
		return ApplicationPage{}, err
	}

	filtered, err := s.FilterApplications(scope, normalized.Filter, normalized.Search)
	if err != nil {
		return ApplicationPage{}, err
	}
	facets, err := s.Facets(scope, normalized.Filter, normalized.Search)
	if err != nil {
		return ApplicationPage{}, err
	}

	entries := make([]applicationPageEntry, 0, len(filtered.IDs))
	for id := range filtered.IDs {
		summary := s.Applications[id]
		entries = append(entries, applicationPageEntry{
			summary: summary,
			boundary: PageBoundary{
				Key:      applicationPageKey(&summary, filtered.Matches[id]),
				Identity: id,
			},
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		return comparePageBoundaries(&entries[i].boundary, &entries[j].boundary, &normalized) < 0
	})

	start, err := seekApplicationPage(entries, &normalized, cursor)
	if err != nil {
		return ApplicationPage{}, err
	}

	end := start + int(normalized.PageSize)
	if end > len(entries) {
		end = len(entries)
	}
	page := ApplicationPage{
		Applications: make([]ApplicationQueryResult, 0, end-start),
		Total:        uint64(len(entries)),
		Generation:   s.Generation,
		Facets:       facets,
	}
	for index := start; index < end; index++ {
		page.Applications = append(page.Applications, ApplicationQueryResult{
			Summary:      cloneQueryApplicationSummary(&entries[index].summary),
			Capabilities: scope.SortedCapabilities(entries[index].summary.Project),
		})
	}

	if end < len(entries) {
		page.NextCursor, err = EncodePageCursor(normalized, entries[end-1].boundary)
		if err != nil {
			return ApplicationPage{}, err
		}
	}
	return page, nil
}

func seekApplicationPage(entries []applicationPageEntry, query *ApplicationQuery, cursor string) (int, error) {
	if cursor == "" {
		return 0, nil
	}
	boundary, err := DecodePageCursor(*query, cursor)
	if err != nil {
		return 0, err
	}
	return sort.Search(len(entries), func(index int) bool {
		return comparePageBoundaries(&entries[index].boundary, &boundary, query) > 0
	}), nil
}

func cloneQueryApplicationSummary(source *ApplicationSummary) ApplicationSummary {
	clone := *source
	clone.Targets = append([]StageTargetSummary(nil), source.Targets...)
	clone.ObservabilityBindings = append([]types.NamespacedName(nil), source.ObservabilityBindings...)
	return clone
}

func applicationPageKey(summary *ApplicationSummary, match SearchMatch) PageKey {
	return PageKey{
		Relevance: RelevanceKey{
			Tier:   match.Tier,
			Shared: uint32(match.SharedTrigrams), // #nosec G115 -- search input bounds each count to 128 runes.
			Union:  uint32(match.UnionTrigrams),  // #nosec G115 -- search input bounds each count to 128 runes.
		},
		Name:                 summary.Identity.Name,
		Project:              summary.Project,
		Cluster:              minimumTargetCluster(summary.Targets),
		Stage:                minimumTargetStage(summary.Targets),
		Health:               summary.Health,
		Sync:                 summary.Sync,
		Release:              summary.ReleaseState,
		Rollout:              summary.RolloutState,
		ResourceCount:        summary.ResourceCount,
		LastTransitionUnixMS: summary.LastTransitionUnixMS,
		Impact: ImpactKey{
			UnhealthySeverity:    unhealthySeverity(summary.Health),
			BlockedGates:         summary.BlockedGateCount,
			ActiveChange:         hasActiveChange(summary),
			ResourceCount:        summary.ResourceCount,
			LastTransitionUnixMS: summary.LastTransitionUnixMS,
		},
	}
}

func minimumTargetCluster(targets []StageTargetSummary) ClusterKey {
	if len(targets) == 0 {
		return ClusterKey{}
	}
	minimum := targets[0].Cluster
	for index := 1; index < len(targets); index++ {
		if compareObjectKeys(targets[index].Cluster, minimum) < 0 {
			minimum = targets[index].Cluster
		}
	}
	return minimum
}

func minimumTargetStage(targets []StageTargetSummary) string {
	minimum := ""
	for index := range targets {
		stage := targets[index].Stage
		if stage != "" && (minimum == "" || stage < minimum) {
			minimum = stage
		}
	}
	return minimum
}

func unhealthySeverity(health Health) uint8 {
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

func hasActiveChange(summary *ApplicationSummary) bool {
	return activeRelease(summary.ReleaseState) || activeRollout(summary.RolloutState)
}

func activeRelease(state ReleaseState) bool {
	switch state {
	case ReleaseStatePending,
		ReleaseStatePromoting,
		ReleaseStateCanarying,
		ReleaseStateVerifying,
		ReleaseStateAwaitingApproval:
		return true
	case ReleaseStateUnspecified,
		ReleaseStateComplete,
		ReleaseStateFailed,
		ReleaseStateRolledBack,
		ReleaseStateSuperseded:
		return false
	default:
		return false
	}
}

func activeRollout(state RolloutState) bool {
	switch state {
	case RolloutStatePending,
		RolloutStateProgressing,
		RolloutStatePaused:
		return true
	case RolloutStateUnspecified,
		RolloutStateHealthy,
		RolloutStateDegraded,
		RolloutStateFailed,
		RolloutStateRolledBack,
		RolloutStateAborted:
		return false
	default:
		return false
	}
}

func comparePageBoundaries(left, right *PageBoundary, query *ApplicationQuery) int {
	if strings.TrimSpace(query.Search) != "" {
		if compared := compareRelevance(left.Key.Relevance, right.Key.Relevance); compared != 0 {
			return compared
		}
	}

	compared := compareSelectedPageKey(&left.Key, &right.Key, query.Sort)
	if query.Sort != SortFieldRelevance && query.Direction == SortDirectionDesc {
		compared = -compared
	}
	if compared != 0 {
		return compared
	}
	return compareObjectKeys(left.Identity, right.Identity)
}

//nolint:cyclop // Each supported sort field has one direct, exhaustive tuple mapping.
func compareSelectedPageKey(left, right *PageKey, field SortField) int {
	switch field {
	case SortFieldName:
		return strings.Compare(left.Name, right.Name)
	case SortFieldProject:
		return compareObjectKeys(left.Project, right.Project)
	case SortFieldCluster:
		return compareObjectKeys(left.Cluster, right.Cluster)
	case SortFieldStage:
		return strings.Compare(left.Stage, right.Stage)
	case SortFieldHealth:
		return compareOrdered(left.Health, right.Health)
	case SortFieldSync:
		return compareOrdered(left.Sync, right.Sync)
	case SortFieldRelease:
		return compareOrdered(left.Release, right.Release)
	case SortFieldRollout:
		return compareOrdered(left.Rollout, right.Rollout)
	case SortFieldResourceCount:
		return compareOrdered(left.ResourceCount, right.ResourceCount)
	case SortFieldLastTransition:
		return compareOrdered(left.LastTransitionUnixMS, right.LastTransitionUnixMS)
	case SortFieldImpact:
		return compareImpact(left.Impact, right.Impact)
	case SortFieldRelevance:
		return compareRelevance(left.Relevance, right.Relevance)
	case SortFieldUnspecified:
		// ApplicationQuery.Normalized replaces Unspecified with Name before use.
		return strings.Compare(left.Name, right.Name)
	default:
		return 0
	}
}

func compareRelevance(left, right RelevanceKey) int {
	if compared := compareOrdered(tierRank(left.Tier), tierRank(right.Tier)); compared != 0 {
		return compared
	}
	if left.Tier != SearchTierTrigram {
		return 0
	}
	leftProduct := uint64(left.Shared) * uint64(right.Union)
	rightProduct := uint64(right.Shared) * uint64(left.Union)
	// Greater trigram similarity is more relevant and therefore sorts first.
	return -compareOrdered(leftProduct, rightProduct)
}

func compareImpact(left, right ImpactKey) int {
	if compared := compareOrdered(left.UnhealthySeverity, right.UnhealthySeverity); compared != 0 {
		return compared
	}
	if compared := compareOrdered(left.BlockedGates, right.BlockedGates); compared != 0 {
		return compared
	}
	if compared := compareBool(left.ActiveChange, right.ActiveChange); compared != 0 {
		return compared
	}
	if compared := compareOrdered(left.ResourceCount, right.ResourceCount); compared != 0 {
		return compared
	}
	return compareOrdered(left.LastTransitionUnixMS, right.LastTransitionUnixMS)
}

func compareObjectKeys(left, right types.NamespacedName) int {
	if compared := strings.Compare(left.Namespace, right.Namespace); compared != 0 {
		return compared
	}
	return strings.Compare(left.Name, right.Name)
}

func compareOrdered[T interface {
	~int64 | ~uint8 | ~uint32 | ~uint64
}](left, right T) int {
	switch {
	case left < right:
		return -1
	case left > right:
		return 1
	default:
		return 0
	}
}

func compareBool(left, right bool) int {
	switch {
	case left == right:
		return 0
	case left:
		return 1
	default:
		return -1
	}
}
