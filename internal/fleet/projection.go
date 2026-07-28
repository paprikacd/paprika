package fleet

import (
	"math"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

const (
	defaultProjectName     = "default"
	projectionAppNameLabel = "app.paprika.io/name"
	applicationOwnerKind   = "Application"
	releaseOwnerKind       = "Release"
	inlineClusterLabel     = "In-cluster"
)

// ProjectionResult reports data-quality outcomes separately from fatal store
// errors. Association failures fail closed and are counted without exposing
// object contents or source configuration.
type ProjectionResult struct {
	Changed              bool
	ProjectionErrorCount uint64
}

// projectionInput is a complete, cache-derived input for one Application. It
// is deliberately package-private so Kubernetes objects never escape into the
// provider-neutral Snapshot model.
type projectionInput struct {
	application             *pipelinesv1alpha1.Application
	project                 *corev1alpha1.AppProject
	stages                  []*pipelinesv1alpha1.Stage
	releases                []*pipelinesv1alpha1.Release
	rollouts                []*rolloutsv1alpha1.Rollout
	repositories            map[RepositoryKey]RepositorySummary
	clusters                map[ClusterKey]ClusterSummary
	sources                 map[SourceKey]SourceSummary
	optionalSourceProjector OptionalSourceProjector
}

//nolint:cyclop // each optional child association is validated independently.
func projectApplication(input *projectionInput) (ApplicationSummary, ProjectionResult) {
	app := input.application
	if app == nil {
		return ApplicationSummary{}, ProjectionResult{ProjectionErrorCount: 1}
	}

	id := types.NamespacedName{Namespace: app.Namespace, Name: app.Name}
	summary := ApplicationSummary{
		Identity:             id,
		Project:              declaredProject(app),
		SourceType:           mapSourceType(app.Spec.Source.Type),
		SourceRevision:       app.Status.SourceRevision,
		Health:               mapApplicationHealth(app.Status.Health, app.Status.Phase),
		DriftCount:           clampUint32(app.Status.OutOfSync),
		ResourceCount:        lengthUint32(len(app.Status.Resources)),
		MissingResourceCount: countMissingResources(app.Status.Resources),
		BlockedGateCount:     countBlockedGates(app.Status.Gates),
		LastTransitionUnixMS: latestConditionUnixMS(app.Status.Conditions),
	}
	summary.Sync = mapSyncState(summary.DriftCount, app.Status.Synced)
	summary.Repository, summary.RepositoryConnection = projectRepositoryConnection(app, input.repositories)
	result := ProjectionResult{Changed: true}
	validStages := make(map[string]*pipelinesv1alpha1.Stage)
	validatedStages := make([]*pipelinesv1alpha1.Stage, 0, len(input.stages))
	for _, stage := range input.stages {
		if !validStageAssociation(stage, app) {
			result.ProjectionErrorCount++
			continue
		}
		target, invalidConnection := projectStageConnection(stage, app, input.clusters)
		if invalidConnection {
			result.ProjectionErrorCount++
		}
		summary.Targets = append(summary.Targets, target)
		validStages[stage.Name] = stage
		validatedStages = append(validatedStages, stage)
	}
	sortStageTargets(summary.Targets)
	sortProjectionStages(validatedStages)
	optionalResult := projectOptionalSourceBinding(
		&summary,
		app,
		input.project,
		validatedStages,
		input.optionalSourceProjector,
		input.sources,
	)
	result.ProjectionErrorCount += optionalResult.ProjectionErrorCount

	currentRelease, releaseFound, releaseAmbiguous := findCurrentRelease(app, input.releases)
	if releaseAmbiguous {
		result.ProjectionErrorCount++
	} else if releaseFound {
		if !validReleaseAssociation(currentRelease, app) {
			result.ProjectionErrorCount++
		} else {
			summary.ReleaseState = mapReleaseState(currentRelease.Status.Phase)
			projectCurrentRollout(&summary, &result, app, currentRelease, input.rollouts)
		}
	}

	summary.CurrentStage = app.Status.CurrentStage
	if summary.CurrentStage == "" && releaseFound && !releaseAmbiguous && validReleaseAssociation(currentRelease, app) {
		if stage := validStages[currentRelease.Status.CurrentStage]; stage != nil {
			summary.CurrentStage = stage.Spec.Name
		}
	}
	for i := range summary.Targets {
		if summary.Targets[i].Stage == summary.CurrentStage {
			summary.CurrentCluster = summary.Targets[i].Cluster
			summary.CurrentClusterLabel = summary.Targets[i].ClusterLabel
			break
		}
	}

	return summary, result
}

func sortProjectionStages(stages []*pipelinesv1alpha1.Stage) {
	sort.Slice(stages, func(i, j int) bool {
		if stages[i].Spec.Ring != stages[j].Spec.Ring {
			return stages[i].Spec.Ring < stages[j].Spec.Ring
		}
		if stages[i].Spec.Name != stages[j].Spec.Name {
			return stages[i].Spec.Name < stages[j].Spec.Name
		}
		if stages[i].Namespace != stages[j].Namespace {
			return stages[i].Namespace < stages[j].Namespace
		}
		return stages[i].Name < stages[j].Name
	})
}

func declaredProject(app *pipelinesv1alpha1.Application) ProjectKey {
	name := app.Spec.Project
	if strings.TrimSpace(name) == "" {
		name = defaultProjectName
	}
	return ProjectKey{Namespace: app.Namespace, Name: name}
}

func mapSourceType(source string) SourceType {
	switch source {
	case pipelinesv1alpha1.SourceTypeGit:
		return SourceTypeGit
	case pipelinesv1alpha1.SourceTypeHelm:
		return SourceTypeHelm
	case pipelinesv1alpha1.SourceTypeKustomize:
		return SourceTypeKustomize
	case pipelinesv1alpha1.SourceTypeS3:
		return SourceTypeS3
	case pipelinesv1alpha1.SourceTypeOCI:
		return SourceTypeOCI
	case pipelinesv1alpha1.SourceTypeInline:
		return SourceTypeInline
	default:
		return SourceTypeUnspecified
	}
}

func mapApplicationHealth(status pipelinesv1alpha1.HealthStatus, phase pipelinesv1alpha1.ApplicationPhase) Health {
	switch status {
	case pipelinesv1alpha1.HealthHealthy:
		return HealthHealthy
	case pipelinesv1alpha1.HealthProgressing:
		return HealthProgressing
	case pipelinesv1alpha1.HealthDegraded:
		return HealthDegraded
	case pipelinesv1alpha1.HealthUnknown:
		return HealthUnknown
	}

	switch phase {
	case pipelinesv1alpha1.ApplicationHealthy:
		return HealthHealthy
	case pipelinesv1alpha1.ApplicationPending,
		pipelinesv1alpha1.ApplicationBuilding,
		pipelinesv1alpha1.ApplicationPromoting,
		pipelinesv1alpha1.ApplicationCanarying,
		pipelinesv1alpha1.ApplicationVerifying:
		return HealthProgressing
	case pipelinesv1alpha1.ApplicationDegraded, pipelinesv1alpha1.ApplicationRolledBack:
		return HealthDegraded
	case pipelinesv1alpha1.ApplicationFailed:
		return HealthFailed
	default:
		return HealthUnknown
	}
}

func mapSyncState(drift uint32, synced bool) SyncState {
	if drift > 0 {
		return SyncStateOutOfSync
	}
	if synced {
		return SyncStateSynced
	}
	return SyncStateUnknown
}

func clampUint32(value int) uint32 {
	if value <= 0 {
		return 0
	}
	converted := int64(value)
	if converted > int64(math.MaxUint32) {
		return math.MaxUint32
	}
	return uint32(converted) // #nosec G115 -- converted is explicitly bounded to uint32.
}

func lengthUint32(value int) uint32 {
	if value <= 0 {
		return 0
	}
	converted := int64(value)
	if converted > int64(math.MaxUint32) {
		return math.MaxUint32
	}
	return uint32(converted) // #nosec G115 -- lengths are nonnegative and explicitly bounded.
}

func countMissingResources(resources []pipelinesv1alpha1.ResourceSync) uint32 {
	var count uint32
	for i := range resources {
		if resources[i].Status == "Missing" && count < math.MaxUint32 {
			count++
		}
	}
	return count
}

func countBlockedGates(gates []pipelinesv1alpha1.GateStatus) uint32 {
	var count uint32
	for i := range gates {
		if gates[i].Status != pipelinesv1alpha1.GateStatusApproved && count < math.MaxUint32 {
			count++
		}
	}
	return count
}

func latestConditionUnixMS(conditions []metav1.Condition) int64 {
	var latest int64
	set := false
	for i := range conditions {
		if conditions[i].LastTransitionTime.IsZero() {
			continue
		}
		candidate := conditions[i].LastTransitionTime.UnixMilli()
		if !set || candidate > latest {
			latest = candidate
			set = true
		}
	}
	return latest
}

func validStageAssociation(stage *pipelinesv1alpha1.Stage, app *pipelinesv1alpha1.Application) bool {
	if stage == nil || stage.Namespace != app.Namespace || stage.Labels[projectionAppNameLabel] != app.Name {
		return false
	}
	if !hasExactControllerOwner(
		stage.OwnerReferences,
		pipelinesv1alpha1.GroupVersion.String(),
		applicationOwnerKind,
		app.Name,
		app.UID,
	) {
		return false
	}

	matches := 0
	for i := range app.Spec.Stages {
		if app.Spec.Stages[i].Name == stage.Spec.Name {
			matches++
		}
	}
	return matches == 1
}

//nolint:cyclop // exact owner validation intentionally checks every identity component.
func hasExactControllerOwner(
	owners []metav1.OwnerReference,
	apiVersion, kind, name string,
	uid types.UID,
) bool {
	controllers := 0
	matched := false
	for i := range owners {
		if owners[i].Controller == nil || !*owners[i].Controller {
			continue
		}
		controllers++
		if owners[i].APIVersion == apiVersion &&
			owners[i].Kind == kind &&
			owners[i].Name == name &&
			uid != "" && owners[i].UID != "" && owners[i].UID == uid {
			matched = true
		}
	}
	return controllers == 1 && matched
}

func stageStableID(stage *pipelinesv1alpha1.Stage) string {
	if stage.UID != "" {
		return string(stage.UID)
	}
	return stage.Namespace + "/" + stage.Name
}

func clampInt32(value int) int32 {
	if int64(value) > math.MaxInt32 {
		return math.MaxInt32
	}
	if int64(value) < math.MinInt32 {
		return math.MinInt32
	}
	return int32(value)
}

func stageHealth(statuses []pipelinesv1alpha1.ApplicationStageStatus, logicalName string) Health {
	for i := range statuses {
		if statuses[i].Name == logicalName {
			return mapStageHealth(statuses[i].Phase)
		}
	}
	return HealthUnknown
}

func mapStageHealth(phase string) Health {
	switch phase {
	case "Healthy", "Complete":
		return HealthHealthy
	case "Pending", "Building", "Promoting", "Canarying", "Verifying", "Progressing":
		return HealthProgressing
	case "Degraded", "RolledBack":
		return HealthDegraded
	case "Failed":
		return HealthFailed
	default:
		return HealthUnknown
	}
}

func sortStageTargets(targets []StageTargetSummary) {
	sort.Slice(targets, func(i, j int) bool {
		if targets[i].Ring != targets[j].Ring {
			return targets[i].Ring < targets[j].Ring
		}
		if targets[i].Stage != targets[j].Stage {
			return targets[i].Stage < targets[j].Stage
		}
		if targets[i].Cluster.Namespace != targets[j].Cluster.Namespace {
			return targets[i].Cluster.Namespace < targets[j].Cluster.Namespace
		}
		if targets[i].Cluster.Name != targets[j].Cluster.Name {
			return targets[i].Cluster.Name < targets[j].Cluster.Name
		}
		return targets[i].StableID < targets[j].StableID
	})
}

func findCurrentRelease(
	app *pipelinesv1alpha1.Application,
	releases []*pipelinesv1alpha1.Release,
) (*pipelinesv1alpha1.Release, bool, bool) {
	if app.Status.ReleaseRef == "" {
		return nil, false, false
	}
	var current, wrongNamespace *pipelinesv1alpha1.Release
	for _, release := range releases {
		if release != nil && release.Name == app.Status.ReleaseRef {
			if release.Namespace != app.Namespace {
				if wrongNamespace == nil {
					wrongNamespace = release
				}
				continue
			}
			if current != nil {
				return nil, false, true
			}
			current = release
		}
	}
	if current == nil && wrongNamespace != nil {
		return wrongNamespace, true, false
	}
	return current, current != nil, false
}

func validReleaseAssociation(release *pipelinesv1alpha1.Release, app *pipelinesv1alpha1.Application) bool {
	return release != nil &&
		release.Namespace == app.Namespace &&
		release.Name == app.Status.ReleaseRef &&
		release.Labels[projectionAppNameLabel] == app.Name &&
		hasExactControllerOwner(
			release.OwnerReferences,
			pipelinesv1alpha1.GroupVersion.String(),
			applicationOwnerKind,
			app.Name,
			app.UID,
		)
}

//nolint:cyclop // explicit mapping prevents unknown enum values from leaking through casts.
func mapReleaseState(phase pipelinesv1alpha1.ReleasePhase) ReleaseState {
	switch phase {
	case pipelinesv1alpha1.ReleasePending:
		return ReleaseStatePending
	case pipelinesv1alpha1.ReleasePromoting:
		return ReleaseStatePromoting
	case pipelinesv1alpha1.ReleaseCanarying:
		return ReleaseStateCanarying
	case pipelinesv1alpha1.ReleaseVerifying:
		return ReleaseStateVerifying
	case pipelinesv1alpha1.ReleaseComplete:
		return ReleaseStateComplete
	case pipelinesv1alpha1.ReleaseFailed:
		return ReleaseStateFailed
	case pipelinesv1alpha1.ReleaseRolledBack:
		return ReleaseStateRolledBack
	case pipelinesv1alpha1.ReleaseSuperseded:
		return ReleaseStateSuperseded
	case pipelinesv1alpha1.ReleaseAwaitingApproval:
		return ReleaseStateAwaitingApproval
	default:
		return ReleaseStateUnspecified
	}
}

func projectCurrentRollout(
	summary *ApplicationSummary,
	result *ProjectionResult,
	app *pipelinesv1alpha1.Application,
	release *pipelinesv1alpha1.Release,
	rollouts []*rolloutsv1alpha1.Rollout,
) {
	if release.Status.RolloutRef == "" {
		return
	}
	current, ambiguous := findCurrentRollout(release, rollouts)
	if ambiguous {
		result.ProjectionErrorCount++
		return
	}
	if current == nil {
		return
	}
	if !validRolloutAssociation(current, app, release) {
		result.ProjectionErrorCount++
		return
	}
	summary.RolloutState = mapRolloutState(current.Status.Phase)
}

func findCurrentRollout(
	release *pipelinesv1alpha1.Release,
	rollouts []*rolloutsv1alpha1.Rollout,
) (*rolloutsv1alpha1.Rollout, bool) {
	var current, wrongNamespace *rolloutsv1alpha1.Rollout
	for _, rollout := range rollouts {
		if rollout == nil || rollout.Name != release.Status.RolloutRef {
			continue
		}
		if rollout.Namespace != release.Namespace {
			if wrongNamespace == nil {
				wrongNamespace = rollout
			}
			continue
		}
		if current != nil {
			return nil, true
		}
		current = rollout
	}
	if current == nil {
		current = wrongNamespace
	}
	return current, false
}

func validRolloutAssociation(
	rollout *rolloutsv1alpha1.Rollout,
	app *pipelinesv1alpha1.Application,
	release *pipelinesv1alpha1.Release,
) bool {
	return rollout != nil &&
		rollout.Namespace == release.Namespace &&
		rollout.Name == release.Status.RolloutRef &&
		rollout.Labels[projectionAppNameLabel] == app.Name &&
		hasExactControllerOwner(
			rollout.OwnerReferences,
			pipelinesv1alpha1.GroupVersion.String(),
			releaseOwnerKind,
			release.Name,
			release.UID,
		)
}

func mapRolloutState(phase rolloutsv1alpha1.RolloutPhase) RolloutState {
	switch phase {
	case rolloutsv1alpha1.RolloutPhasePending:
		return RolloutStatePending
	case rolloutsv1alpha1.RolloutPhaseProgressing:
		return RolloutStateProgressing
	case rolloutsv1alpha1.RolloutPhasePaused:
		return RolloutStatePaused
	case rolloutsv1alpha1.RolloutPhaseHealthy:
		return RolloutStateHealthy
	case rolloutsv1alpha1.RolloutPhaseDegraded:
		return RolloutStateDegraded
	case rolloutsv1alpha1.RolloutPhaseFailed:
		return RolloutStateFailed
	case rolloutsv1alpha1.RolloutPhaseRolledBack:
		return RolloutStateRolledBack
	case rolloutsv1alpha1.RolloutPhaseAborted:
		return RolloutStateAborted
	default:
		return RolloutStateUnspecified
	}
}

// UpsertProject projects project identity only. Application grouping is based
// on each Application's declaration and is intentionally independent of
// whether an AppProject currently exists.
func UpsertProject(snapshot *Snapshot, project *corev1alpha1.AppProject) ProjectionResult {
	if snapshot == nil || project == nil {
		return ProjectionResult{ProjectionErrorCount: 1}
	}
	key := ProjectKey{Namespace: project.Namespace, Name: project.Name}
	replacement := ProjectSummary{Identity: key}
	if current, ok := snapshot.Projects[key]; ok && current == replacement {
		return ProjectionResult{}
	}
	if snapshot.Projects == nil {
		snapshot.Projects = make(map[ProjectKey]ProjectSummary)
	}
	snapshot.Projects[key] = replacement
	return ProjectionResult{Changed: true}
}

// DeleteProject removes only AppProject metadata. Declared Application project
// keys and ByProject membership remain intact.
func DeleteProject(snapshot *Snapshot, key ProjectKey) ProjectionResult {
	if snapshot == nil {
		return ProjectionResult{ProjectionErrorCount: 1}
	}
	if _, ok := snapshot.Projects[key]; !ok {
		return ProjectionResult{}
	}
	delete(snapshot.Projects, key)
	return ProjectionResult{Changed: true}
}
