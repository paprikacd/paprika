package fleet

import (
	"errors"
	"fmt"
	"runtime"
	"strconv"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSnapshotInitialLoadIsTypedUnavailable(t *testing.T) {
	t.Parallel()

	index := NewIndex()
	snapshot, err := index.LoadSnapshot()
	require.Nil(t, snapshot)
	require.Error(t, err)

	var unavailable *ErrUnavailable
	require.True(t, errors.As(err, &unavailable))
	require.NotEmpty(t, unavailable.Reason)
}

func TestSnapshotInstallNilDoesNotChangeSnapshotOrHealth(t *testing.T) {
	t.Parallel()

	index := NewIndex()
	require.Error(t, index.Install(nil))
	_, err := index.LoadSnapshot()
	require.Error(t, err)
	initialReadyErr := index.CheckReady()
	require.Error(t, initialReadyErr)

	builder := generationSnapshot(7)
	require.NoError(t, index.Install(builder))
	index.SetHealth(HealthState{Degraded: true, Reason: "last rebuild failed"})

	require.Error(t, index.Install(nil))
	installed, err := index.LoadSnapshot()
	require.NoError(t, err)
	require.Equal(t, uint64(7), installed.Generation)
	readyErr := index.CheckReady()
	require.ErrorContains(t, readyErr, "last rebuild failed")
}

func TestSnapshotInstallDeepClonesBuilderAndPreservesPriorSnapshots(t *testing.T) {
	t.Parallel()

	id := fleetID("apps", "checkout")
	project := fleetID("projects", "retail")
	cluster := fleetID("clusters", "production")
	builder := NewSnapshot(41)
	builder.Applications[id] = ApplicationSummary{
		Identity:       id,
		Project:        project,
		SourceRevision: "generation-41",
		Targets: []StageTargetSummary{{
			StableID: "target-1",
			Stage:    "production",
			Cluster:  cluster,
		}},
	}
	builder.Projects[project] = ProjectSummary{Identity: project}
	builder.ByProject[project] = idSet(id)
	builder.ByNamespace[id.Namespace] = idSet(id)
	builder.ByCluster[cluster] = idSet(id)
	builder.ByStage["production"] = idSet(id)
	builder.ByHealth[HealthHealthy] = idSet(id)
	builder.BySync[SyncStateSynced] = idSet(id)
	builder.ByRelease[ReleaseStateComplete] = idSet(id)
	builder.ByRollout[RolloutStateHealthy] = idSet(id)
	builder.BySourceType[SourceTypeGit] = idSet(id)

	index := NewIndex()
	require.NoError(t, index.Install(builder))
	first, err := index.LoadSnapshot()
	require.NoError(t, err)

	// Mutate the complete builder graph after publication, including the target
	// slice's backing array and every nested IDSet.
	builder.Generation = 99
	applicationRecord := builder.Applications[id]
	applicationRecord.SourceRevision = "mutated"
	applicationRecord.Targets[0].Stage = "mutated"
	builder.Applications[id] = applicationRecord
	delete(builder.Projects, project)
	delete(builder.ByProject[project], id)
	delete(builder.ByNamespace[id.Namespace], id)
	delete(builder.ByCluster[cluster], id)
	delete(builder.ByStage["production"], id)
	delete(builder.ByHealth[HealthHealthy], id)
	delete(builder.BySync[SyncStateSynced], id)
	delete(builder.ByRelease[ReleaseStateComplete], id)
	delete(builder.ByRollout[RolloutStateHealthy], id)
	delete(builder.BySourceType[SourceTypeGit], id)
	delete(builder.Applications, id)

	require.Equal(t, uint64(41), first.Generation)
	require.Equal(t, "generation-41", first.Applications[id].SourceRevision)
	require.Equal(t, "production", first.Applications[id].Targets[0].Stage)
	require.Equal(t, ProjectSummary{Identity: project}, first.Projects[project])
	requireSnapshotIndexesContain(t, first, id, project, cluster)
	matches, err := first.Search("checkout", idSet(id))
	require.NoError(t, err)
	require.Equal(t, []SearchMatch{{Identity: id, Tier: SearchTierExact}}, matches)

	secondBuilder := generationSnapshot(42)
	require.NoError(t, index.Install(secondBuilder))
	secondBuilder.Generation = 100
	secondRecord := secondBuilder.Applications[generationMarkerID]
	secondRecord.SourceRevision = "mutated-after-second-install"
	secondBuilder.Applications[generationMarkerID] = secondRecord

	second, err := index.LoadSnapshot()
	require.NoError(t, err)
	require.Equal(t, uint64(42), second.Generation)
	require.Equal(t, "42", second.Applications[generationMarkerID].SourceRevision)
	// Holding an old immutable pointer remains safe after a later swap.
	require.Equal(t, uint64(41), first.Generation)
	require.Equal(t, "generation-41", first.Applications[id].SourceRevision)
}

func TestSnapshotIDSetHelpersDoNotExposeInputMaps(t *testing.T) {
	t.Parallel()

	first := fleetID("a", "first")
	second := fleetID("a", "second")
	original := idSet(first, second)

	clone := original.Clone()
	delete(clone, first)
	require.Contains(t, original, first)

	intersection := original.Intersect(idSet(first))
	delete(intersection, first)
	require.Contains(t, original, first)
	require.Empty(t, IDSet(nil).Intersect(original))

	nilClone := IDSet(nil).Clone()
	require.NotNil(t, nilClone)
	nilClone[first] = struct{}{}
	require.Contains(t, nilClone, first)
}

func TestSnapshotInstallRebuildsAuthoritativeTrigramPostings(t *testing.T) {
	t.Parallel()

	app := application("apps", "checkout")
	builder := NewSnapshot(1)
	builder.Applications[app.Identity] = app
	builder.Trigrams["stale"] = idSet(app.Identity)

	index := NewIndex()
	require.NoError(t, index.Install(builder))
	installed, err := index.LoadSnapshot()
	require.NoError(t, err)
	require.NotContains(t, installed.Trigrams, "stale")
	require.Equal(t, idSet(app.Identity), installed.Trigrams["che"])

	delete(builder.Trigrams["stale"], app.Identity)
	require.Equal(t, idSet(app.Identity), installed.Trigrams["che"])
}

func TestSnapshotConcurrentSwapsRemainGenerationCoherent(t *testing.T) {
	index := NewIndex()
	require.NoError(t, index.Install(generationSnapshot(1)))

	const (
		readerCount = 4
		swapCount   = 1000
	)
	done := make(chan struct{})
	failures := make(chan error, readerCount)
	var readers sync.WaitGroup
	readers.Add(readerCount)
	for range readerCount {
		go func() {
			defer readers.Done()
			for {
				snapshot, err := index.LoadSnapshot()
				if err != nil {
					failures <- fmt.Errorf("load snapshot: %w", err)
					return
				}
				marker := strconv.FormatUint(snapshot.Generation, 10)
				if got := snapshot.Applications[generationMarkerID].SourceRevision; got != marker {
					failures <- fmt.Errorf("generation %d has application marker %q", snapshot.Generation, got)
					return
				}
				projectID := generationProjectID(marker)
				if got := snapshot.Projects[projectID].Identity; got != projectID {
					failures <- fmt.Errorf("generation %d has project marker %q", snapshot.Generation, got.Name)
					return
				}
				if _, ok := snapshot.ByStage[marker][generationMarkerID]; !ok {
					failures <- fmt.Errorf("generation %d is missing stage marker %q", snapshot.Generation, marker)
					return
				}

				select {
				case <-done:
					return
				default:
					runtime.Gosched()
				}
			}
		}()
	}

	for generation := uint64(2); generation <= swapCount+1; generation++ {
		require.NoError(t, index.Install(generationSnapshot(generation)))
		runtime.Gosched()
	}
	close(done)
	readers.Wait()
	close(failures)
	for failure := range failures {
		require.NoError(t, failure)
	}
}

func TestHealthInitialStateIsUnavailableAndCheckReadyUsesOnlyHealth(t *testing.T) {
	t.Parallel()

	index := NewIndex()
	err := index.CheckReady()
	require.Error(t, err)
	var unavailable *ErrUnavailable
	require.ErrorAs(t, err, &unavailable)
	require.NotEmpty(t, unavailable.Reason)

	// Readiness intentionally consults health only; snapshot serving has its own
	// availability contract through LoadSnapshot.
	index.SetHealth(HealthState{Ready: true})
	require.NoError(t, index.CheckReady())
	_, err = index.LoadSnapshot()
	require.ErrorAs(t, err, &unavailable)
}

func TestHealthDegradedStateRetainsSnapshotAndCanRecoverWithoutSwap(t *testing.T) {
	t.Parallel()

	index := NewIndex()
	require.NoError(t, index.Install(generationSnapshot(8)))
	require.NoError(t, index.CheckReady())

	index.SetHealth(HealthState{
		Ready:    false,
		Degraded: true,
		Reason:   "projection rebuild failed",
	})
	require.ErrorContains(t, index.CheckReady(), "projection rebuild failed")
	retained, err := index.LoadSnapshot()
	require.NoError(t, err)
	require.Equal(t, uint64(8), retained.Generation)

	index.SetHealth(HealthState{Ready: true})
	require.NoError(t, index.CheckReady())
	recovered, err := index.LoadSnapshot()
	require.NoError(t, err)
	require.Same(t, retained, recovered)
}

func TestHealthFirstInstallNeverReportsReadyBeforeSnapshotExists(t *testing.T) {
	t.Parallel()

	for range 1000 {
		index := NewIndex()
		observed := make(chan error, 1)
		go func() {
			for {
				if err := index.CheckReady(); err != nil {
					runtime.Gosched()
					continue
				}
				_, err := index.LoadSnapshot()
				observed <- err
				return
			}
		}()

		require.NoError(t, index.Install(generationSnapshot(1)))
		require.NoError(t, <-observed)
	}
}

var (
	generationMarkerID = fleetID("markers", "application")
)

func generationSnapshot(generation uint64) *Snapshot {
	marker := strconv.FormatUint(generation, 10)
	projectID := generationProjectID(marker)
	builder := NewSnapshot(generation)
	builder.Applications[generationMarkerID] = ApplicationSummary{
		Identity:       generationMarkerID,
		Project:        projectID,
		SourceRevision: marker,
		Targets: []StageTargetSummary{{
			StableID: marker,
			Stage:    marker,
		}},
	}
	builder.Projects[projectID] = ProjectSummary{
		Identity: projectID,
	}
	builder.ByStage[marker] = idSet(generationMarkerID)
	return builder
}

func generationProjectID(marker string) ProjectKey {
	return fleetID("markers", "project-"+marker)
}

func requireSnapshotIndexesContain(
	t *testing.T,
	snapshot *Snapshot,
	id, project, cluster ProjectKey,
) {
	t.Helper()

	require.Contains(t, snapshot.ByProject[project], id)
	require.Contains(t, snapshot.ByNamespace[id.Namespace], id)
	require.Contains(t, snapshot.ByCluster[cluster], id)
	require.Contains(t, snapshot.ByStage["production"], id)
	require.Contains(t, snapshot.ByHealth[HealthHealthy], id)
	require.Contains(t, snapshot.BySync[SyncStateSynced], id)
	require.Contains(t, snapshot.ByRelease[ReleaseStateComplete], id)
	require.Contains(t, snapshot.ByRollout[RolloutStateHealthy], id)
	require.Contains(t, snapshot.BySourceType[SourceTypeGit], id)
}
