package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/fleet"
)

const (
	fixtureNamespaceCount   = 12
	fixtureApplicationLabel = "app.paprika.io/name"
)

var fixtureEpoch = time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)

// fixtureData keeps the real object reader, projection index, and registered
// scheme together so the same-origin server can expose production API paths.
type fixtureData struct {
	client client.Client
	index  *fleet.Index
	scheme *runtime.Scheme
}

// seedFixture builds deterministic Paprika CRs and publishes them through the
// same CacheStore/Rebuilder projection path used by a live controller cache.
func seedFixture(ctx context.Context, applicationCount int) (*fixtureData, error) {
	if ctx == nil {
		return nil, errors.New("fixture context must not be nil")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if applicationCount < 1 || applicationCount > maxFixtureApplications {
		return nil, fmt.Errorf("application count must be between 1 and %d", maxFixtureApplications)
	}

	scheme, err := newFixtureScheme()
	if err != nil {
		return nil, err
	}
	objects := fixtureObjects(applicationCount)
	fakeClient := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objects...).Build()
	index := fleet.NewIndex()
	rebuilder := fleet.NewRebuilder(index, fleet.NewCacheStore(fakeClient, scheme))
	result, err := rebuilder.Rebuild(ctx)
	if err != nil {
		return nil, fmt.Errorf("rebuild fleet fixture: %w", err)
	}
	if result.ProjectionErrorCount != 0 {
		return nil, fmt.Errorf("rebuild fleet fixture: %d projection errors", result.ProjectionErrorCount)
	}
	snapshot, err := index.LoadSnapshot()
	if err != nil {
		return nil, fmt.Errorf("load fleet fixture: %w", err)
	}
	if len(snapshot.Applications) != applicationCount {
		return nil, fmt.Errorf(
			"rebuild fleet fixture: projected %d of %d applications",
			len(snapshot.Applications), applicationCount,
		)
	}

	return &fixtureData{client: fakeClient, index: index, scheme: scheme}, nil
}

func newFixtureScheme() (*runtime.Scheme, error) {
	scheme := runtime.NewScheme()
	registrations := []struct {
		name string
		add  func(*runtime.Scheme) error
	}{
		{name: "client-go", add: clientgoscheme.AddToScheme},
		{name: "pipelines", add: pipelinesv1alpha1.AddToScheme},
		{name: "core", add: corev1alpha1.AddToScheme},
		{name: "policy", add: policyv1alpha1.AddToScheme},
		{name: "rollouts", add: rolloutsv1alpha1.AddToScheme},
		{name: "clusters", add: clustersv1alpha1.AddToScheme},
	}
	for _, registration := range registrations {
		if err := registration.add(scheme); err != nil {
			return nil, fmt.Errorf("register %s fixture scheme: %w", registration.name, err)
		}
	}
	return scheme, nil
}

func fixtureObjects(applicationCount int) []client.Object {
	namespaceCount := min(applicationCount, fixtureNamespaceCount)
	objects := make([]client.Object, 0, applicationCount*4+namespaceCount*8)
	seenNamespaces := make(map[string]struct{}, namespaceCount)
	seenProjects := make(map[types.NamespacedName]struct{}, namespaceCount*4)

	for index := 0; index < applicationCount; index++ {
		state := fixtureStateFor(index)
		namespace := fixtureNamespace(index)
		if _, seen := seenNamespaces[namespace]; !seen {
			objects = append(objects, fixtureConnectionObjects(namespace)...)
			seenNamespaces[namespace] = struct{}{}
		}
		projectKey := types.NamespacedName{Namespace: namespace, Name: state.project}
		if _, seen := seenProjects[projectKey]; !seen {
			objects = append(objects, fixtureProject(projectKey))
			seenProjects[projectKey] = struct{}{}
		}

		application := fixtureApplication(index, namespace, &state)
		stage := fixtureStage(application, &state)
		release := fixtureRelease(application, &state)
		rollout := fixtureRollout(application, release, &state)
		objects = append(objects, application, stage, release, rollout)
	}
	return objects
}

type fixtureState struct {
	project       string
	sourceType    string
	application   pipelinesv1alpha1.ApplicationPhase
	health        pipelinesv1alpha1.HealthStatus
	synced        bool
	driftCount    int
	stage         string
	release       pipelinesv1alpha1.ReleasePhase
	rollout       rolloutsv1alpha1.RolloutPhase
	repository    string
	cluster       string
	blockedByGate bool
}

func fixtureStateFor(index int) fixtureState {
	switch index % 5 {
	case 0:
		return fixtureState{
			project: "payments", sourceType: pipelinesv1alpha1.SourceTypeGit,
			application: pipelinesv1alpha1.ApplicationHealthy, health: pipelinesv1alpha1.HealthHealthy,
			synced: true, stage: "Healthy", release: pipelinesv1alpha1.ReleaseComplete,
			rollout: rolloutsv1alpha1.RolloutPhaseHealthy, repository: "source-primary", cluster: "delivery-primary",
		}
	case 1:
		return fixtureState{
			project: "commerce", sourceType: pipelinesv1alpha1.SourceTypeHelm,
			application: pipelinesv1alpha1.ApplicationDegraded, health: pipelinesv1alpha1.HealthDegraded,
			stage: "Degraded", release: pipelinesv1alpha1.ReleaseFailed,
			rollout: rolloutsv1alpha1.RolloutPhaseDegraded, repository: "source-unhealthy", cluster: "delivery-unhealthy",
		}
	case 2:
		return fixtureState{
			project: "fulfillment", sourceType: pipelinesv1alpha1.SourceTypeKustomize,
			application: pipelinesv1alpha1.ApplicationHealthy, health: pipelinesv1alpha1.HealthHealthy,
			driftCount: 3, stage: "Healthy", release: pipelinesv1alpha1.ReleaseComplete,
			rollout: rolloutsv1alpha1.RolloutPhaseHealthy, repository: "source-primary", cluster: "delivery-primary",
		}
	case 3:
		return fixtureState{
			project: "platform", sourceType: pipelinesv1alpha1.SourceTypeOCI,
			application: pipelinesv1alpha1.ApplicationPromoting, health: pipelinesv1alpha1.HealthProgressing,
			synced: true, stage: "Progressing", release: pipelinesv1alpha1.ReleasePromoting,
			rollout: rolloutsv1alpha1.RolloutPhaseProgressing, repository: "source-primary", cluster: "delivery-primary",
		}
	default:
		return fixtureState{
			project: "payments", sourceType: pipelinesv1alpha1.SourceTypeS3,
			application: pipelinesv1alpha1.ApplicationPromoting, health: pipelinesv1alpha1.HealthProgressing,
			synced: true, stage: "Pending", release: pipelinesv1alpha1.ReleaseAwaitingApproval,
			rollout: rolloutsv1alpha1.RolloutPhasePaused, repository: "source-primary", cluster: "delivery-primary",
			blockedByGate: true,
		}
	}
}

func fixtureNamespace(index int) string {
	return fmt.Sprintf("team-%02d", index%fixtureNamespaceCount)
}

func fixtureApplicationName(index int) string {
	if index == 0 {
		return "checkout-service"
	}
	return fmt.Sprintf("application-%05d", index)
}

func fixtureApplication(index int, namespace string, state *fixtureState) *pipelinesv1alpha1.Application {
	name := fixtureApplicationName(index)
	releaseName := name + "-release-v1"
	transitioned := metav1.NewTime(fixtureEpoch.Add(time.Duration(index) * time.Minute))
	resources := fixtureResources(name, namespace, state)
	application := &pipelinesv1alpha1.Application{
		TypeMeta: metav1.TypeMeta{
			APIVersion: pipelinesv1alpha1.GroupVersion.String(),
			Kind:       "Application",
		},
		ObjectMeta: metav1.ObjectMeta{
			Namespace:         namespace,
			Name:              name,
			UID:               types.UID(fmt.Sprintf("fixture-application-%06d", index)),
			CreationTimestamp: metav1.NewTime(fixtureEpoch.Add(-time.Duration(index+1) * time.Hour)),
		},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: state.project,
			Source: pipelinesv1alpha1.ApplicationSource{
				Type:     state.sourceType,
				RepoRef:  state.repository,
				RepoURL:  "https://example.invalid/" + state.project + "/" + name + ".git",
				Revision: "main",
				Path:     "deploy",
			},
			Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{
				Name: "production",
				Ring: 3,
				Cluster: pipelinesv1alpha1.ClusterRef{
					Name: state.cluster,
				},
			}},
			Strategy:   pipelinesv1alpha1.StrategyRolling,
			SyncPolicy: pipelinesv1alpha1.SyncAuto,
		},
		Status: pipelinesv1alpha1.ApplicationStatus{
			ObservedGeneration: 1,
			Phase:              state.application,
			CurrentStage:       "production",
			Stages: []pipelinesv1alpha1.ApplicationStageStatus{{
				Name: "production", Ring: 3, Phase: state.stage, Release: releaseName,
				Revision: fmt.Sprintf("fixture-%05d", index), UpdatedAt: &transitioned,
			}},
			Synced:         state.synced,
			Revision:       fmt.Sprintf("fixture-%05d", index),
			SourceRevision: fmt.Sprintf("fixture-%05d", index),
			StageRefs:      []string{name + "-production"},
			ReleaseRef:     releaseName,
			Health:         state.health,
			Resources:      resources,
			OutOfSync:      state.driftCount,
			Conditions: []metav1.Condition{{
				Type: "Ready", Status: conditionStatus(state), Reason: "FixtureState",
				ObservedGeneration: 1, LastTransitionTime: transitioned,
			}},
		},
	}
	if state.blockedByGate {
		application.Status.Gates = []pipelinesv1alpha1.GateStatus{{
			Name: "production-approval", Stage: "production",
			Type: pipelinesv1alpha1.ApprovalGateTypeManual, Status: pipelinesv1alpha1.GateStatusPending,
		}}
	}
	return application
}

func fixtureResources(
	name, namespace string,
	state *fixtureState,
) []pipelinesv1alpha1.ResourceSync {
	status := "Synced"
	if state.health == pipelinesv1alpha1.HealthDegraded {
		status = "Missing"
	} else if state.driftCount > 0 {
		status = "OutOfSync"
	}
	resources := []pipelinesv1alpha1.ResourceSync{{
		Kind: "Deployment", Name: name, Namespace: namespace, Status: status,
	}}
	if state.driftCount > 0 {
		resources = append(resources,
			pipelinesv1alpha1.ResourceSync{Kind: "Service", Name: name, Namespace: namespace, Status: "OutOfSync"},
			pipelinesv1alpha1.ResourceSync{Kind: "ConfigMap", Name: name, Namespace: namespace, Status: "OutOfSync"},
		)
	}
	return resources
}

func conditionStatus(state *fixtureState) metav1.ConditionStatus {
	switch state.health {
	case pipelinesv1alpha1.HealthHealthy:
		return metav1.ConditionTrue
	case pipelinesv1alpha1.HealthDegraded:
		return metav1.ConditionFalse
	case pipelinesv1alpha1.HealthUnknown, pipelinesv1alpha1.HealthProgressing:
		return metav1.ConditionUnknown
	default:
		return metav1.ConditionUnknown
	}
}

func fixtureStage(
	application *pipelinesv1alpha1.Application,
	state *fixtureState,
) *pipelinesv1alpha1.Stage {
	return &pipelinesv1alpha1.Stage{
		TypeMeta: metav1.TypeMeta{APIVersion: pipelinesv1alpha1.GroupVersion.String(), Kind: "Stage"},
		ObjectMeta: fixtureChildMetadata(
			application.Namespace,
			application.Name+"-production",
			types.UID("fixture-stage-"+string(application.UID)),
			application.Name,
			controllerOwner("Application", application.Name, application.UID),
		),
		Spec: pipelinesv1alpha1.StageSpec{
			Name: "production", Ring: 3,
			Cluster: pipelinesv1alpha1.ClusterRef{Name: state.cluster},
		},
	}
}

func fixtureRelease(
	application *pipelinesv1alpha1.Application,
	state *fixtureState,
) *pipelinesv1alpha1.Release {
	name := application.Name + "-release-v1"
	return &pipelinesv1alpha1.Release{
		TypeMeta: metav1.TypeMeta{APIVersion: pipelinesv1alpha1.GroupVersion.String(), Kind: "Release"},
		ObjectMeta: fixtureChildMetadata(
			application.Namespace,
			name,
			types.UID("fixture-release-"+string(application.UID)),
			application.Name,
			controllerOwner("Application", application.Name, application.UID),
		),
		Spec: pipelinesv1alpha1.ReleaseSpec{Pipeline: "fixture", Target: "production"},
		Status: pipelinesv1alpha1.ReleaseStatus{
			ObservedGeneration: 1,
			Phase:              state.release,
			CurrentStage:       "production",
			RolloutRef:         application.Name + "-rollout-v1",
		},
	}
}

func fixtureRollout(
	application *pipelinesv1alpha1.Application,
	release *pipelinesv1alpha1.Release,
	state *fixtureState,
) *rolloutsv1alpha1.Rollout {
	return &rolloutsv1alpha1.Rollout{
		TypeMeta: metav1.TypeMeta{APIVersion: rolloutsv1alpha1.GroupVersion.String(), Kind: "Rollout"},
		ObjectMeta: fixtureChildMetadata(
			application.Namespace,
			application.Name+"-rollout-v1",
			types.UID("fixture-rollout-"+string(application.UID)),
			application.Name,
			controllerOwner("Release", release.Name, release.UID),
		),
		Spec: rolloutsv1alpha1.RolloutSpec{
			Target:   rolloutsv1alpha1.RolloutTarget{Kind: "Deployment", Name: application.Name},
			Strategy: rolloutsv1alpha1.RolloutStrategy{Type: "Rolling"},
		},
		Status: rolloutsv1alpha1.RolloutStatus{ObservedGeneration: 1, Phase: state.rollout},
	}
}

func fixtureChildMetadata(
	namespace, name string,
	uid types.UID,
	applicationName string,
	owner *metav1.OwnerReference,
) metav1.ObjectMeta {
	return metav1.ObjectMeta{
		Namespace:       namespace,
		Name:            name,
		UID:             uid,
		Labels:          map[string]string{fixtureApplicationLabel: applicationName},
		OwnerReferences: []metav1.OwnerReference{*owner},
	}
}

func controllerOwner(kind, name string, uid types.UID) *metav1.OwnerReference {
	controller := true
	return &metav1.OwnerReference{
		APIVersion: pipelinesv1alpha1.GroupVersion.String(),
		Kind:       kind,
		Name:       name,
		UID:        uid,
		Controller: &controller,
	}
}

func fixtureProject(key types.NamespacedName) *corev1alpha1.AppProject {
	return &corev1alpha1.AppProject{
		TypeMeta:   metav1.TypeMeta{APIVersion: corev1alpha1.GroupVersion.String(), Kind: "AppProject"},
		ObjectMeta: metav1.ObjectMeta{Namespace: key.Namespace, Name: key.Name},
		Spec: corev1alpha1.AppProjectSpec{
			Description:  "Deterministic fleet console fixture",
			Repositories: []string{"source-primary", "source-unhealthy"},
		},
	}
}

func fixtureConnectionObjects(namespace string) []client.Object {
	return []client.Object{
		fixtureRepository(namespace, "source-primary", corev1alpha1.ConnectionStatusSuccessful),
		fixtureRepository(namespace, "source-unhealthy", corev1alpha1.ConnectionStatusFailed),
		fixtureCluster(namespace, "delivery-primary", "Primary delivery", clustersv1alpha1.ClusterPhaseHealthy),
		fixtureCluster(namespace, "delivery-unhealthy", "Unavailable delivery", clustersv1alpha1.ClusterPhaseUnhealthy),
	}
}

func fixtureRepository(
	namespace, name string,
	connection corev1alpha1.ConnectionStatus,
) *corev1alpha1.Repository {
	return &corev1alpha1.Repository{
		TypeMeta:   metav1.TypeMeta{APIVersion: corev1alpha1.GroupVersion.String(), Kind: "Repository"},
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec: corev1alpha1.RepositorySpec{
			Type: corev1alpha1.RepositoryTypeGit,
			URL:  "https://example.invalid/fixture/" + name + ".git",
		},
		Status: corev1alpha1.RepositoryStatus{ObservedGeneration: 1, ConnectionState: &corev1alpha1.ConnectionState{
			Status: connection,
		}},
	}
}

func fixtureCluster(
	namespace, name, displayName string,
	phase clustersv1alpha1.ClusterPhase,
) *clustersv1alpha1.Cluster {
	return &clustersv1alpha1.Cluster{
		TypeMeta:   metav1.TypeMeta{APIVersion: clustersv1alpha1.GroupVersion.String(), Kind: "Cluster"},
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec: clustersv1alpha1.ClusterSpec{
			DisplayName: displayName,
			Mode:        clustersv1alpha1.ClusterModeDirect,
			Server:      "https://" + name + ".example.invalid",
		},
		Status: clustersv1alpha1.ClusterStatus{ObservedGeneration: 1, Phase: phase},
	}
}
