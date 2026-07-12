package fleet

import (
	"sort"

	"k8s.io/apimachinery/pkg/types"
)

// ProjectSet is the request-scoped set of projects a caller may read.
// Visibility always derives from this set; capabilities never grant visibility.
type ProjectSet map[ProjectKey]struct{}

// Capability is an authorization-provider-neutral action a caller may perform.
type Capability uint8

const (
	CapabilityUnspecified     Capability = 0
	CapabilityApplicationSync Capability = 1
	CapabilityReleaseRollback Capability = 2
	CapabilityGateApprove     Capability = 3
	CapabilityPipelineRetry   Capability = 4
)

// CapabilitySet contains actions authorized within one project.
type CapabilitySet map[Capability]struct{}

// QueryScope is calculated by the API authorization layer for every request.
// An empty Projects set intentionally fails closed.
type QueryScope struct {
	Projects              ProjectSet
	CapabilitiesByProject map[ProjectKey]CapabilitySet
}

// SortedCapabilities returns a stable copy of the capabilities for an
// authorized project. Capability entries for a project outside Projects are
// ignored so they cannot accidentally become a visibility signal.
func (s QueryScope) SortedCapabilities(project ProjectKey) []Capability {
	if _, authorized := s.Projects[project]; !authorized {
		return []Capability{}
	}

	set := s.CapabilitiesByProject[project]
	capabilities := make([]Capability, 0, len(set))
	for capability := range set {
		if capability != CapabilityUnspecified {
			capabilities = append(capabilities, capability)
		}
	}
	sort.Slice(capabilities, func(i, j int) bool {
		return capabilities[i] < capabilities[j]
	})
	return capabilities
}

// ApplicationFilter is an exact, provider-neutral fleet filter. Values in one
// field are ORed; non-empty fields are ANDed with every other field.
type ApplicationFilter struct {
	Projects      []ProjectKey
	Namespaces    []string
	Clusters      []ClusterKey
	Stages        []string
	Health        []Health
	Sync          []SyncState
	ReleaseStates []ReleaseState
	RolloutStates []RolloutState
	SourceTypes   []SourceType
}

// ActiveDimensionCount returns how many filter dimensions constrain a query.
// Multiple values within one dimension still count as one active dimension.
func (f *ApplicationFilter) ActiveDimensionCount() int {
	if f == nil {
		return 0
	}
	count := 0
	for _, active := range [...]bool{
		len(f.Projects) > 0,
		len(f.Namespaces) > 0,
		len(f.Clusters) > 0,
		len(f.Stages) > 0,
		len(f.Health) > 0,
		len(f.Sync) > 0,
		len(f.ReleaseStates) > 0,
		len(f.RolloutStates) > 0,
		len(f.SourceTypes) > 0,
	} {
		if active {
			count++
		}
	}
	return count
}

// Normalized returns a deterministically sorted and de-duplicated copy.
func (f *ApplicationFilter) Normalized() ApplicationFilter {
	return ApplicationFilter{
		Projects:      sortedUniqueObjectKeys(f.Projects),
		Namespaces:    sortedUniqueOrdered(f.Namespaces),
		Clusters:      sortedUniqueObjectKeys(f.Clusters),
		Stages:        sortedUniqueOrdered(f.Stages),
		Health:        sortedUniqueOrdered(f.Health),
		Sync:          sortedUniqueOrdered(f.Sync),
		ReleaseStates: sortedUniqueOrdered(f.ReleaseStates),
		RolloutStates: sortedUniqueOrdered(f.RolloutStates),
		SourceTypes:   sortedUniqueOrdered(f.SourceTypes),
	}
}

// FilterResult keeps the candidate identities and exact search tuples together
// so later sorting can retain relevance without recomputing or using floats.
type FilterResult struct {
	IDs     IDSet
	Matches map[types.NamespacedName]SearchMatch
}

// FilterApplications authorizes first, searches only within that set, then
// applies exact filter dimensions. It never reads mutable Kubernetes state.
func (s *Snapshot) FilterApplications(
	scope QueryScope,
	//nolint:gocritic // Public query methods consistently accept an immutable value object.
	filter ApplicationFilter,
	search string,
) (FilterResult, error) {
	searched, err := s.authorizedSearch(scope, search)
	if err != nil {
		return FilterResult{}, err
	}

	ids := searched.IDs
	normalized := filter.Normalized()
	ids = intersectPostings(ids, s.ByProject, normalized.Projects)
	ids = intersectPostings(ids, s.ByNamespace, normalized.Namespaces)
	ids = intersectPostings(ids, s.ByCluster, normalized.Clusters)
	ids = intersectPostings(ids, s.ByStage, normalized.Stages)
	ids = intersectPostings(ids, s.ByHealth, normalized.Health)
	ids = intersectPostings(ids, s.BySync, normalized.Sync)
	ids = intersectPostings(ids, s.ByRelease, normalized.ReleaseStates)
	ids = intersectPostings(ids, s.ByRollout, normalized.RolloutStates)
	ids = intersectPostings(ids, s.BySourceType, normalized.SourceTypes)

	return retainFilterMatches(ids, searched.Matches), nil
}

func (s *Snapshot) authorizedSearch(scope QueryScope, search string) (FilterResult, error) {
	authorized := unionPostings(s.ByProject, sortedProjectSet(scope.Projects))
	matches, err := s.Search(search, authorized)
	if err != nil {
		return FilterResult{}, err
	}

	result := FilterResult{
		IDs:     make(IDSet, len(matches)),
		Matches: make(map[types.NamespacedName]SearchMatch, len(matches)),
	}
	for i := range matches {
		result.IDs[matches[i].Identity] = struct{}{}
		result.Matches[matches[i].Identity] = matches[i]
	}
	return result, nil
}

func retainFilterMatches(ids IDSet, matches map[types.NamespacedName]SearchMatch) FilterResult {
	retained := make(map[types.NamespacedName]SearchMatch, len(ids))
	for id := range ids {
		if match, ok := matches[id]; ok {
			retained[id] = match
		}
	}
	return FilterResult{IDs: ids, Matches: retained}
}

func intersectPostings[K comparable](candidates IDSet, index map[K]IDSet, selected []K) IDSet {
	if len(selected) == 0 {
		return candidates
	}
	return candidates.Intersect(unionPostings(index, selected))
}

func unionPostings[K comparable](index map[K]IDSet, selected []K) IDSet {
	union := make(IDSet)
	for _, value := range selected {
		for id := range index[value] {
			union[id] = struct{}{}
		}
	}
	return union
}

func sortedProjectSet(set ProjectSet) []ProjectKey {
	projects := make([]ProjectKey, 0, len(set))
	for project := range set {
		projects = append(projects, project)
	}
	return sortedUniqueObjectKeys(projects)
}

func sortedUniqueObjectKeys(values []types.NamespacedName) []types.NamespacedName {
	result := append([]types.NamespacedName(nil), values...)
	sort.Slice(result, func(i, j int) bool {
		if result[i].Namespace != result[j].Namespace {
			return result[i].Namespace < result[j].Namespace
		}
		return result[i].Name < result[j].Name
	})
	return compactSorted(result)
}

func sortedUniqueOrdered[T interface {
	~string | ~uint8
}](values []T) []T {
	result := append([]T(nil), values...)
	sort.Slice(result, func(i, j int) bool {
		return result[i] < result[j]
	})
	return compactSorted(result)
}

func compactSorted[T comparable](values []T) []T {
	if len(values) == 0 {
		return []T{}
	}

	write := 1
	for read := 1; read < len(values); read++ {
		if values[read] != values[write-1] {
			values[write] = values[read]
			write++
		}
	}
	return values[:write]
}
