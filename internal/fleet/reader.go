package fleet

import (
	"context"
	"sort"
)

// Reader is the narrow, cache-only fleet surface consumed by the API layer.
// Context is accepted at the boundary for cancellation and query telemetry;
// the immutable Snapshot methods remain pure and perform no Kubernetes reads.
type Reader interface {
	ProjectKeys(context.Context, []string) ([]ProjectKey, error)
	QueryApplications(context.Context, QueryScope, ApplicationQuery, string) (ApplicationPage, error)
	QueryMap(context.Context, QueryScope, FleetMapQuery) (FleetMap, error)
	QueryMatrix(context.Context, QueryScope, FleetMatrixQuery) (FleetMatrix, error)
	LoadSnapshot() (*Snapshot, error)
	CheckReady() error
}

var _ Reader = (*Index)(nil)

// ProjectKeys returns only declared or indexed project identities, optionally
// constrained by project namespace. It never invents candidates and never
// lists Kubernetes objects. Results are de-duplicated and deterministic.
func (i *Index) ProjectKeys(_ context.Context, namespaces []string) ([]ProjectKey, error) {
	snapshot, err := i.LoadSnapshot()
	if err != nil {
		return nil, err
	}

	namespaceSet := projectNamespaceSet(namespaces)
	projects := snapshotProjectCandidates(snapshot)
	keys := make([]ProjectKey, 0, len(projects))
	for project := range projects {
		if projectNamespaceAllowed(project, namespaceSet) {
			keys = append(keys, project)
		}
	}
	sort.Slice(keys, func(left, right int) bool {
		return compareObjectKeys(keys[left], keys[right]) < 0
	})
	return keys, nil
}

func projectNamespaceSet(namespaces []string) map[string]struct{} {
	set := make(map[string]struct{}, len(namespaces))
	for _, namespace := range sortedUniqueOrdered(namespaces) {
		if namespace != "" {
			set[namespace] = struct{}{}
		}
	}
	return set
}

func snapshotProjectCandidates(snapshot *Snapshot) map[ProjectKey]struct{} {
	projects := make(map[ProjectKey]struct{}, len(snapshot.Projects)+len(snapshot.ByProject))
	for project := range snapshot.Projects {
		if completeObjectKey(project) {
			projects[project] = struct{}{}
		}
	}
	for project := range snapshot.ByProject {
		if completeObjectKey(project) {
			projects[project] = struct{}{}
		}
	}
	return projects
}

func projectNamespaceAllowed(project ProjectKey, namespaces map[string]struct{}) bool {
	if len(namespaces) == 0 {
		return true
	}
	_, ok := namespaces[project.Namespace]
	return ok
}

// QueryApplications serves the latest installed immutable snapshot even when
// readiness is degraded; a previously good generation remains useful.
//
//nolint:gocritic // Reader methods consistently accept immutable query value objects.
func (i *Index) QueryApplications(
	_ context.Context,
	scope QueryScope,
	query ApplicationQuery,
	cursor string,
) (ApplicationPage, error) {
	snapshot, err := i.LoadSnapshot()
	if err != nil {
		return ApplicationPage{}, err
	}
	return snapshot.QueryApplications(scope, query, cursor)
}

// QueryMap delegates without a WeightReader until the future metrics cache is
// injected through a fleet-owned decorator or Index dependency.
//
//nolint:gocritic // Reader methods consistently accept immutable query value objects.
func (i *Index) QueryMap(_ context.Context, scope QueryScope, query FleetMapQuery) (FleetMap, error) {
	snapshot, err := i.LoadSnapshot()
	if err != nil {
		return FleetMap{}, err
	}
	return snapshot.QueryMap(scope, query, nil)
}

// QueryMatrix delegates without a WeightReader until the future metrics cache
// is injected through a fleet-owned decorator or Index dependency.
//
//nolint:gocritic // Reader methods consistently accept immutable query value objects.
func (i *Index) QueryMatrix(_ context.Context, scope QueryScope, query FleetMatrixQuery) (FleetMatrix, error) {
	snapshot, err := i.LoadSnapshot()
	if err != nil {
		return FleetMatrix{}, err
	}
	return snapshot.QueryMatrix(scope, query, nil)
}
