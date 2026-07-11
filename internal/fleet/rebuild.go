package fleet

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

const rebuildFailureReason = "fleet snapshot rebuild failed"

// Rebuilder serializes owned delta publication and coordinates full rebuilds
// with an ordered ledger. Kubernetes objects are always re-read from the store
// by key before projection.
type Rebuilder struct {
	index *Index
	store ProjectionStore

	mu         sync.Mutex
	rebuilding bool
	ledger     []ResourceDelta
	deps       projectionDependencies
}

type projectionDependencies struct {
	stageOwners   map[types.NamespacedName]types.NamespacedName
	releaseOwners map[types.NamespacedName]types.NamespacedName
	rolloutOwners map[types.NamespacedName]types.NamespacedName
}

func newProjectionDependencies() projectionDependencies {
	return projectionDependencies{
		stageOwners:   make(map[types.NamespacedName]types.NamespacedName),
		releaseOwners: make(map[types.NamespacedName]types.NamespacedName),
		rolloutOwners: make(map[types.NamespacedName]types.NamespacedName),
	}
}

// NewRebuilder binds a cache-only store to an atomic fleet index.
func NewRebuilder(index *Index, store ProjectionStore) *Rebuilder {
	return &Rebuilder{index: index, store: store, deps: newProjectionDependencies()}
}

// Rebuild constructs a complete replacement off-lock, replays every ledgered
// key in order, and performs one final owned publication under the same mutex
// used to enqueue deltas.
//
//nolint:cyclop // rebuild/ledger failure and handoff states are intentionally explicit.
func (r *Rebuilder) Rebuild(ctx context.Context) (ProjectionResult, error) {
	if r == nil || r.index == nil || r.store == nil {
		return ProjectionResult{}, errors.New("fleet rebuild is not configured")
	}

	r.mu.Lock()
	if r.rebuilding {
		r.mu.Unlock()
		return ProjectionResult{}, errors.New("fleet rebuild is already running")
	}
	r.rebuilding = true
	r.mu.Unlock()

	builder, dependencies, result, err := r.buildReplacement(ctx)
	if err != nil {
		r.failRebuild()
		return ProjectionResult{}, err
	}

	replayed := 0
	for {
		r.mu.Lock()
		pending := append([]ResourceDelta(nil), r.ledger[replayed:]...)
		r.mu.Unlock()

		for _, delta := range pending {
			var replayResult ProjectionResult
			var replayOwned ownedSnapshot
			replayOwned, dependencies, replayResult, err = r.applyDeltaToSnapshot(ctx, builder, dependencies, delta)
			if err != nil {
				r.failRebuild()
				return ProjectionResult{}, err
			}
			builder = replayOwned.snapshot
			result.ProjectionErrorCount += replayResult.ProjectionErrorCount
		}
		replayed += len(pending)
		fullyOwned, validationErr := sealFullyValidatedSnapshot(builder)
		if validationErr != nil {
			r.failRebuild()
			return ProjectionResult{}, errors.New("fleet rebuild produced an invalid snapshot")
		}

		r.mu.Lock()
		if len(r.ledger) != replayed {
			r.mu.Unlock()
			continue
		}

		generation := uint64(1)
		if current := r.index.snapshot.Load(); current != nil {
			generation = current.Generation + 1
		}
		fullyOwned.snapshot.Generation = generation
		if installErr := r.index.installOwned(fullyOwned); installErr != nil {
			r.storeDegradedHealth()
			r.rebuilding = false
			r.mu.Unlock()
			return ProjectionResult{}, errors.New("fleet rebuild produced an invalid snapshot")
		}
		if healthErr := r.index.SetHealth(HealthState{Ready: true}); healthErr != nil {
			r.storeDegradedHealth()
			r.rebuilding = false
			r.mu.Unlock()
			return ProjectionResult{}, errors.New("fleet rebuild could not mark the index ready")
		}
		r.deps = dependencies
		r.ledger = r.ledger[replayed:]
		r.rebuilding = false
		r.mu.Unlock()

		result.Changed = true
		return result, nil
	}
}

// ApplyDelta either records normalized key metadata while a rebuild is in
// flight (or before initial publication), or performs one batched COW edit and
// one owned publication. It never changes readiness health.
//
//nolint:cyclop // validation, queueing, no-op, and publication are distinct outcomes.
func (r *Rebuilder) ApplyDelta(ctx context.Context, delta ResourceDelta) (ProjectionResult, error) {
	if r == nil || r.index == nil || r.store == nil {
		return ProjectionResult{}, errors.New("fleet delta projection is not configured")
	}
	if !validResourceKind(delta.Kind) || delta.Key.Name == "" {
		return ProjectionResult{}, errors.New("fleet delta metadata is invalid")
	}
	delta = normalizeDelta(delta)

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.rebuilding || r.index.snapshot.Load() == nil {
		r.ledger = append(r.ledger, delta)
		return ProjectionResult{}, nil
	}

	base := r.index.snapshot.Load()
	next, dependencies, result, err := r.applyDeltaToSnapshot(ctx, base, r.deps, delta)
	if err != nil {
		return ProjectionResult{}, err
	}
	if !result.Changed {
		r.deps = dependencies
		return result, nil
	}
	next.snapshot.Generation = base.Generation + 1
	if err := r.index.installOwned(next); err != nil {
		return ProjectionResult{}, errors.New("fleet delta produced an invalid snapshot")
	}
	r.deps = dependencies
	return result, nil
}

func (r *Rebuilder) failRebuild() {
	r.mu.Lock()
	r.storeDegradedHealth()
	r.rebuilding = false
	r.mu.Unlock()
}

func (r *Rebuilder) storeDegradedHealth() {
	r.index.health.Store(&HealthState{Degraded: true, Reason: rebuildFailureReason})
}

func (r *Rebuilder) buildReplacement(
	ctx context.Context,
) (*Snapshot, projectionDependencies, ProjectionResult, error) {
	applications, err := r.store.ListApplications(ctx)
	if err != nil {
		return nil, projectionDependencies{}, ProjectionResult{}, safeStoreError(ctx, "applications")
	}
	stages, err := r.store.ListStages(ctx)
	if err != nil {
		return nil, projectionDependencies{}, ProjectionResult{}, safeStoreError(ctx, "stages")
	}
	releases, err := r.store.ListReleases(ctx)
	if err != nil {
		return nil, projectionDependencies{}, ProjectionResult{}, safeStoreError(ctx, "releases")
	}
	rollouts, err := r.store.ListRollouts(ctx)
	if err != nil {
		return nil, projectionDependencies{}, ProjectionResult{}, safeStoreError(ctx, "rollouts")
	}
	projects, err := r.store.ListAppProjects(ctx)
	if err != nil {
		return nil, projectionDependencies{}, ProjectionResult{}, safeStoreError(ctx, "app projects")
	}
	repositories, err := r.store.ListRepositories(ctx)
	if err != nil {
		return nil, projectionDependencies{}, ProjectionResult{}, safeStoreError(ctx, "repositories")
	}
	clusters, err := r.store.ListClusters(ctx)
	if err != nil {
		return nil, projectionDependencies{}, ProjectionResult{}, safeStoreError(ctx, "clusters")
	}
	if err := ctx.Err(); err != nil {
		return nil, projectionDependencies{}, ProjectionResult{}, fmt.Errorf("fleet rebuild canceled: %w", err)
	}

	return buildProjectionSnapshot(applications, stages, releases, rollouts, projects, repositories, clusters)
}

func safeStoreError(ctx context.Context, resource string) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("fleet projection canceled: %w", err)
	}
	return errors.New("fleet projection store failed while reading " + resource)
}

//nolint:cyclop,funlen,gocognit,gocyclo,nestif // association chains are fail-closed and deliberately spelled out.
func buildProjectionSnapshot(
	applications []*pipelinesv1alpha1.Application,
	stages []*pipelinesv1alpha1.Stage,
	releases []*pipelinesv1alpha1.Release,
	rollouts []*rolloutsv1alpha1.Rollout,
	projects []*corev1alpha1.AppProject,
	_ []*corev1alpha1.Repository,
	_ []*clustersv1alpha1.Cluster,
) (*Snapshot, projectionDependencies, ProjectionResult, error) {
	builder := NewSnapshot(0)
	dependencies := newProjectionDependencies()
	result := ProjectionResult{}

	appByKey := make(map[types.NamespacedName]*pipelinesv1alpha1.Application, len(applications))
	for _, app := range applications {
		if app == nil || app.Name == "" {
			result.ProjectionErrorCount++
			continue
		}
		key := objectKey(app)
		if _, duplicate := appByKey[key]; duplicate {
			delete(appByKey, key)
			result.ProjectionErrorCount++
			continue
		}
		appByKey[key] = app
	}

	projectByKey := make(map[types.NamespacedName]*corev1alpha1.AppProject, len(projects))
	for _, project := range projects {
		if project == nil || project.Name == "" {
			result.ProjectionErrorCount++
			continue
		}
		projectByKey[objectKey(project)] = project
	}
	for _, key := range sortedObjectKeys(projectByKey) {
		builder.Projects[key] = ProjectSummary{Identity: key}
	}

	stagesByApp := make(map[types.NamespacedName][]*pipelinesv1alpha1.Stage)
	for _, stage := range stages {
		ownerKey, ok := applicationOwnerKey(stage)
		if !ok {
			result.ProjectionErrorCount++
			continue
		}
		app := appByKey[ownerKey]
		if app == nil || !validStageAssociation(stage, app) {
			result.ProjectionErrorCount++
			continue
		}
		stagesByApp[ownerKey] = append(stagesByApp[ownerKey], stage)
		dependencies.stageOwners[objectKey(stage)] = ownerKey
	}

	releaseByKey := make(map[types.NamespacedName]*pipelinesv1alpha1.Release, len(releases))
	for _, release := range releases {
		if release != nil && release.Name != "" {
			releaseByKey[objectKey(release)] = release
		}
	}
	rolloutByKey := make(map[types.NamespacedName]*rolloutsv1alpha1.Rollout, len(rollouts))
	for _, rollout := range rollouts {
		if rollout != nil && rollout.Name != "" {
			rolloutByKey[objectKey(rollout)] = rollout
		}
	}

	for _, appKey := range sortedObjectKeys(appByKey) {
		app := appByKey[appKey]
		input := projectionInput{
			application: app,
			stages:      stagesByApp[appKey],
		}
		if app.Status.ReleaseRef != "" {
			releaseKey := types.NamespacedName{Namespace: app.Namespace, Name: app.Status.ReleaseRef}
			if release := releaseByKey[releaseKey]; release != nil {
				input.releases = []*pipelinesv1alpha1.Release{release}
				if validReleaseAssociation(release, app) {
					dependencies.releaseOwners[releaseKey] = appKey
					if release.Status.RolloutRef != "" {
						rolloutKey := types.NamespacedName{Namespace: release.Namespace, Name: release.Status.RolloutRef}
						if rollout := rolloutByKey[rolloutKey]; rollout != nil {
							input.rollouts = []*rolloutsv1alpha1.Rollout{rollout}
							if validRolloutAssociation(rollout, app, release) {
								dependencies.rolloutOwners[rolloutKey] = appKey
							}
						}
					}
				}
			}
		}
		summary, projected := projectApplication(&input)
		result.ProjectionErrorCount += projected.ProjectionErrorCount
		addApplicationMutable(builder, &summary)
	}
	builder.rebuildSearchIndex()
	if err := validateSnapshot(builder); err != nil {
		return nil, projectionDependencies{}, ProjectionResult{}, errors.New("fleet full projection is invalid")
	}
	return builder, dependencies, result, nil
}

//nolint:cyclop,funlen,gocognit,gocyclo // each resource kind has an explicit fail-closed delta path.
func (r *Rebuilder) applyDeltaToSnapshot(
	ctx context.Context,
	base *Snapshot,
	dependencies projectionDependencies,
	delta ResourceDelta,
) (ownedSnapshot, projectionDependencies, ProjectionResult, error) {
	delta = normalizeDelta(delta)
	editor := newSnapshotEditor(base)
	nextDependencies := dependencies
	result := ProjectionResult{}

	switch delta.Kind {
	case ResourceApplication:
		projected, err := r.reprojectApplicationDelta(ctx, editor, &nextDependencies, delta.Key)
		if err != nil {
			return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{}, err
		}
		result.ProjectionErrorCount += projected
	case ResourceStage:
		stage, found, err := r.store.GetStage(ctx, delta.Key)
		if err != nil {
			return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{}, safeStoreError(ctx, "stage")
		}
		oldOwner := nextDependencies.stageOwners[delta.Key]
		affected := append([]types.NamespacedName(nil), delta.AffectedApplications...)
		if found {
			newOwner, valid, validationErr := r.validateStageOwner(ctx, stage)
			if validationErr != nil {
				return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{}, validationErr
			}
			if !valid {
				return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{ProjectionErrorCount: 1}, nil
			}
			nextDependencies.stageOwners = withDependency(
				nextDependencies.stageOwners, delta.Key, newOwner,
			)
			affected = append(affected, oldOwner, newOwner)
		} else {
			nextDependencies.stageOwners = withoutDependency(nextDependencies.stageOwners, delta.Key)
			affected = append(affected, oldOwner)
		}
		projected, reprojectErr := r.reprojectApplicationKeys(ctx, editor, nextDependencies, normalizeKeys(affected))
		if reprojectErr != nil {
			return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{}, reprojectErr
		}
		result.ProjectionErrorCount += projected
	case ResourceRelease:
		affected, associationError, err := r.updateReleaseDependency(ctx, &nextDependencies, delta)
		if err != nil {
			return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{}, err
		}
		if associationError {
			return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{ProjectionErrorCount: 1}, nil
		}
		projected, reprojectErr := r.reprojectApplicationKeys(ctx, editor, nextDependencies, affected)
		if reprojectErr != nil {
			return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{}, reprojectErr
		}
		result.ProjectionErrorCount += projected
	case ResourceRollout:
		affected, associationError, err := r.updateRolloutDependency(ctx, &nextDependencies, delta)
		if err != nil {
			return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{}, err
		}
		if associationError {
			return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{ProjectionErrorCount: 1}, nil
		}
		projected, reprojectErr := r.reprojectApplicationKeys(ctx, editor, nextDependencies, affected)
		if reprojectErr != nil {
			return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{}, reprojectErr
		}
		result.ProjectionErrorCount += projected
	case ResourceAppProject:
		project, found, err := r.store.GetAppProject(ctx, delta.Key)
		if err != nil {
			return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{}, safeStoreError(ctx, "app project")
		}
		if found {
			editor.upsertProject(ProjectSummary{Identity: objectKey(project)})
		} else {
			editor.deleteProject(delta.Key)
		}
	case ResourceRepository:
		if _, _, err := r.store.GetRepository(ctx, delta.Key); err != nil {
			return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{}, safeStoreError(ctx, "repository")
		}
	case ResourceCluster:
		if _, _, err := r.store.GetCluster(ctx, delta.Key); err != nil {
			return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{}, safeStoreError(ctx, "cluster")
		}
	}

	result.Changed = editor.changed
	if !editor.changed {
		return ownedSnapshot{snapshot: base}, nextDependencies, result, nil
	}
	owned, err := editor.seal(base.Generation)
	if err != nil {
		return ownedSnapshot{snapshot: base}, dependencies, ProjectionResult{}, errors.New("fleet delta editor produced an invalid snapshot")
	}
	return owned, nextDependencies, result, nil
}

func (r *Rebuilder) reprojectApplicationDelta(
	ctx context.Context,
	editor *snapshotEditor,
	dependencies *projectionDependencies,
	key types.NamespacedName,
) (uint64, error) {
	app, found, err := r.store.GetApplication(ctx, key)
	if err != nil {
		return 0, safeStoreError(ctx, "application")
	}
	if !found {
		dependencies.stageOwners = replaceDependencyOwner(dependencies.stageOwners, key, nil)
		dependencies.releaseOwners = replaceDependencyOwner(dependencies.releaseOwners, key, nil)
		dependencies.rolloutOwners = replaceDependencyOwner(dependencies.rolloutOwners, key, nil)
		editor.deleteApplication(key)
		return 0, nil
	}
	if objectKey(app) != key {
		return 1, nil
	}

	projectionErrors, err := r.reconcileApplicationDependencies(ctx, dependencies, app)
	if err != nil {
		return 0, err
	}
	input, err := r.loadProjectionInput(ctx, app, *dependencies)
	if err != nil {
		return 0, err
	}
	summary, result := projectApplication(&input)
	projectionErrors += result.ProjectionErrorCount
	editor.upsertApplication(&summary)
	return projectionErrors, nil
}

//nolint:cyclop // stage, release, and rollout dependency chains require distinct cache reads.
func (r *Rebuilder) reconcileApplicationDependencies(
	ctx context.Context,
	dependencies *projectionDependencies,
	app *pipelinesv1alpha1.Application,
) (uint64, error) {
	appKey := objectKey(app)
	stageKeys := make([]types.NamespacedName, 0, len(app.Status.StageRefs))
	for stageKey, owner := range dependencies.stageOwners {
		if owner == appKey {
			stageKeys = append(stageKeys, stageKey)
		}
	}
	for _, stageName := range app.Status.StageRefs {
		if stageName != "" {
			stageKeys = append(stageKeys, types.NamespacedName{Namespace: app.Namespace, Name: stageName})
		}
	}
	desiredStages := make(map[types.NamespacedName]struct{})
	var projectionErrors uint64
	for _, stageKey := range normalizeKeys(stageKeys) {
		stage, found, err := r.store.GetStage(ctx, stageKey)
		if err != nil {
			return 0, safeStoreError(ctx, "stage")
		}
		if !found {
			continue
		}
		if !validStageAssociation(stage, app) {
			projectionErrors++
			continue
		}
		desiredStages[stageKey] = struct{}{}
	}
	dependencies.stageOwners = replaceDependencyOwner(dependencies.stageOwners, appKey, desiredStages)

	var desiredRelease, desiredRollout types.NamespacedName
	if app.Status.ReleaseRef == "" {
		dependencies.releaseOwners = replaceDependencyOwner(dependencies.releaseOwners, appKey, nil)
		dependencies.rolloutOwners = replaceDependencyOwner(dependencies.rolloutOwners, appKey, nil)
		return projectionErrors, nil
	}
	releaseKey := types.NamespacedName{Namespace: app.Namespace, Name: app.Status.ReleaseRef}
	release, found, err := r.store.GetRelease(ctx, releaseKey)
	if err != nil {
		return 0, safeStoreError(ctx, "release")
	}
	if !found || !validReleaseAssociation(release, app) {
		dependencies.releaseOwners = replaceDependencyOwner(dependencies.releaseOwners, appKey, nil)
		dependencies.rolloutOwners = replaceDependencyOwner(dependencies.rolloutOwners, appKey, nil)
		return projectionErrors, nil
	}
	desiredRelease = releaseKey
	if release.Status.RolloutRef == "" {
		dependencies.releaseOwners = replaceDependencyOwner(
			dependencies.releaseOwners, appKey, map[types.NamespacedName]struct{}{desiredRelease: {}},
		)
		dependencies.rolloutOwners = replaceDependencyOwner(dependencies.rolloutOwners, appKey, nil)
		return projectionErrors, nil
	}
	rolloutKey := types.NamespacedName{Namespace: release.Namespace, Name: release.Status.RolloutRef}
	rollout, rolloutFound, rolloutErr := r.store.GetRollout(ctx, rolloutKey)
	if rolloutErr != nil {
		return 0, safeStoreError(ctx, "rollout")
	}
	if rolloutFound && validRolloutAssociation(rollout, app, release) {
		desiredRollout = rolloutKey
	}
	dependencies.releaseOwners = replaceDependencyOwner(
		dependencies.releaseOwners, appKey, map[types.NamespacedName]struct{}{desiredRelease: {}},
	)
	desiredRollouts := make(map[types.NamespacedName]struct{})
	if desiredRollout != (types.NamespacedName{}) {
		desiredRollouts[desiredRollout] = struct{}{}
	}
	dependencies.rolloutOwners = replaceDependencyOwner(dependencies.rolloutOwners, appKey, desiredRollouts)
	return projectionErrors, nil
}

func replaceDependencyOwner(
	dependencies map[types.NamespacedName]types.NamespacedName,
	owner types.NamespacedName,
	desired map[types.NamespacedName]struct{},
) map[types.NamespacedName]types.NamespacedName {
	actualCount := 0
	matches := true
	for key, candidate := range dependencies {
		if candidate == owner {
			actualCount++
			if _, ok := desired[key]; !ok {
				matches = false
			}
		}
	}
	if matches && actualCount == len(desired) {
		return dependencies
	}
	replacement := cloneMap(dependencies)
	if replacement == nil {
		replacement = make(map[types.NamespacedName]types.NamespacedName)
	}
	for key, candidate := range replacement {
		if candidate == owner {
			delete(replacement, key)
		}
	}
	for key := range desired {
		replacement[key] = owner
	}
	return replacement
}

func withDependency(
	dependencies map[types.NamespacedName]types.NamespacedName,
	key, owner types.NamespacedName,
) map[types.NamespacedName]types.NamespacedName {
	if dependencies[key] == owner {
		return dependencies
	}
	replacement := cloneMap(dependencies)
	if replacement == nil {
		replacement = make(map[types.NamespacedName]types.NamespacedName)
	}
	replacement[key] = owner
	return replacement
}

func withoutDependency(
	dependencies map[types.NamespacedName]types.NamespacedName,
	key types.NamespacedName,
) map[types.NamespacedName]types.NamespacedName {
	if _, ok := dependencies[key]; !ok {
		return dependencies
	}
	replacement := cloneMap(dependencies)
	delete(replacement, key)
	return replacement
}

func (r *Rebuilder) validateStageOwner(
	ctx context.Context,
	stage *pipelinesv1alpha1.Stage,
) (types.NamespacedName, bool, error) {
	ownerKey, ok := applicationOwnerKey(stage)
	if !ok {
		return types.NamespacedName{}, false, nil
	}
	app, found, err := r.store.GetApplication(ctx, ownerKey)
	if err != nil {
		return types.NamespacedName{}, false, safeStoreError(ctx, "application")
	}
	if !found || !validStageAssociation(stage, app) {
		return types.NamespacedName{}, false, nil
	}
	return ownerKey, true, nil
}

//nolint:cyclop // release validation reconciles both Application and Rollout owner chains.
func (r *Rebuilder) updateReleaseDependency(
	ctx context.Context,
	dependencies *projectionDependencies,
	delta ResourceDelta,
) ([]types.NamespacedName, bool, error) {
	oldOwner := dependencies.releaseOwners[delta.Key]
	affected := append([]types.NamespacedName(nil), delta.AffectedApplications...)
	affected = append(affected, oldOwner)
	release, found, err := r.store.GetRelease(ctx, delta.Key)
	if err != nil {
		return nil, false, safeStoreError(ctx, "release")
	}
	if !found {
		dependencies.releaseOwners = withoutDependency(dependencies.releaseOwners, delta.Key)
		if oldOwner != (types.NamespacedName{}) {
			dependencies.rolloutOwners = replaceDependencyOwner(dependencies.rolloutOwners, oldOwner, nil)
		}
		return normalizeKeys(affected), false, nil
	}

	ownerKey, metadataValid := applicationOwnerKey(release)
	if !metadataValid {
		if oldOwner != (types.NamespacedName{}) || r.anyApplicationReferencesRelease(ctx, delta.AffectedApplications, delta.Key) {
			return nil, true, nil
		}
		return normalizeKeys(affected), false, nil
	}
	app, appFound, appErr := r.store.GetApplication(ctx, ownerKey)
	if appErr != nil {
		return nil, false, safeStoreError(ctx, "application")
	}
	if !appFound || !validApplicationOwnership(release, app) {
		return nil, true, nil
	}
	affected = append(affected, ownerKey)
	if app.Status.ReleaseRef != release.Name {
		dependencies.releaseOwners = withoutDependency(dependencies.releaseOwners, delta.Key)
		if oldOwner != (types.NamespacedName{}) {
			dependencies.rolloutOwners = replaceDependencyOwner(dependencies.rolloutOwners, oldOwner, nil)
		}
		return normalizeKeys(affected), false, nil
	}
	if oldOwner != (types.NamespacedName{}) && oldOwner != ownerKey {
		dependencies.rolloutOwners = replaceDependencyOwner(dependencies.rolloutOwners, oldOwner, nil)
	}
	dependencies.releaseOwners = withDependency(dependencies.releaseOwners, delta.Key, ownerKey)
	if err := r.reconcileReleaseRolloutDependency(ctx, dependencies, app, release); err != nil {
		return nil, false, err
	}
	return normalizeKeys(affected), false, nil
}

func (r *Rebuilder) reconcileReleaseRolloutDependency(
	ctx context.Context,
	dependencies *projectionDependencies,
	app *pipelinesv1alpha1.Application,
	release *pipelinesv1alpha1.Release,
) error {
	desired := make(map[types.NamespacedName]struct{})
	if release.Status.RolloutRef != "" {
		rolloutKey := types.NamespacedName{Namespace: release.Namespace, Name: release.Status.RolloutRef}
		rollout, found, err := r.store.GetRollout(ctx, rolloutKey)
		if err != nil {
			return safeStoreError(ctx, "rollout")
		}
		if found && validRolloutAssociation(rollout, app, release) {
			desired[rolloutKey] = struct{}{}
		}
	}
	dependencies.rolloutOwners = replaceDependencyOwner(
		dependencies.rolloutOwners,
		objectKey(app),
		desired,
	)
	return nil
}

//nolint:cyclop // rollout validation intentionally walks the complete owner chain.
func (r *Rebuilder) updateRolloutDependency(
	ctx context.Context,
	dependencies *projectionDependencies,
	delta ResourceDelta,
) ([]types.NamespacedName, bool, error) {
	oldOwner := dependencies.rolloutOwners[delta.Key]
	affected := append([]types.NamespacedName(nil), delta.AffectedApplications...)
	affected = append(affected, oldOwner)
	rollout, found, err := r.store.GetRollout(ctx, delta.Key)
	if err != nil {
		return nil, false, safeStoreError(ctx, "rollout")
	}
	if !found {
		dependencies.rolloutOwners = withoutDependency(dependencies.rolloutOwners, delta.Key)
		return normalizeKeys(affected), false, nil
	}

	releaseKey, metadataValid := releaseOwnerKey(rollout)
	if !metadataValid {
		if oldOwner != (types.NamespacedName{}) {
			return nil, true, nil
		}
		return normalizeKeys(affected), false, nil
	}
	release, releaseFound, releaseErr := r.store.GetRelease(ctx, releaseKey)
	if releaseErr != nil {
		return nil, false, safeStoreError(ctx, "release")
	}
	if !releaseFound {
		return nil, true, nil
	}
	appKey, appMetadataValid := applicationOwnerKey(release)
	if !appMetadataValid {
		return nil, true, nil
	}
	app, appFound, appErr := r.store.GetApplication(ctx, appKey)
	if appErr != nil {
		return nil, false, safeStoreError(ctx, "application")
	}
	if !appFound || !validReleaseAssociation(release, app) {
		return nil, true, nil
	}
	affected = append(affected, appKey)
	if release.Status.RolloutRef != rollout.Name {
		dependencies.rolloutOwners = withoutDependency(dependencies.rolloutOwners, delta.Key)
		return normalizeKeys(affected), false, nil
	}
	if !validRolloutAssociation(rollout, app, release) {
		return nil, true, nil
	}
	dependencies.rolloutOwners = withDependency(dependencies.rolloutOwners, delta.Key, appKey)
	return normalizeKeys(affected), false, nil
}

func (r *Rebuilder) anyApplicationReferencesRelease(
	ctx context.Context,
	keys []types.NamespacedName,
	releaseKey types.NamespacedName,
) bool {
	for _, key := range keys {
		app, found, err := r.store.GetApplication(ctx, key)
		if err == nil && found && app.Namespace == releaseKey.Namespace && app.Status.ReleaseRef == releaseKey.Name {
			return true
		}
	}
	return false
}

func (r *Rebuilder) reprojectApplicationKeys(
	ctx context.Context,
	editor *snapshotEditor,
	dependencies projectionDependencies,
	keys []types.NamespacedName,
) (uint64, error) {
	var projectionErrors uint64
	for _, key := range normalizeKeys(keys) {
		app, found, err := r.store.GetApplication(ctx, key)
		if err != nil {
			return 0, safeStoreError(ctx, "application")
		}
		if !found {
			editor.deleteApplication(key)
			continue
		}
		input, inputErr := r.loadProjectionInput(ctx, app, dependencies)
		if inputErr != nil {
			return 0, inputErr
		}
		summary, result := projectApplication(&input)
		projectionErrors += result.ProjectionErrorCount
		editor.upsertApplication(&summary)
	}
	return projectionErrors, nil
}

//nolint:cyclop // each optional current child is point-read and validated independently.
func (r *Rebuilder) loadProjectionInput(
	ctx context.Context,
	app *pipelinesv1alpha1.Application,
	dependencies projectionDependencies,
) (projectionInput, error) {
	appKey := objectKey(app)
	input := projectionInput{
		application: app,
	}
	stageKeys := make([]types.NamespacedName, 0)
	for stageKey, owner := range dependencies.stageOwners {
		if owner == appKey {
			stageKeys = append(stageKeys, stageKey)
		}
	}
	sortNamespacedNames(stageKeys)
	for _, stageKey := range stageKeys {
		stage, found, err := r.store.GetStage(ctx, stageKey)
		if err != nil {
			return projectionInput{}, safeStoreError(ctx, "stage")
		}
		if !found {
			continue
		}
		input.stages = append(input.stages, stage)
	}
	if app.Status.ReleaseRef == "" {
		return input, nil
	}
	releaseKey := types.NamespacedName{Namespace: app.Namespace, Name: app.Status.ReleaseRef}
	release, found, err := r.store.GetRelease(ctx, releaseKey)
	if err != nil {
		return projectionInput{}, safeStoreError(ctx, "release")
	}
	if !found {
		return input, nil
	}
	input.releases = []*pipelinesv1alpha1.Release{release}
	if release.Status.RolloutRef == "" {
		return input, nil
	}
	rolloutKey := types.NamespacedName{Namespace: release.Namespace, Name: release.Status.RolloutRef}
	rollout, rolloutFound, rolloutErr := r.store.GetRollout(ctx, rolloutKey)
	if rolloutErr != nil {
		return projectionInput{}, safeStoreError(ctx, "rollout")
	}
	if rolloutFound {
		input.rollouts = []*rolloutsv1alpha1.Rollout{rollout}
	}
	return input, nil
}

func validApplicationOwnership(object metav1.Object, app *pipelinesv1alpha1.Application) bool {
	return object.GetNamespace() == app.Namespace &&
		object.GetLabels()[projectionAppNameLabel] == app.Name &&
		hasExactControllerOwner(
			object.GetOwnerReferences(),
			pipelinesv1alpha1.GroupVersion.String(),
			applicationOwnerKind,
			app.Name,
			app.UID,
		)
}

func applicationOwnerKey(object metav1.Object) (types.NamespacedName, bool) {
	owner, ok := exactControllerMetadata(
		object.GetOwnerReferences(),
		pipelinesv1alpha1.GroupVersion.String(),
		applicationOwnerKind,
	)
	if !ok {
		return types.NamespacedName{}, false
	}
	return types.NamespacedName{Namespace: object.GetNamespace(), Name: owner.Name}, true
}

func releaseOwnerKey(object metav1.Object) (types.NamespacedName, bool) {
	owner, ok := exactControllerMetadata(
		object.GetOwnerReferences(),
		pipelinesv1alpha1.GroupVersion.String(),
		releaseOwnerKind,
	)
	if !ok {
		return types.NamespacedName{}, false
	}
	return types.NamespacedName{Namespace: object.GetNamespace(), Name: owner.Name}, true
}

func exactControllerMetadata(
	owners []metav1.OwnerReference,
	apiVersion, kind string,
) (metav1.OwnerReference, bool) {
	var controller *metav1.OwnerReference
	for i := range owners {
		if owners[i].Controller == nil || !*owners[i].Controller {
			continue
		}
		if controller != nil {
			return metav1.OwnerReference{}, false
		}
		controller = &owners[i]
	}
	if controller == nil || controller.APIVersion != apiVersion || controller.Kind != kind ||
		controller.Name == "" || controller.UID == "" {
		return metav1.OwnerReference{}, false
	}
	return *controller, true
}

func objectKey(object metav1.Object) types.NamespacedName {
	return types.NamespacedName{Namespace: object.GetNamespace(), Name: object.GetName()}
}

func sortedObjectKeys[V any](objects map[types.NamespacedName]V) []types.NamespacedName {
	keys := make([]types.NamespacedName, 0, len(objects))
	for key := range objects {
		keys = append(keys, key)
	}
	sortNamespacedNames(keys)
	return keys
}

func normalizeKeys(keys []types.NamespacedName) []types.NamespacedName {
	seen := make(map[types.NamespacedName]struct{}, len(keys))
	for _, key := range keys {
		if key.Name != "" {
			seen[key] = struct{}{}
		}
	}
	result := make([]types.NamespacedName, 0, len(seen))
	for key := range seen {
		result = append(result, key)
	}
	sortNamespacedNames(result)
	return result
}

func sortNamespacedNames(keys []types.NamespacedName) {
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].Namespace != keys[j].Namespace {
			return keys[i].Namespace < keys[j].Namespace
		}
		return keys[i].Name < keys[j].Name
	})
}
