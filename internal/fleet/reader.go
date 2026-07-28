package fleet

import (
	"context"
	"errors"
	"sort"
	"time"

	paprikametrics "github.com/benebsworth/paprika/internal/metrics"
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
func (i *Index) ProjectKeys(ctx context.Context, namespaces []string) (keys []ProjectKey, err error) {
	activeDimensions := 0
	if len(namespaces) > 0 {
		activeDimensions = 1
	}
	observation := startFleetQueryObservation(
		ctx, fleetQueryProjectKeys, paprikametrics.FleetQueryProjectKeys, activeDimensions,
	)
	defer func() { observation.end(err) }()

	snapshot, err := i.LoadSnapshot()
	if err != nil {
		return nil, err
	}
	observation.observeSnapshot(snapshot, fleetSnapshotCacheOutcome(i, snapshot))

	namespaceSet := projectNamespaceSet(namespaces)
	projects := snapshotProjectCandidates(snapshot)
	keys = make([]ProjectKey, 0, len(projects))
	for project := range projects {
		if projectNamespaceAllowed(project, namespaceSet) {
			keys = append(keys, project)
		}
	}
	sort.Slice(keys, func(left, right int) bool {
		return compareObjectKeys(keys[left], keys[right]) < 0
	})
	observation.fields.ResultCount = uint64(len(keys))
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
	ctx context.Context,
	scope QueryScope,
	query ApplicationQuery,
	cursor string,
) (page ApplicationPage, err error) {
	observation := startFleetQueryObservation(
		ctx, fleetQueryApplications, paprikametrics.FleetQueryApplications,
		activeFleetFilterDimensions(&query.Filter),
	)
	defer func() { observation.end(err) }()

	snapshot, err := i.LoadSnapshot()
	if err != nil {
		return ApplicationPage{}, err
	}
	observation.observeSnapshot(snapshot, fleetSnapshotCacheOutcome(i, snapshot))
	page, err = snapshot.QueryApplications(scope, query, cursor)
	observation.fields.ResultCount = uint64(len(page.Applications))
	return page, err
}

// QueryMap delegates without a WeightReader until the future metrics cache is
// injected through a fleet-owned decorator or Index dependency.
//
//nolint:gocritic // Reader methods consistently accept immutable query value objects.
func (i *Index) QueryMap(ctx context.Context, scope QueryScope, query FleetMapQuery) (result FleetMap, err error) {
	observation := startFleetQueryObservation(
		ctx, fleetQueryMap, paprikametrics.FleetQueryMap,
		activeFleetFilterDimensions(&query.Filter),
	)
	defer func() { observation.end(err) }()

	snapshot, err := i.LoadSnapshot()
	if err != nil {
		return FleetMap{}, err
	}
	observation.observeSnapshot(snapshot, fleetSnapshotCacheOutcome(i, snapshot))
	result, err = snapshot.QueryMap(scope, query, nil)
	observation.fields.ResultCount = uint64(len(result.Roots))
	return result, err
}

// QueryMatrix delegates without a WeightReader until the future metrics cache
// is injected through a fleet-owned decorator or Index dependency.
//
//nolint:gocritic // Reader methods consistently accept immutable query value objects.
func (i *Index) QueryMatrix(ctx context.Context, scope QueryScope, query FleetMatrixQuery) (result FleetMatrix, err error) {
	observation := startFleetQueryObservation(
		ctx, fleetQueryMatrix, paprikametrics.FleetQueryMatrix,
		activeFleetFilterDimensions(&query.Filter),
	)
	defer func() { observation.end(err) }()

	snapshot, err := i.LoadSnapshot()
	if err != nil {
		return FleetMatrix{}, err
	}
	observation.observeSnapshot(snapshot, fleetSnapshotCacheOutcome(i, snapshot))
	result, err = snapshot.QueryMatrix(scope, query, nil)
	observation.fields.ResultCount = uint64(len(result.Cells))
	return result, err
}

type fleetQueryObservation struct {
	ctx              context.Context
	started          time.Time
	span             fleetTelemetrySpan
	metricKind       paprikametrics.FleetQueryKind
	activeDimensions int
	fields           fleetSpanFields
}

func startFleetQueryObservation(
	ctx context.Context,
	kind fleetQueryKind,
	metricKind paprikametrics.FleetQueryKind,
	activeDimensions int,
) *fleetQueryObservation {
	started := time.Now()
	spanCtx, span := startFleetQuerySpan(ctx, kind, activeDimensions)
	return &fleetQueryObservation{
		ctx: spanCtx, started: started, span: span, metricKind: metricKind,
		activeDimensions: activeDimensions,
		fields:           fleetSpanFields{CacheOutcome: fleetCacheMiss},
	}
}

func (o *fleetQueryObservation) observeSnapshot(snapshot *Snapshot, cacheOutcome fleetCacheOutcome) {
	fields, installed := fleetSnapshotSpanFields(snapshot)
	if installed {
		o.fields.Generation = fields.Generation
	}
	o.fields.CacheOutcome = cacheOutcome
}

func (o *fleetQueryObservation) end(err error) {
	outcome := fleetTelemetrySuccess
	metricOutcome := paprikametrics.FleetOutcomeSuccess
	if err != nil {
		outcome = fleetTelemetryError
		metricOutcome = paprikametrics.FleetOutcomeError
		var unavailable *ErrUnavailable
		if errors.As(err, &unavailable) {
			outcome = fleetTelemetryUnavailable
			metricOutcome = paprikametrics.FleetOutcomeUnavailable
		}
	}
	o.span.End(outcome, o.fields)
	paprikametrics.RecordFleetQuery(
		o.ctx,
		o.metricKind,
		time.Since(o.started),
		boundedTelemetryCount(o.fields.ResultCount),
		o.activeDimensions,
		metricCacheOutcome(o.fields.CacheOutcome),
		metricOutcome,
	)
}

func fleetSnapshotSpanFields(snapshot *Snapshot) (fleetSpanFields, bool) {
	if snapshot == nil {
		return fleetSpanFields{}, false
	}
	return fleetSpanFields{
		Generation: snapshot.Generation,
		ItemCount:  uint64(len(snapshot.Applications)),
	}, true
}

func fleetSnapshotCacheOutcome(index *Index, snapshot *Snapshot) fleetCacheOutcome {
	if index == nil || snapshot == nil {
		return fleetCacheMiss
	}
	health := index.health.Load()
	if health != nil && health.Degraded {
		return fleetCacheStale
	}
	return fleetCacheHit
}

func metricCacheOutcome(outcome fleetCacheOutcome) paprikametrics.FleetCacheOutcome {
	switch outcome {
	case fleetCacheHit:
		return paprikametrics.FleetCacheHit
	case fleetCacheStale:
		return paprikametrics.FleetCacheStale
	case fleetCacheMiss:
		return paprikametrics.FleetCacheMiss
	default:
		return paprikametrics.FleetCacheOutcome("")
	}
}

func activeFleetFilterDimensions(filter *ApplicationFilter) int {
	if filter == nil {
		return 0
	}
	count := 0
	for _, active := range [...]bool{
		len(filter.Projects) > 0,
		len(filter.Namespaces) > 0,
		len(filter.Clusters) > 0,
		len(filter.Stages) > 0,
		len(filter.Health) > 0,
		len(filter.Sync) > 0,
		len(filter.ReleaseStates) > 0,
		len(filter.RolloutStates) > 0,
		len(filter.SourceTypes) > 0,
	} {
		if active {
			count++
		}
	}
	return count
}
