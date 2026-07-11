package fleet

import (
	"math"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

const applicationNameLabel = "app.paprika.io/name"

func TestProjectApplicationIdentitySourceCountsHealthAndTransition(t *testing.T) {
	t.Parallel()

	earlier := metav1.NewTime(time.Unix(100, 123_000_000))
	later := metav1.NewTime(time.Unix(200, 456_000_000))
	app := projectionApplication("team-a", "checkout", "checkout-a")
	app.Spec.Project = "  "
	app.Spec.Source.Type = pipelinesv1alpha1.SourceTypeGit
	app.Spec.Source.Revision = "requested-main"
	app.Status.SourceRevision = "resolved-sha"
	app.Status.Health = pipelinesv1alpha1.HealthDegraded
	app.Status.Phase = pipelinesv1alpha1.ApplicationHealthy
	app.Status.Synced = true
	app.Status.OutOfSync = 2
	app.Status.Resources = []pipelinesv1alpha1.ResourceSync{
		{Status: "Missing"},
		{Status: "OutOfSync"},
		{Status: "Synced"},
	}
	app.Status.Gates = []pipelinesv1alpha1.GateStatus{
		{Status: pipelinesv1alpha1.GateStatusApproved},
		{Status: pipelinesv1alpha1.GateStatusPending},
		{Status: pipelinesv1alpha1.GateStatusRejected},
		{Status: "FutureStatus"},
	}
	app.Status.Conditions = []metav1.Condition{
		{Type: "Later", LastTransitionTime: later},
		{Type: "Earlier", LastTransitionTime: earlier},
	}

	summary, result := projectApplication(&projectionInput{application: app})

	require.Zero(t, result.ProjectionErrorCount)
	require.Equal(t, fleetID("team-a", "checkout"), summary.Identity)
	require.Equal(t, ProjectKey{Namespace: "team-a", Name: "default"}, summary.Project)
	require.Equal(t, SourceTypeGit, summary.SourceType)
	require.Equal(t, "resolved-sha", summary.SourceRevision)
	require.Equal(t, uint32(3), summary.ResourceCount)
	require.Equal(t, uint32(2), summary.DriftCount)
	require.Equal(t, uint32(1), summary.MissingResourceCount)
	require.Equal(t, SyncStateOutOfSync, summary.Sync)
	require.Equal(t, HealthDegraded, summary.Health, "recognized status health must win over phase")
	require.Equal(t, uint32(3), summary.BlockedGateCount)
	require.Equal(t, later.UnixMilli(), summary.LastTransitionUnixMS)

	otherNamespace := app.DeepCopy()
	otherNamespace.Namespace = "team-b"
	otherNamespace.UID = types.UID("checkout-b")
	otherSummary, otherResult := projectApplication(&projectionInput{application: otherNamespace})
	require.Zero(t, otherResult.ProjectionErrorCount)
	require.NotEqual(t, summary.Identity, otherSummary.Identity)
	require.Equal(t, ProjectKey{Namespace: "team-b", Name: "default"}, otherSummary.Project)
}

func TestProjectApplicationLastTransitionUsesMaximumBeforeUnixEpoch(t *testing.T) {
	t.Parallel()

	app := projectionApplication("apps", "time-traveler", "time-traveler-uid")
	latest := metav1.NewTime(time.Unix(-10, 0))
	app.Status.Conditions = []metav1.Condition{
		{Type: "Older", LastTransitionTime: metav1.NewTime(time.Unix(-20, 0))},
		{Type: "Latest", LastTransitionTime: latest},
	}

	summary, result := projectApplication(&projectionInput{application: app})
	require.Zero(t, result.ProjectionErrorCount)
	require.Equal(t, latest.UnixMilli(), summary.LastTransitionUnixMS)
}

func TestProjectApplicationLastTransitionIgnoresZeroTimes(t *testing.T) {
	t.Parallel()

	app := projectionApplication("apps", "zero-time", "zero-time-uid")
	app.Status.Conditions = []metav1.Condition{
		{Type: "Unset"},
		{Type: "AlsoUnset"},
	}
	summary, result := projectApplication(&projectionInput{application: app})
	require.Zero(t, result.ProjectionErrorCount)
	require.Zero(t, summary.LastTransitionUnixMS)
}

func TestProjectApplicationExplicitMappingsAndSafeCounts(t *testing.T) {
	t.Parallel()

	sourceCases := []struct {
		raw  string
		want SourceType
	}{
		{pipelinesv1alpha1.SourceTypeGit, SourceTypeGit},
		{pipelinesv1alpha1.SourceTypeHelm, SourceTypeHelm},
		{pipelinesv1alpha1.SourceTypeKustomize, SourceTypeKustomize},
		{pipelinesv1alpha1.SourceTypeS3, SourceTypeS3},
		{pipelinesv1alpha1.SourceTypeOCI, SourceTypeOCI},
		{pipelinesv1alpha1.SourceTypeInline, SourceTypeInline},
		{"future-source", SourceTypeUnspecified},
		{"", SourceTypeUnspecified},
	}
	for _, test := range sourceCases {
		t.Run("source_"+test.raw, func(t *testing.T) {
			app := projectionApplication("apps", "source", "source-uid")
			app.Spec.Source.Type = test.raw
			summary, result := projectApplication(&projectionInput{application: app})
			require.Zero(t, result.ProjectionErrorCount)
			require.Equal(t, test.want, summary.SourceType)
		})
	}

	healthCases := []struct {
		health pipelinesv1alpha1.HealthStatus
		phase  pipelinesv1alpha1.ApplicationPhase
		want   Health
	}{
		{pipelinesv1alpha1.HealthHealthy, pipelinesv1alpha1.ApplicationFailed, HealthHealthy},
		{pipelinesv1alpha1.HealthProgressing, "", HealthProgressing},
		{pipelinesv1alpha1.HealthDegraded, "", HealthDegraded},
		{pipelinesv1alpha1.HealthUnknown, pipelinesv1alpha1.ApplicationHealthy, HealthUnknown},
		{"future-health", pipelinesv1alpha1.ApplicationHealthy, HealthHealthy},
		{"", pipelinesv1alpha1.ApplicationPending, HealthProgressing},
		{"", pipelinesv1alpha1.ApplicationBuilding, HealthProgressing},
		{"", pipelinesv1alpha1.ApplicationPromoting, HealthProgressing},
		{"", pipelinesv1alpha1.ApplicationCanarying, HealthProgressing},
		{"", pipelinesv1alpha1.ApplicationVerifying, HealthProgressing},
		{"", pipelinesv1alpha1.ApplicationDegraded, HealthDegraded},
		{"", pipelinesv1alpha1.ApplicationRolledBack, HealthDegraded},
		{"", pipelinesv1alpha1.ApplicationFailed, HealthFailed},
		{"", "future-phase", HealthUnknown},
	}
	for i, test := range healthCases {
		t.Run("health_"+strconv.Itoa(i), func(t *testing.T) {
			app := projectionApplication("apps", "health", "health-uid")
			app.Status.Health = test.health
			app.Status.Phase = test.phase
			summary, _ := projectApplication(&projectionInput{application: app})
			require.Equal(t, test.want, summary.Health)
		})
	}

	countCases := []struct {
		name string
		raw  int
		want uint32
	}{
		{"negative", -1, 0},
		{"zero", 0, 0},
		{"positive", 9, 9},
	}
	if strconv.IntSize > 32 {
		countCases = append(countCases, struct {
			name string
			raw  int
			want uint32
		}{"overflow", int(uint64(math.MaxUint32) + 1), math.MaxUint32})
	}
	for _, test := range countCases {
		t.Run("count_"+test.name, func(t *testing.T) {
			app := projectionApplication("apps", "count", "count-uid")
			app.Status.OutOfSync = test.raw
			app.Status.Synced = true
			summary, _ := projectApplication(&projectionInput{application: app})
			require.Equal(t, test.want, summary.DriftCount)
			if test.want > 0 {
				require.Equal(t, SyncStateOutOfSync, summary.Sync)
			} else {
				require.Equal(t, SyncStateSynced, summary.Sync)
			}
		})
	}

	unknownSync := projectionApplication("apps", "unknown-sync", "unknown-sync-uid")
	unknownSync.Status.Synced = false
	summary, _ := projectApplication(&projectionInput{application: unknownSync})
	require.Equal(t, SyncStateUnknown, summary.Sync)
}

func TestProjectStageValidatedTargetsPairStageAndClusterDeterministically(t *testing.T) {
	t.Parallel()

	app := projectionApplication("apps", "checkout", "app-uid")
	app.Spec.Stages = []pipelinesv1alpha1.ApplicationPromotionStage{
		{Name: "prod", Ring: 20},
		{Name: "dev", Ring: 10},
	}
	app.Status.Stages = []pipelinesv1alpha1.ApplicationStageStatus{
		{Name: "dev", Phase: "Complete"},
		{Name: "prod", Phase: "Canarying"},
	}
	app.Status.CurrentStage = "prod"
	dev := projectionStage(app, "checkout-dev-runtime", "stage-dev", "dev", 10, pipelinesv1alpha1.ClusterRef{
		Name: "dev-cluster",
	})
	prod := projectionStage(app, "checkout-prod-runtime", "stage-prod", "prod", 20, pipelinesv1alpha1.ClusterRef{
		Name:      "prod-cluster",
		Namespace: "shared-clusters",
	})
	summary, result := projectApplication(&projectionInput{
		application: app,
		stages:      []*pipelinesv1alpha1.Stage{prod, dev},
	})

	require.Zero(t, result.ProjectionErrorCount)
	require.Equal(t, []StageTargetSummary{
		{
			StableID:          "stage-dev",
			Stage:             "dev",
			Ring:              10,
			Cluster:           fleetID("apps", "dev-cluster"),
			ClusterLabel:      "dev-cluster",
			Health:            HealthHealthy,
			ClusterConnection: ConnectionStateUnhealthy,
		},
		{
			StableID:          "stage-prod",
			Stage:             "prod",
			Ring:              20,
			Cluster:           fleetID("shared-clusters", "prod-cluster"),
			ClusterLabel:      "prod-cluster",
			Health:            HealthProgressing,
			ClusterConnection: ConnectionStateUnhealthy,
		},
	}, summary.Targets)
	require.Equal(t, "prod", summary.CurrentStage)
	require.Equal(t, fleetID("shared-clusters", "prod-cluster"), summary.CurrentCluster)
	require.Equal(t, "prod-cluster", summary.CurrentClusterLabel)
}

func TestProjectStageInlineTargetNeverAliasesNamedCluster(t *testing.T) {
	t.Parallel()

	app := projectionApplication("apps", "inline", "inline-app-uid")
	app.Spec.Stages = []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "default", Ring: 1}}
	app.Status.Stages = []pipelinesv1alpha1.ApplicationStageStatus{{Name: "default", Phase: "mystery"}}
	stage := projectionStage(app, "inline-default", "inline-stage-uid", "default", 1, pipelinesv1alpha1.ClusterRef{
		Mode: pipelinesv1alpha1.ClusterModeInCluster,
	})

	summary, result := projectApplication(&projectionInput{
		application: app,
		stages:      []*pipelinesv1alpha1.Stage{stage},
	})

	require.Zero(t, result.ProjectionErrorCount)
	require.Len(t, summary.Targets, 1)
	require.Equal(t, ClusterKey{}, summary.Targets[0].Cluster)
	require.NotEmpty(t, summary.Targets[0].ClusterLabel)
	require.True(t, summary.Targets[0].UnmanagedInlineCluster)
	require.Equal(t, HealthUnknown, summary.Targets[0].Health)
}

func TestProjectStageRejectsAmbiguousOrUnauthorizedAssociationsOnce(t *testing.T) {
	app := projectionApplication("apps", "checkout", "app-uid")
	app.Spec.Stages = []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}}
	valid := projectionStage(app, "runtime-prod", "stage-uid", "prod", 1, pipelinesv1alpha1.ClusterRef{Name: "prod"})

	tests := []struct {
		name   string
		mutate func(*pipelinesv1alpha1.Stage, *pipelinesv1alpha1.Application)
	}{
		{"different namespace", func(stage *pipelinesv1alpha1.Stage, _ *pipelinesv1alpha1.Application) { stage.Namespace = "other" }},
		{"missing controller", func(stage *pipelinesv1alpha1.Stage, _ *pipelinesv1alpha1.Application) { stage.OwnerReferences = nil }},
		{"multiple controllers", func(stage *pipelinesv1alpha1.Stage, _ *pipelinesv1alpha1.Application) {
			stage.OwnerReferences = append(stage.OwnerReferences, stage.OwnerReferences[0])
		}},
		{"wrong owner group version", func(stage *pipelinesv1alpha1.Stage, _ *pipelinesv1alpha1.Application) {
			stage.OwnerReferences[0].APIVersion = "pipelines.paprika.io/v2"
		}},
		{"wrong owner kind", func(stage *pipelinesv1alpha1.Stage, _ *pipelinesv1alpha1.Application) {
			stage.OwnerReferences[0].Kind = "ApplicationSet"
		}},
		{"empty owner uid", func(stage *pipelinesv1alpha1.Stage, _ *pipelinesv1alpha1.Application) {
			stage.OwnerReferences[0].UID = ""
		}},
		{"wrong owner uid", func(stage *pipelinesv1alpha1.Stage, _ *pipelinesv1alpha1.Application) {
			stage.OwnerReferences[0].UID = "other"
		}},
		{"wrong owner name", func(stage *pipelinesv1alpha1.Stage, _ *pipelinesv1alpha1.Application) {
			stage.OwnerReferences[0].Name = "other"
		}},
		{"missing app label", func(stage *pipelinesv1alpha1.Stage, _ *pipelinesv1alpha1.Application) {
			delete(stage.Labels, applicationNameLabel)
		}},
		{"wrong app label", func(stage *pipelinesv1alpha1.Stage, _ *pipelinesv1alpha1.Application) {
			stage.Labels[applicationNameLabel] = "other"
		}},
		{"unknown logical stage", func(stage *pipelinesv1alpha1.Stage, _ *pipelinesv1alpha1.Application) { stage.Spec.Name = "other" }},
		{"duplicate logical stage", func(_ *pipelinesv1alpha1.Stage, app *pipelinesv1alpha1.Application) {
			app.Spec.Stages = append(app.Spec.Stages, app.Spec.Stages[0])
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid.DeepCopy()
			candidateApp := app.DeepCopy()
			test.mutate(candidate, candidateApp)
			summary, result := projectApplication(&projectionInput{
				application: candidateApp,
				stages:      []*pipelinesv1alpha1.Stage{candidate},
			})
			require.Empty(t, summary.Targets)
			require.Equal(t, uint64(1), result.ProjectionErrorCount)
		})
	}
}

func TestProjectReleaseUsesOnlyCurrentValidatedReleaseAndResolvesRuntimeStage(t *testing.T) {
	t.Parallel()

	app := projectionApplication("apps", "checkout", "app-uid")
	app.Spec.Stages = []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}}
	app.Status.ReleaseRef = "release-current"
	stage := projectionStage(app, "runtime-prod", "stage-uid", "prod", 1, pipelinesv1alpha1.ClusterRef{Name: "prod-cluster"})
	historical := projectionRelease(app, "release-old", "release-old-uid", pipelinesv1alpha1.ReleaseFailed)
	current := projectionRelease(app, "release-current", "release-current-uid", pipelinesv1alpha1.ReleaseVerifying)
	current.Status.CurrentStage = stage.Name

	summary, result := projectApplication(&projectionInput{
		application: app,
		stages:      []*pipelinesv1alpha1.Stage{stage},
		releases:    []*pipelinesv1alpha1.Release{historical, current},
	})

	require.Zero(t, result.ProjectionErrorCount)
	require.Equal(t, ReleaseStateVerifying, summary.ReleaseState)
	require.Equal(t, "prod", summary.CurrentStage, "runtime Stage CR names must not leak as logical stage names")
	require.Equal(t, fleetID("apps", "prod-cluster"), summary.CurrentCluster)
}

func TestProjectReleaseIgnoresSameNamedReleaseInAnotherNamespace(t *testing.T) {
	t.Parallel()

	app := projectionApplication("apps", "checkout", "app-uid")
	app.Status.ReleaseRef = "release-current"
	current := projectionRelease(app, "release-current", "current-uid", pipelinesv1alpha1.ReleaseComplete)
	otherNamespace := current.DeepCopy()
	otherNamespace.Namespace = "other"
	otherNamespace.UID = "other-uid"

	summary, result := projectApplication(&projectionInput{
		application: app,
		releases:    []*pipelinesv1alpha1.Release{otherNamespace, current},
	})
	require.Zero(t, result.ProjectionErrorCount)
	require.Equal(t, ReleaseStateComplete, summary.ReleaseState)
}

//nolint:dupl // Release and Rollout tables intentionally prove parallel association rules.
func TestProjectReleaseMapsKnownStatesAndRejectsInvalidCurrentAssociationOnce(t *testing.T) {
	t.Parallel()

	phaseCases := []struct {
		phase pipelinesv1alpha1.ReleasePhase
		want  ReleaseState
	}{
		{"", ReleaseStateUnspecified},
		{pipelinesv1alpha1.ReleasePending, ReleaseStatePending},
		{pipelinesv1alpha1.ReleasePromoting, ReleaseStatePromoting},
		{pipelinesv1alpha1.ReleaseCanarying, ReleaseStateCanarying},
		{pipelinesv1alpha1.ReleaseVerifying, ReleaseStateVerifying},
		{pipelinesv1alpha1.ReleaseComplete, ReleaseStateComplete},
		{pipelinesv1alpha1.ReleaseFailed, ReleaseStateFailed},
		{pipelinesv1alpha1.ReleaseRolledBack, ReleaseStateRolledBack},
		{pipelinesv1alpha1.ReleaseSuperseded, ReleaseStateSuperseded},
		{pipelinesv1alpha1.ReleaseAwaitingApproval, ReleaseStateAwaitingApproval},
		{"Future", ReleaseStateUnspecified},
	}
	for _, test := range phaseCases {
		app := projectionApplication("apps", "checkout", "app-uid")
		app.Status.ReleaseRef = "release"
		release := projectionRelease(app, "release", "release-uid", test.phase)
		summary, result := projectApplication(&projectionInput{application: app, releases: []*pipelinesv1alpha1.Release{release}})
		require.Zero(t, result.ProjectionErrorCount)
		require.Equal(t, test.want, summary.ReleaseState)
	}

	app := projectionApplication("apps", "checkout", "app-uid")
	app.Status.ReleaseRef = "release"
	valid := projectionRelease(app, "release", "release-uid", pipelinesv1alpha1.ReleaseComplete)
	tests := []struct {
		name   string
		mutate func(*pipelinesv1alpha1.Release)
	}{
		{"namespace", func(release *pipelinesv1alpha1.Release) { release.Namespace = "other" }},
		{"missing controller", func(release *pipelinesv1alpha1.Release) { release.OwnerReferences = nil }},
		{"multiple controllers", func(release *pipelinesv1alpha1.Release) {
			release.OwnerReferences = append(release.OwnerReferences, release.OwnerReferences[0])
		}},
		{"owner group version", func(release *pipelinesv1alpha1.Release) {
			release.OwnerReferences[0].APIVersion = "pipelines.paprika.io/v2"
		}},
		{"owner kind", func(release *pipelinesv1alpha1.Release) { release.OwnerReferences[0].Kind = "Stage" }},
		{"owner name", func(release *pipelinesv1alpha1.Release) { release.OwnerReferences[0].Name = "other" }},
		{"empty owner uid", func(release *pipelinesv1alpha1.Release) { release.OwnerReferences[0].UID = "" }},
		{"owner uid", func(release *pipelinesv1alpha1.Release) { release.OwnerReferences[0].UID = "other" }},
		{"missing label", func(release *pipelinesv1alpha1.Release) { delete(release.Labels, applicationNameLabel) }},
		{"label", func(release *pipelinesv1alpha1.Release) { release.Labels[applicationNameLabel] = "other" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid.DeepCopy()
			test.mutate(candidate)
			summary, result := projectApplication(&projectionInput{application: app, releases: []*pipelinesv1alpha1.Release{candidate}})
			require.Equal(t, ReleaseStateUnspecified, summary.ReleaseState)
			require.Equal(t, uint64(1), result.ProjectionErrorCount)
		})
	}
}

func TestProjectRolloutUsesOnlyCurrentValidatedRolloutAndMapsKnownStates(t *testing.T) {
	t.Parallel()

	phaseCases := []struct {
		phase rolloutsv1alpha1.RolloutPhase
		want  RolloutState
	}{
		{"", RolloutStateUnspecified},
		{rolloutsv1alpha1.RolloutPhasePending, RolloutStatePending},
		{rolloutsv1alpha1.RolloutPhaseProgressing, RolloutStateProgressing},
		{rolloutsv1alpha1.RolloutPhasePaused, RolloutStatePaused},
		{rolloutsv1alpha1.RolloutPhaseHealthy, RolloutStateHealthy},
		{rolloutsv1alpha1.RolloutPhaseDegraded, RolloutStateDegraded},
		{rolloutsv1alpha1.RolloutPhaseFailed, RolloutStateFailed},
		{rolloutsv1alpha1.RolloutPhaseRolledBack, RolloutStateRolledBack},
		{rolloutsv1alpha1.RolloutPhaseAborted, RolloutStateAborted},
		{"Future", RolloutStateUnspecified},
	}
	for _, test := range phaseCases {
		app := projectionApplication("apps", "checkout", "app-uid")
		app.Status.ReleaseRef = "release"
		release := projectionRelease(app, "release", "release-uid", pipelinesv1alpha1.ReleasePromoting)
		release.Status.RolloutRef = "rollout"
		historical := projectionRollout(app, release, "historical", "historical-uid", rolloutsv1alpha1.RolloutPhaseFailed)
		current := projectionRollout(app, release, "rollout", "rollout-uid", test.phase)
		summary, result := projectApplication(&projectionInput{
			application: app,
			releases:    []*pipelinesv1alpha1.Release{release},
			rollouts:    []*rolloutsv1alpha1.Rollout{historical, current},
		})
		require.Zero(t, result.ProjectionErrorCount)
		require.Equal(t, test.want, summary.RolloutState)
	}
}

func TestProjectRolloutIgnoresSameNamedRolloutInAnotherNamespace(t *testing.T) {
	t.Parallel()

	app := projectionApplication("apps", "checkout", "app-uid")
	app.Status.ReleaseRef = "release"
	release := projectionRelease(app, "release", "release-uid", pipelinesv1alpha1.ReleasePromoting)
	release.Status.RolloutRef = "rollout"
	current := projectionRollout(app, release, "rollout", "rollout-uid", rolloutsv1alpha1.RolloutPhaseHealthy)
	otherNamespace := current.DeepCopy()
	otherNamespace.Namespace = "other"
	otherNamespace.UID = "other-rollout-uid"

	summary, result := projectApplication(&projectionInput{
		application: app,
		releases:    []*pipelinesv1alpha1.Release{release},
		rollouts:    []*rolloutsv1alpha1.Rollout{otherNamespace, current},
	})
	require.Zero(t, result.ProjectionErrorCount)
	require.Equal(t, RolloutStateHealthy, summary.RolloutState)
}

//nolint:dupl // Release and Rollout tables intentionally prove parallel association rules.
func TestProjectRolloutRejectsInvalidCurrentChainOnce(t *testing.T) {
	app := projectionApplication("apps", "checkout", "app-uid")
	app.Status.ReleaseRef = "release"
	release := projectionRelease(app, "release", "release-uid", pipelinesv1alpha1.ReleasePromoting)
	release.Status.RolloutRef = "rollout"
	valid := projectionRollout(app, release, "rollout", "rollout-uid", rolloutsv1alpha1.RolloutPhaseHealthy)

	tests := []struct {
		name   string
		mutate func(*rolloutsv1alpha1.Rollout)
	}{
		{"namespace", func(rollout *rolloutsv1alpha1.Rollout) { rollout.Namespace = "other" }},
		{"missing controller", func(rollout *rolloutsv1alpha1.Rollout) { rollout.OwnerReferences = nil }},
		{"multiple controllers", func(rollout *rolloutsv1alpha1.Rollout) {
			rollout.OwnerReferences = append(rollout.OwnerReferences, rollout.OwnerReferences[0])
		}},
		{"owner group version", func(rollout *rolloutsv1alpha1.Rollout) {
			rollout.OwnerReferences[0].APIVersion = "pipelines.paprika.io/v2"
		}},
		{"owner kind", func(rollout *rolloutsv1alpha1.Rollout) { rollout.OwnerReferences[0].Kind = "Application" }},
		{"owner name", func(rollout *rolloutsv1alpha1.Rollout) { rollout.OwnerReferences[0].Name = "other" }},
		{"empty owner uid", func(rollout *rolloutsv1alpha1.Rollout) { rollout.OwnerReferences[0].UID = "" }},
		{"owner uid", func(rollout *rolloutsv1alpha1.Rollout) { rollout.OwnerReferences[0].UID = "other" }},
		{"missing label", func(rollout *rolloutsv1alpha1.Rollout) { delete(rollout.Labels, applicationNameLabel) }},
		{"label", func(rollout *rolloutsv1alpha1.Rollout) { rollout.Labels[applicationNameLabel] = "other" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid.DeepCopy()
			test.mutate(candidate)
			summary, result := projectApplication(&projectionInput{
				application: app,
				releases:    []*pipelinesv1alpha1.Release{release},
				rollouts:    []*rolloutsv1alpha1.Rollout{candidate},
			})
			require.Equal(t, RolloutStateUnspecified, summary.RolloutState)
			require.Equal(t, uint64(1), result.ProjectionErrorCount)
		})
	}
}

func TestProjectAppProjectInstallDeletePreservesDeclaredApplicationMembership(t *testing.T) {
	t.Parallel()

	snapshot := NewSnapshot(1)
	firstID := fleetID("tenant-a", "checkout")
	secondID := fleetID("tenant-b", "checkout")
	firstProject := fleetID("tenant-a", "retail")
	secondProject := fleetID("tenant-b", "retail")
	snapshot.Applications[firstID] = ApplicationSummary{Identity: firstID, Project: firstProject}
	snapshot.Applications[secondID] = ApplicationSummary{Identity: secondID, Project: secondProject}
	snapshot.ByProject[firstProject] = idSet(firstID)
	snapshot.ByProject[secondProject] = idSet(secondID)

	firstResult := UpsertProject(snapshot, &corev1alpha1.AppProject{ObjectMeta: metav1.ObjectMeta{Namespace: firstProject.Namespace, Name: firstProject.Name}})
	secondResult := UpsertProject(snapshot, &corev1alpha1.AppProject{ObjectMeta: metav1.ObjectMeta{Namespace: secondProject.Namespace, Name: secondProject.Name}})
	require.True(t, firstResult.Changed)
	require.True(t, secondResult.Changed)
	require.Equal(t, ProjectSummary{Identity: firstProject}, snapshot.Projects[firstProject])
	require.Equal(t, ProjectSummary{Identity: secondProject}, snapshot.Projects[secondProject])

	deleteResult := DeleteProject(snapshot, firstProject)
	require.True(t, deleteResult.Changed)
	require.NotContains(t, snapshot.Projects, firstProject)
	require.Contains(t, snapshot.Projects, secondProject)
	require.Equal(t, firstProject, snapshot.Applications[firstID].Project)
	require.Equal(t, idSet(firstID), snapshot.ByProject[firstProject])
	require.Equal(t, idSet(secondID), snapshot.ByProject[secondProject])
}

func projectionApplication(namespace, name, uid string) *pipelinesv1alpha1.Application {
	return &pipelinesv1alpha1.Application{
		TypeMeta: metav1.TypeMeta{
			APIVersion: pipelinesv1alpha1.GroupVersion.String(),
			Kind:       "Application",
		},
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name, UID: types.UID(uid)},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: "default",
		},
	}
}

func projectionStage(
	app *pipelinesv1alpha1.Application,
	name, uid, logicalName string,
	ring int,
	clusterRef pipelinesv1alpha1.ClusterRef,
) *pipelinesv1alpha1.Stage {
	return &pipelinesv1alpha1.Stage{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: app.Namespace,
			Name:      name,
			UID:       types.UID(uid),
			Labels:    map[string]string{applicationNameLabel: app.Name},
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: pipelinesv1alpha1.GroupVersion.String(),
				Kind:       "Application",
				Name:       app.Name,
				UID:        app.UID,
				Controller: boolPointer(true),
			}},
		},
		Spec: pipelinesv1alpha1.StageSpec{Name: logicalName, Ring: ring, Cluster: clusterRef},
	}
}

func projectionRelease(
	app *pipelinesv1alpha1.Application,
	name, uid string,
	phase pipelinesv1alpha1.ReleasePhase,
) *pipelinesv1alpha1.Release {
	return &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: app.Namespace,
			Name:      name,
			UID:       types.UID(uid),
			Labels:    map[string]string{applicationNameLabel: app.Name},
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: pipelinesv1alpha1.GroupVersion.String(),
				Kind:       "Application",
				Name:       app.Name,
				UID:        app.UID,
				Controller: boolPointer(true),
			}},
		},
		Status: pipelinesv1alpha1.ReleaseStatus{Phase: phase},
	}
}

func projectionRollout(
	app *pipelinesv1alpha1.Application,
	release *pipelinesv1alpha1.Release,
	name, uid string,
	phase rolloutsv1alpha1.RolloutPhase,
) *rolloutsv1alpha1.Rollout {
	return &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: app.Namespace,
			Name:      name,
			UID:       types.UID(uid),
			Labels:    map[string]string{applicationNameLabel: app.Name},
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: pipelinesv1alpha1.GroupVersion.String(),
				Kind:       "Release",
				Name:       release.Name,
				UID:        release.UID,
				Controller: boolPointer(true),
			}},
		},
		Status: rolloutsv1alpha1.RolloutStatus{Phase: phase},
	}
}

func cluster(namespace, name, displayName string, phase clustersv1alpha1.ClusterPhase) *clustersv1alpha1.Cluster {
	return &clustersv1alpha1.Cluster{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec:       clustersv1alpha1.ClusterSpec{DisplayName: displayName},
		Status:     clustersv1alpha1.ClusterStatus{Phase: phase},
	}
}

func boolPointer(value bool) *bool {
	return &value
}
