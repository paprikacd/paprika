package fleet

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"sort"
	"testing"
	"time"
)

const (
	fleetScaleApplicationCount = 10_000
	fleetScaleProjectCount     = 100
	fleetScaleClusterCount     = 100
	fleetScaleWarmQueryCount   = 10
	fleetScaleQueryCount       = 100
	fleetScaleP95Limit         = 300 * time.Millisecond

	fleetScaleControlledEnvironment = "PAPRIKA_FLEET_SCALE_CONTROLLED"
)

type fleetScaleQuery struct {
	name string
	run  func() (int, error)
}

func TestFleetAPIScaleGate(t *testing.T) {
	gomaxprocs := runtime.GOMAXPROCS(0)
	printFleetScaleEnvironment(gomaxprocs)
	if fleetScaleRaceEnabled() {
		t.Skip("fleet API latency and retained-heap gate is not meaningful under race instrumentation")
	}
	if os.Getenv(fleetScaleControlledEnvironment) == "1" && gomaxprocs != 4 {
		t.Fatalf("controlled fleet scale gate requires GOMAXPROCS=4, got %d", gomaxprocs)
	}

	index := NewIndex()
	p95, allocationCount, resultCount := runFleetScaleWorkload(t, index)
	printFleetScaleQueryResults(p95, allocationCount, resultCount)

	firstHeap := fleetScaleHeapAfterTwoGCs()
	fmt.Printf("FLEET_HEAP_BYTES=%d\n", firstHeap)

	installAndRequireFleetScaleSnapshot(t, index)
	secondHeap := fleetScaleHeapAfterTwoGCs()
	growth, allowance, growthPercent := fleetScaleHeapGrowth(firstHeap, secondHeap)
	printFleetScaleHeapResults(secondHeap, growth, allowance, growthPercent)
	runtime.KeepAlive(index)

	if fleetScaleP95ExceedsLimit(p95) {
		t.Errorf("fleet API p95 %s exceeds %s", p95, fleetScaleP95Limit)
	}
	if fleetScaleHeapGrowthExceedsLimit(growth, allowance) {
		t.Errorf(
			"second identical install retained %d additional heap bytes (%.3f%%); allowance is %d bytes",
			growth,
			growthPercent,
			allowance,
		)
	}
}

func fleetScaleP95ExceedsLimit(p95 time.Duration) bool {
	return p95 >= fleetScaleP95Limit
}

func fleetScaleRaceEnabled() bool {
	buildInfo, ok := debug.ReadBuildInfo()
	if !ok {
		return false
	}
	for _, setting := range buildInfo.Settings {
		if setting.Key == "-race" {
			return setting.Value == "true"
		}
	}
	return false
}

func runFleetScaleWorkload(t *testing.T, index *Index) (time.Duration, uint64, int) {
	t.Helper()

	snapshot := installFleetScaleSnapshot(t, index)
	requireFleetScaleShape(t, snapshot)
	queries := fleetScaleQueries(
		index,
		snapshot,
		fleetScaleQueryScope(),
		fleetScaleCandidates(snapshot),
	)

	resultCount := warmFleetScaleQueries(t, queries)
	runtime.GC()
	var allocationsBefore runtime.MemStats
	runtime.ReadMemStats(&allocationsBefore)
	durations, measuredResults := measureFleetScaleQueries(t, queries)
	resultCount += measuredResults
	var allocationsAfter runtime.MemStats
	runtime.ReadMemStats(&allocationsAfter)
	return fleetScaleP95(durations), allocationsAfter.Mallocs - allocationsBefore.Mallocs, resultCount
}

func installAndRequireFleetScaleSnapshot(t *testing.T, index *Index) {
	t.Helper()

	snapshot := installFleetScaleSnapshot(t, index)
	requireFleetScaleShape(t, snapshot)
}

func printFleetScaleEnvironment(gomaxprocs int) {
	fmt.Printf("FLEET_GO_VERSION=%s\n", runtime.Version())
	fmt.Printf("FLEET_GOOS=%s\n", runtime.GOOS)
	fmt.Printf("FLEET_GOARCH=%s\n", runtime.GOARCH)
	fmt.Printf("FLEET_GOMAXPROCS=%d\n", gomaxprocs)
}

func printFleetScaleQueryResults(p95 time.Duration, allocations uint64, results int) {
	fmt.Printf("FLEET_API_P95_MS=%.3f\n", float64(p95)/float64(time.Millisecond))
	fmt.Printf("FLEET_API_ALLOCATION_COUNT=%d\n", allocations)
	fmt.Printf("FLEET_API_ALLOCATIONS_PER_QUERY=%.3f\n", float64(allocations)/fleetScaleQueryCount)
	fmt.Printf("FLEET_API_QUERY_COUNT=%d\n", fleetScaleQueryCount)
	fmt.Printf("FLEET_API_WARM_QUERY_COUNT=%d\n", fleetScaleWarmQueryCount)
	fmt.Printf("FLEET_API_RESULT_COUNT=%d\n", results)
}

func printFleetScaleHeapResults(second, growth, allowance uint64, growthPercent float64) {
	fmt.Printf("FLEET_HEAP_SECOND_BYTES=%d\n", second)
	fmt.Printf("FLEET_HEAP_GROWTH_BYTES=%d\n", growth)
	fmt.Printf("FLEET_HEAP_GROWTH_PERCENT=%.3f\n", growthPercent)
	fmt.Printf("FLEET_HEAP_ALLOWED_GROWTH_BYTES=%d\n", allowance)
}

func installFleetScaleSnapshot(t *testing.T, index *Index) *Snapshot {
	t.Helper()

	builder := buildFleetScaleSnapshot()
	if err := index.Install(builder); err != nil {
		t.Fatalf("install fleet scale snapshot: %v", err)
	}

	snapshot, err := index.LoadSnapshot()
	if err != nil {
		t.Fatalf("load installed fleet scale snapshot: %v", err)
	}
	return snapshot
}

func buildFleetScaleSnapshot() *Snapshot {
	builder := NewSnapshot(1)
	for index := 0; index < fleetScaleProjectCount; index++ {
		project := fleetScaleProjectKey(index)
		builder.Projects[project] = ProjectSummary{Identity: project}
	}
	for index := 0; index < fleetScaleClusterCount; index++ {
		cluster := fleetScaleClusterKey(index)
		builder.Clusters[cluster] = ClusterSummary{
			Identity: cluster, DisplayName: fleetScaleClusterLabel(index), Connection: fleetScaleConnection(index),
		}
	}
	for index := 0; index < fleetScaleApplicationCount; index++ {
		application := fleetScaleApplication(index)
		addApplicationMutable(builder, &application)
	}
	return builder
}

func fleetScaleApplication(index int) ApplicationSummary {
	healthStates := [...]Health{
		HealthHealthy, HealthProgressing, HealthDegraded, HealthFailed, HealthUnknown, HealthMissing,
	}
	syncStates := [...]SyncState{SyncStateSynced, SyncStateOutOfSync, SyncStateUnknown}
	releaseStates := [...]ReleaseState{
		ReleaseStatePending, ReleaseStatePromoting, ReleaseStateCanarying,
		ReleaseStateVerifying, ReleaseStateComplete, ReleaseStateFailed,
		ReleaseStateRolledBack, ReleaseStateSuperseded, ReleaseStateAwaitingApproval,
	}
	rolloutStates := [...]RolloutState{
		RolloutStatePending, RolloutStateProgressing, RolloutStatePaused, RolloutStateHealthy,
		RolloutStateDegraded, RolloutStateFailed, RolloutStateRolledBack, RolloutStateAborted,
	}
	sourceTypes := [...]SourceType{
		SourceTypeGit, SourceTypeHelm, SourceTypeKustomize, SourceTypeS3, SourceTypeOCI, SourceTypeInline,
	}

	project := fleetScaleProjectKey(index / (fleetScaleApplicationCount / fleetScaleProjectCount))
	baseCluster := index % fleetScaleClusterCount
	targets := []StageTargetSummary{
		fleetScaleTarget("development", 0, baseCluster, healthStates[index%len(healthStates)]),
		fleetScaleTarget("staging", 1, (baseCluster+17)%fleetScaleClusterCount, healthStates[(index+1)%len(healthStates)]),
		fleetScaleTarget("production", 2, (baseCluster+53)%fleetScaleClusterCount, healthStates[(index+2)%len(healthStates)]),
	}
	currentTarget := targets[index%len(targets)]
	syncState := syncStates[index%len(syncStates)]
	driftCount := uint32(0)
	if syncState == SyncStateOutOfSync {
		driftCount = uint32(1 + index%7) // #nosec G115 -- the deterministic value is in [1, 7].
	}

	return ApplicationSummary{
		Identity:                     fleetID(project.Namespace, fmt.Sprintf("service-%05d", index)),
		Project:                      project,
		Targets:                      targets,
		CurrentStage:                 currentTarget.Stage,
		CurrentCluster:               currentTarget.Cluster,
		CurrentClusterLabel:          currentTarget.ClusterLabel,
		SourceType:                   sourceTypes[index%len(sourceTypes)],
		SourceRevision:               fmt.Sprintf("sha-%08x", index),
		Health:                       healthStates[index%len(healthStates)],
		Sync:                         syncState,
		DriftCount:                   driftCount,
		MissingResourceCount:         uint32(index % 4), // #nosec G115 -- the deterministic value is in [0, 3].
		ReleaseState:                 releaseStates[index%len(releaseStates)],
		RolloutState:                 rolloutStates[index%len(rolloutStates)],
		ResourceCount:                uint32(20 + index%480), // #nosec G115 -- the deterministic value is in [20, 499].
		RepositoryConnection:         fleetScaleConnection(index + 1),
		ObservabilityConnection:      fleetScaleConnection(index + 2),
		BlockedGateCount:             uint32(index % 3), // #nosec G115 -- the deterministic value is in [0, 2].
		LastTransitionUnixMS:         1_700_000_000_000 + int64(index)*60_000,
		ObservabilityBindings:        nil,
		EffectiveObservabilitySource: SourceKey{},
	}
}

func fleetScaleTarget(stage string, ring int32, clusterIndex int, health Health) StageTargetSummary {
	cluster := fleetScaleClusterKey(clusterIndex)
	return StageTargetSummary{
		StableID:          fmt.Sprintf("%s-%03d", stage, clusterIndex),
		Stage:             stage,
		Ring:              ring,
		Cluster:           cluster,
		ClusterLabel:      fleetScaleClusterLabel(clusterIndex),
		Health:            health,
		ClusterConnection: fleetScaleConnection(clusterIndex),
	}
}

func fleetScaleProjectKey(index int) ProjectKey {
	return ProjectKey{
		Namespace: fmt.Sprintf("team-%02d", index/10),
		Name:      fmt.Sprintf("project-%03d", index),
	}
}

func fleetScaleClusterKey(index int) ClusterKey {
	return ClusterKey{Namespace: "clusters", Name: fmt.Sprintf("cluster-%03d", index)}
}

func fleetScaleClusterLabel(index int) string {
	return fmt.Sprintf("Cluster %03d", index)
}

func fleetScaleConnection(index int) ConnectionState {
	if index%10 == 0 {
		return ConnectionStateUnhealthy
	}
	return ConnectionStateHealthy
}

func requireFleetScaleShape(t *testing.T, snapshot *Snapshot) {
	t.Helper()

	counts := []struct {
		name string
		got  int
		want int
	}{
		{name: "applications", got: len(snapshot.Applications), want: fleetScaleApplicationCount},
		{name: "projects", got: len(snapshot.Projects), want: fleetScaleProjectCount},
		{name: "project postings", got: len(snapshot.ByProject), want: fleetScaleProjectCount},
		{name: "clusters", got: len(snapshot.Clusters), want: fleetScaleClusterCount},
		{name: "cluster postings", got: len(snapshot.ByCluster), want: fleetScaleClusterCount},
		{name: "stages", got: len(snapshot.ByStage), want: 3},
		{name: "health facets", got: len(snapshot.ByHealth), want: 6},
		{name: "sync facets", got: len(snapshot.BySync), want: 3},
		{name: "release facets", got: len(snapshot.ByRelease), want: 9},
		{name: "rollout facets", got: len(snapshot.ByRollout), want: 8},
		{name: "source type facets", got: len(snapshot.BySourceType), want: 6},
	}
	for _, count := range counts {
		if count.got != count.want {
			t.Fatalf("fleet scale fixture %s = %d, want %d", count.name, count.got, count.want)
		}
	}
}

func fleetScaleQueryScope() QueryScope {
	projects := make(ProjectSet, fleetScaleProjectCount)
	capabilities := make(map[ProjectKey]CapabilitySet, fleetScaleProjectCount)
	for index := 0; index < fleetScaleProjectCount; index++ {
		project := fleetScaleProjectKey(index)
		projects[project] = struct{}{}
		capabilities[project] = CapabilitySet{
			CapabilityApplicationSync: {},
			CapabilityGateApprove:     {},
		}
	}
	return QueryScope{Projects: projects, CapabilitiesByProject: capabilities}
}

func fleetScaleCandidates(snapshot *Snapshot) IDSet {
	candidates := make(IDSet, len(snapshot.Applications))
	for identity := range snapshot.Applications {
		candidates[identity] = struct{}{}
	}
	return candidates
}

func fleetScaleQueries(
	index *Index,
	snapshot *Snapshot,
	scope QueryScope,
	candidates IDSet,
) []fleetScaleQuery {
	filter := ApplicationFilter{
		Clusters:    []ClusterKey{fleetScaleClusterKey(17), fleetScaleClusterKey(42), fleetScaleClusterKey(83)},
		Stages:      []string{"production", "staging"},
		Health:      []Health{HealthHealthy, HealthDegraded, HealthFailed},
		Sync:        []SyncState{SyncStateSynced, SyncStateOutOfSync},
		SourceTypes: []SourceType{SourceTypeGit, SourceTypeHelm, SourceTypeKustomize},
	}
	ctx := context.Background()
	return []fleetScaleQuery{
		{name: "filter", run: func() (int, error) {
			result, err := snapshot.FilterApplications(scope, filter, "")
			return len(result.IDs), err
		}},
		{name: "search", run: func() (int, error) {
			result, err := snapshot.Search("service-042", candidates)
			return len(result), err
		}},
		{name: "facets", run: func() (int, error) {
			result, err := snapshot.Facets(scope, filter, "service")
			return len(result), err
		}},
		{name: "map", run: func() (int, error) {
			result, err := index.QueryMap(ctx, scope, FleetMapQuery{
				Filter: filter, Search: "service", Group: GroupDimensionProject, SizeMetric: SizeMetricResourceCount,
			})
			return len(result.Roots), err
		}},
		{name: "matrix", run: func() (int, error) {
			result, err := index.QueryMatrix(ctx, scope, FleetMatrixQuery{
				Filter: filter, Search: "service", RowGroup: GroupDimensionCluster,
				ColumnGroup: GroupDimensionStage, SizeMetric: SizeMetricResourceCount,
			})
			return len(result.Cells), err
		}},
		{name: "applications", run: func() (int, error) {
			result, err := index.QueryApplications(ctx, scope, ApplicationQuery{
				Filter: filter, Search: "service", Sort: SortFieldImpact,
				Direction: SortDirectionDesc, PageSize: 250,
			}, "")
			return len(result.Applications), err
		}},
	}
}

func warmFleetScaleQueries(t *testing.T, queries []fleetScaleQuery) int {
	t.Helper()

	resultCount := 0
	for index := 0; index < fleetScaleWarmQueryCount; index++ {
		resultCount += runFleetScaleQuery(t, queries[index%len(queries)])
	}
	return resultCount
}

func measureFleetScaleQueries(t *testing.T, queries []fleetScaleQuery) ([]time.Duration, int) {
	t.Helper()

	durations := make([]time.Duration, 0, fleetScaleQueryCount)
	resultCount := 0
	for index := 0; index < fleetScaleQueryCount; index++ {
		query := queries[index%len(queries)]
		started := time.Now()
		count, err := query.run()
		durations = append(durations, time.Since(started))
		if err != nil {
			t.Fatalf("run measured %s query: %v", query.name, err)
		}
		if count == 0 {
			t.Fatalf("measured %s query returned no results", query.name)
		}
		resultCount += count
	}
	return durations, resultCount
}

func runFleetScaleQuery(t *testing.T, query fleetScaleQuery) int {
	t.Helper()

	count, err := query.run()
	if err != nil {
		t.Fatalf("run warm %s query: %v", query.name, err)
	}
	if count == 0 {
		t.Fatalf("warm %s query returned no results", query.name)
	}
	return count
}

func fleetScaleP95(samples []time.Duration) time.Duration {
	ordered := append([]time.Duration(nil), samples...)
	sort.Slice(ordered, func(left, right int) bool { return ordered[left] < ordered[right] })
	rank := (95*len(ordered) + 99) / 100
	if rank == 0 {
		return 0
	}
	return ordered[rank-1]
}

func fleetScaleHeapAfterTwoGCs() uint64 {
	runtime.GC()
	runtime.GC()
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	return stats.HeapAlloc
}

func fleetScaleHeapGrowth(first, second uint64) (growth, allowance uint64, percent float64) {
	if first > 0 {
		// This is the greatest whole-byte increase strictly below 5%. The
		// subtraction-and-division form cannot overflow like growth*20 can.
		allowance = (first - 1) / 20
	}
	if second <= first {
		return 0, allowance, 0
	}
	growth = second - first
	if first > 0 {
		percent = float64(growth) / float64(first) * 100
	}
	return growth, allowance, percent
}

func fleetScaleHeapGrowthExceedsLimit(growth, allowance uint64) bool {
	return growth > allowance
}

func TestFleetScaleP95ThresholdIsStrict(t *testing.T) {
	tests := []struct {
		name     string
		p95      time.Duration
		exceeded bool
	}{
		{name: "below", p95: fleetScaleP95Limit - time.Nanosecond},
		{name: "equal", p95: fleetScaleP95Limit, exceeded: true},
		{name: "above", p95: fleetScaleP95Limit + time.Nanosecond, exceeded: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := fleetScaleP95ExceedsLimit(test.p95); got != test.exceeded {
				t.Fatalf("fleetScaleP95ExceedsLimit(%s) = %t, want %t", test.p95, got, test.exceeded)
			}
		})
	}
}

func TestFleetScaleHeapGrowthThresholdIsStrict(t *testing.T) {
	tests := []struct {
		name      string
		first     uint64
		second    uint64
		growth    uint64
		allowance uint64
		exceeded  bool
	}{
		{name: "zero baseline and growth", first: 0, second: 0},
		{name: "zero baseline with growth", first: 0, second: 1, growth: 1, exceeded: true},
		{name: "decrease", first: 100, second: 99, allowance: 4},
		{name: "no growth", first: 100, second: 100, allowance: 4},
		{name: "below five percent", first: 100, second: 104, growth: 4, allowance: 4},
		{name: "equal five percent", first: 100, second: 105, growth: 5, allowance: 4, exceeded: true},
		{name: "above five percent", first: 100, second: 106, growth: 6, allowance: 4, exceeded: true},
		{name: "fractional byte boundary", first: 101, second: 106, growth: 5, allowance: 5},
		{name: "fractional byte exceeded", first: 101, second: 107, growth: 6, allowance: 5, exceeded: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			growth, allowance, _ := fleetScaleHeapGrowth(test.first, test.second)
			if growth != test.growth || allowance != test.allowance {
				t.Fatalf(
					"fleetScaleHeapGrowth(%d, %d) = (%d, %d), want (%d, %d)",
					test.first,
					test.second,
					growth,
					allowance,
					test.growth,
					test.allowance,
				)
			}
			if got := fleetScaleHeapGrowthExceedsLimit(growth, allowance); got != test.exceeded {
				t.Fatalf("heap growth exceeded = %t, want %t", got, test.exceeded)
			}
		})
	}
}
