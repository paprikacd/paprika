package fleet

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestOptionalSourceRegistrationIsSingleAndPrototypeIsDefensive(t *testing.T) {
	t.Parallel()

	store := newOptionalProjectionStore()
	projector := &fakeOptionalSourceProjector{}
	rebuilder := NewRebuilder(NewIndex(), store, projector)
	first := rebuilder.OptionalSourcePrototype()
	require.IsType(t, &corev1.ConfigMap{}, first)
	first.SetName("mutated")
	second := rebuilder.OptionalSourcePrototype()
	require.Empty(t, second.GetName())

	misconfigured := NewRebuilder(NewIndex(), newFakeProjectionStore(), projector)
	_, err := misconfigured.Rebuild(context.Background())
	require.ErrorContains(t, err, "optional source projection is not configured")

	ambiguous := NewRebuilder(NewIndex(), store, projector, &fakeOptionalSourceProjector{})
	_, err = ambiguous.Rebuild(context.Background())
	require.ErrorContains(t, err, "exactly one optional source projector")
}

func TestOptionalSourceNilProjectorIsNotConfigured(t *testing.T) {
	t.Parallel()

	store, appID, _ := populatedProjectionStore()
	index := NewIndex()
	rebuilder := NewRebuilder(index, store)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	summary := requireSnapshot(t, index).Applications[appID]
	require.Zero(t, summary.EffectiveObservabilitySource)
	require.Equal(t, ConnectionStateNotConfigured, summary.ObservabilityConnection)
	before := requireSnapshot(t, index)
	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceOptionalSource,
		Key:  fleetID("apps", "not-registered"),
	})
	require.ErrorContains(t, err, "projector is not configured")
	require.False(t, result.Changed)
	require.Same(t, before, requireSnapshot(t, index))
}

func TestOptionalSourceFullBuildRetainsPluralBindingsAndPrecedence(t *testing.T) {
	t.Parallel()

	store := newOptionalProjectionStore()
	app := projectionApplication("apps", "checkout", "checkout-uid")
	app.Spec.Project = "retail"
	project := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Namespace: app.Namespace, Name: app.Spec.Project},
		Spec:       corev1alpha1.AppProjectSpec{Description: "multi"},
	}
	first := fleetID("apps", "prometheus-primary")
	second := fleetID("apps", "prometheus-stage")
	bindings := []types.NamespacedName{first, {}, second, first}
	projector := &fakeOptionalSourceProjector{bindingsByProjectDescription: map[string][]types.NamespacedName{
		"multi": bindings,
	}}
	store.putApplication(app)
	store.putProject(project)
	store.putOptionalSource(optionalSourceConfigMap(first, ConnectionStateHealthy))
	store.putOptionalSource(optionalSourceConfigMap(second, ConnectionStateUnhealthy))

	index := NewIndex()
	rebuilder := NewRebuilder(index, store, projector)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	snapshot := requireSnapshot(t, index)
	appID := clientKey(app)
	require.Equal(t, first, snapshot.Applications[appID].EffectiveObservabilitySource)
	require.Equal(t, ConnectionStateHealthy, snapshot.Applications[appID].ObservabilityConnection)
	require.Equal(t, []types.NamespacedName{first, second}, snapshot.sourceBindings[appID])
	require.Equal(t, idSet(appID), snapshot.BySource[first])
	require.Equal(t, idSet(appID), snapshot.BySource[second])
	require.Equal(t, SourceSummary{Identity: first, Connection: ConnectionStateHealthy}, snapshot.Sources[first])
	require.Equal(t, SourceSummary{Identity: second, Connection: ConnectionStateUnhealthy}, snapshot.Sources[second])

	bindings[0] = fleetID("mutated", "outside-snapshot")
	require.Equal(t, []types.NamespacedName{first, second}, snapshot.sourceBindings[appID])
}

func TestOptionalSourceStatusDeleteRecreateUsesReverseDependants(t *testing.T) {
	t.Parallel()

	store := newOptionalProjectionStore()
	sourceKey := fleetID("apps", "prometheus")
	unrelatedSourceKey := fleetID("apps", "prometheus-other")
	projector := &fakeOptionalSourceProjector{bindingsByProjectDescription: map[string][]types.NamespacedName{
		"bound":       {sourceKey},
		"other-bound": {unrelatedSourceKey},
	}}
	boundApp, boundProject := optionalSourceApplication("apps", "checkout", "retail", "bound")
	unrelatedApp, unrelatedProject := optionalSourceApplication("apps", "payments", "other", "other-bound")
	store.putApplication(boundApp)
	store.putApplication(unrelatedApp)
	store.putProject(boundProject)
	store.putProject(unrelatedProject)
	store.putOptionalSource(optionalSourceConfigMap(sourceKey, ConnectionStateHealthy))
	store.putOptionalSource(optionalSourceConfigMap(unrelatedSourceKey, ConnectionStateHealthy))

	index := NewIndex()
	rebuilder := NewRebuilder(index, store, projector)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	before := requireSnapshot(t, index)
	boundID := clientKey(boundApp)
	unrelatedID := clientKey(unrelatedApp)
	unrelatedBindingsPointer := sliceDataPointer(before.sourceBindings[unrelatedID])
	store.setApplicationGetError(unrelatedID, context.Canceled)

	store.putOptionalSource(optionalSourceConfigMap(sourceKey, ConnectionStateUnhealthy))
	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{
		Kind: ResourceOptionalSource,
		Key:  sourceKey,
		AffectedApplications: []types.NamespacedName{
			unrelatedID,
		},
	})
	require.NoError(t, err)
	require.True(t, result.Changed)
	afterStatus := requireSnapshot(t, index)
	require.Equal(t, ConnectionStateUnhealthy, afterStatus.Applications[boundID].ObservabilityConnection)
	require.Equal(t, ConnectionStateUnhealthy, afterStatus.Sources[sourceKey].Connection)
	require.Equal(t, mapIdentity(before.ByProject), mapIdentity(afterStatus.ByProject))
	require.Equal(t, unrelatedBindingsPointer, sliceDataPointer(afterStatus.sourceBindings[unrelatedID]),
		"targeted source update must share untouched binding slices")

	store.deleteOptionalSource(sourceKey)
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceOptionalSource, Key: sourceKey})
	require.NoError(t, err)
	require.True(t, result.Changed)
	afterDelete := requireSnapshot(t, index)
	require.NotContains(t, afterDelete.Sources, sourceKey)
	require.Equal(t, sourceKey, afterDelete.Applications[boundID].EffectiveObservabilitySource)
	require.Equal(t, ConnectionStateUnhealthy, afterDelete.Applications[boundID].ObservabilityConnection)
	require.Equal(t, idSet(boundID), afterDelete.BySource[sourceKey])

	store.putOptionalSource(optionalSourceConfigMap(sourceKey, ConnectionStateHealthy))
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceOptionalSource, Key: sourceKey})
	require.NoError(t, err)
	require.True(t, result.Changed)
	afterRecreate := requireSnapshot(t, index)
	require.Equal(t, ConnectionStateHealthy, afterRecreate.Applications[boundID].ObservabilityConnection)
	require.Equal(t, idSet(boundID), afterRecreate.BySource[sourceKey])
}

func TestOptionalSourceProjectUpdateDeleteRecreateRebindsExactProject(t *testing.T) {
	t.Parallel()

	store := newOptionalProjectionStore()
	sourceA := fleetID("apps", "source-a")
	sourceB := fleetID("apps", "source-b")
	sourceC := fleetID("apps", "source-c")
	projector := &fakeOptionalSourceProjector{bindingsByProjectDescription: map[string][]types.NamespacedName{
		"initial": {sourceA, sourceB},
		"updated": {sourceA, sourceC},
		"other":   {fleetID("apps", "other-source")},
	}}
	first, project := optionalSourceApplication("apps", "checkout", "retail", "initial")
	second := projectionApplication("apps", "catalog", "catalog-uid")
	second.Spec.Project = project.Name
	unrelated, unrelatedProject := optionalSourceApplication("apps", "payments", "other", "other")
	store.putApplication(first)
	store.putApplication(second)
	store.putApplication(unrelated)
	store.putProject(project)
	store.putProject(unrelatedProject)
	for _, key := range []types.NamespacedName{sourceA, sourceB, sourceC, fleetID("apps", "other-source")} {
		store.putOptionalSource(optionalSourceConfigMap(key, ConnectionStateHealthy))
	}

	index := NewIndex()
	rebuilder := NewRebuilder(index, store, projector)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	firstID, secondID, unrelatedID := clientKey(first), clientKey(second), clientKey(unrelated)
	projectKey := clientKey(project)
	store.setApplicationGetError(unrelatedID, context.Canceled)
	store.fakeProjectionStore.mutateProject(projectKey, func(candidate *corev1alpha1.AppProject) {
		candidate.Spec.Description = "updated"
	})

	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceAppProject, Key: projectKey})
	require.NoError(t, err)
	require.True(t, result.Changed)
	afterUpdate := requireSnapshot(t, index)
	for _, appID := range []types.NamespacedName{firstID, secondID} {
		require.Equal(t, sourceA, afterUpdate.Applications[appID].EffectiveObservabilitySource)
		require.Equal(t, []types.NamespacedName{sourceA, sourceC}, afterUpdate.sourceBindings[appID])
	}
	require.NotContains(t, afterUpdate.BySource, sourceB)
	require.Equal(t, idSet(firstID, secondID), afterUpdate.BySource[sourceC])
	require.Equal(t, fleetID("apps", "other-source"), afterUpdate.Applications[unrelatedID].EffectiveObservabilitySource)

	store.fakeProjectionStore.deleteProject(projectKey)
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceAppProject, Key: projectKey})
	require.NoError(t, err)
	require.True(t, result.Changed)
	afterDelete := requireSnapshot(t, index)
	require.NotContains(t, afterDelete.Projects, projectKey)
	for _, appID := range []types.NamespacedName{firstID, secondID} {
		require.Equal(t, projectKey, afterDelete.Applications[appID].Project)
		require.Zero(t, afterDelete.Applications[appID].EffectiveObservabilitySource)
		require.Equal(t, ConnectionStateNotConfigured, afterDelete.Applications[appID].ObservabilityConnection)
	}
	require.Equal(t, idSet(firstID, secondID), afterDelete.ByProject[projectKey])
	require.NotContains(t, afterDelete.BySource, sourceA)
	require.NotContains(t, afterDelete.BySource, sourceC)

	recreated := project.DeepCopy()
	recreated.Spec.Description = "initial"
	store.fakeProjectionStore.putProject(recreated)
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceAppProject, Key: projectKey})
	require.NoError(t, err)
	require.True(t, result.Changed)
	afterRecreate := requireSnapshot(t, index)
	require.Equal(t, sourceA, afterRecreate.Applications[firstID].EffectiveObservabilitySource)
	require.Equal(t, idSet(firstID, secondID), afterRecreate.BySource[sourceB])
}

func TestOptionalSourceBadSummaryFailsClosedWithoutPublication(t *testing.T) {
	t.Parallel()

	store := newOptionalProjectionStore()
	sourceKey := fleetID("apps", "prometheus")
	projector := &fakeOptionalSourceProjector{bindingsByProjectDescription: map[string][]types.NamespacedName{
		"bound": {sourceKey},
	}}
	app, project := optionalSourceApplication("apps", "checkout", "retail", "bound")
	store.putApplication(app)
	store.putProject(project)
	store.putOptionalSource(optionalSourceConfigMap(sourceKey, ConnectionStateHealthy))
	index := NewIndex()
	rebuilder := NewRebuilder(index, store, projector)
	_, err := rebuilder.Rebuild(context.Background())
	require.NoError(t, err)
	before := requireSnapshot(t, index)

	broken := optionalSourceConfigMap(sourceKey, ConnectionStateUnhealthy)
	broken.Annotations[optionalSummaryErrorAnnotation] = "https://user:secret@example.invalid/private"
	store.putOptionalSource(broken)
	result, err := rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceOptionalSource, Key: sourceKey})
	require.Error(t, err)
	require.NotContains(t, err.Error(), "secret")
	require.False(t, result.Changed)
	require.Same(t, before, requireSnapshot(t, index))

	mismatched := optionalSourceConfigMap(sourceKey, ConnectionStateUnhealthy)
	mismatched.Annotations[optionalIdentityAnnotation] = "different"
	store.putOptionalSource(mismatched)
	result, err = rebuilder.ApplyDelta(context.Background(), ResourceDelta{Kind: ResourceOptionalSource, Key: sourceKey})
	require.Error(t, err)
	require.False(t, result.Changed)
	require.Same(t, before, requireSnapshot(t, index))
}

func TestOptionalSourceCrossNamespaceAndProjectMismatchFailClosed(t *testing.T) {
	t.Parallel()

	t.Run("cross namespace binding", func(t *testing.T) {
		store := newOptionalProjectionStore()
		app, project := optionalSourceApplication("apps", "checkout", "retail", "cross")
		projector := &fakeOptionalSourceProjector{bindingsByProjectDescription: map[string][]types.NamespacedName{
			"cross": {fleetID("other", "prometheus")},
		}}
		store.putApplication(app)
		store.putProject(project)
		index := NewIndex()
		result, err := NewRebuilder(index, store, projector).Rebuild(context.Background())
		require.NoError(t, err)
		require.Equal(t, uint64(1), result.ProjectionErrorCount)
		snapshot := requireSnapshot(t, index)
		summary := snapshot.Applications[clientKey(app)]
		require.Zero(t, summary.EffectiveObservabilitySource)
		require.Equal(t, ConnectionStateUnhealthy, summary.ObservabilityConnection)
		require.Empty(t, snapshot.BySource)
	})

	t.Run("source belongs to another project", func(t *testing.T) {
		store := newOptionalProjectionStore()
		app, project := optionalSourceApplication("apps", "checkout", "retail", "bound")
		sourceKey := fleetID("apps", "prometheus")
		projector := &fakeOptionalSourceProjector{bindingsByProjectDescription: map[string][]types.NamespacedName{
			"bound": {sourceKey},
		}}
		store.putApplication(app)
		store.putProject(project)
		source := optionalSourceConfigMap(sourceKey, ConnectionStateHealthy)
		source.Annotations[optionalProjectAnnotation] = "other"
		store.putOptionalSource(source)
		index := NewIndex()
		result, err := NewRebuilder(index, store, projector).Rebuild(context.Background())
		require.NoError(t, err)
		require.Equal(t, uint64(1), result.ProjectionErrorCount)
		snapshot := requireSnapshot(t, index)
		summary := snapshot.Applications[clientKey(app)]
		require.Equal(t, sourceKey, summary.EffectiveObservabilitySource)
		require.Equal(t, ConnectionStateUnhealthy, summary.ObservabilityConnection)
		require.Equal(t, idSet(clientKey(app)), snapshot.BySource[sourceKey])
	})
}

func TestOptionalSourceSnapshotInstallDefensivelyClonesBindingsAndMaps(t *testing.T) {
	t.Parallel()

	appID := fleetID("apps", "checkout")
	sourceKey := fleetID("apps", "prometheus")
	builder := NewSnapshot(7)
	summary := ApplicationSummary{
		Identity:                     appID,
		Project:                      fleetID("apps", "retail"),
		EffectiveObservabilitySource: sourceKey,
		ObservabilityConnection:      ConnectionStateHealthy,
		ObservabilityBindings:        []types.NamespacedName{sourceKey},
	}
	builder.Sources[sourceKey] = SourceSummary{Identity: sourceKey, Connection: ConnectionStateHealthy}
	addApplicationMutable(builder, &summary)

	index := NewIndex()
	require.NoError(t, index.Install(builder))
	installed := requireSnapshot(t, index)

	mutated := builder.Applications[appID]
	mutated.ObservabilityBindings[0] = fleetID("apps", "mutated")
	builder.Applications[appID] = mutated
	builder.Sources[sourceKey] = SourceSummary{Identity: sourceKey, Connection: ConnectionStateUnhealthy}
	delete(builder.BySource[sourceKey], appID)

	require.Equal(t, []types.NamespacedName{sourceKey}, installed.sourceBindings[appID])
	require.Equal(t, ConnectionStateHealthy, installed.Sources[sourceKey].Connection)
	require.Equal(t, idSet(appID), installed.BySource[sourceKey])
}

const (
	optionalConnectionAnnotation   = "test.paprika.io/connection"
	optionalSummaryErrorAnnotation = "test.paprika.io/summary-error"
	optionalIdentityAnnotation     = "test.paprika.io/identity"
	optionalProjectAnnotation      = "test.paprika.io/project"
)

type fakeOptionalSourceProjector struct {
	bindingsByProjectDescription map[string][]types.NamespacedName
}

func (*fakeOptionalSourceProjector) Prototype() client.Object {
	return &corev1.ConfigMap{}
}

func (*fakeOptionalSourceProjector) Summarize(object client.Object) (SourceSummary, error) {
	configMap, ok := object.(*corev1.ConfigMap)
	if !ok {
		return SourceSummary{}, errors.New("unexpected optional source type")
	}
	if message := configMap.Annotations[optionalSummaryErrorAnnotation]; message != "" {
		return SourceSummary{}, errors.New(message)
	}
	key := clientKey(configMap)
	if replacement := configMap.Annotations[optionalIdentityAnnotation]; replacement != "" {
		key.Name = replacement
	}
	summary := SourceSummary{
		Identity:   key,
		Connection: parseTestConnectionState(configMap.Annotations[optionalConnectionAnnotation]),
	}
	if projectName := configMap.Annotations[optionalProjectAnnotation]; projectName != "" {
		summary.Project = fleetID(configMap.Namespace, projectName)
	}
	return summary, nil
}

func (p *fakeOptionalSourceProjector) Bindings(
	_ *pipelinesv1alpha1.Application,
	project *corev1alpha1.AppProject,
	_ []pipelinesv1alpha1.Stage,
) []types.NamespacedName {
	if project == nil {
		return nil
	}
	return p.bindingsByProjectDescription[project.Spec.Description]
}

func parseTestConnectionState(value string) ConnectionState {
	switch value {
	case "healthy":
		return ConnectionStateHealthy
	case "unhealthy":
		return ConnectionStateUnhealthy
	case "disabled":
		return ConnectionStateDisabled
	case "not-configured":
		return ConnectionStateNotConfigured
	default:
		return ConnectionStateUnspecified
	}
}

func optionalSourceConfigMap(key types.NamespacedName, connection ConnectionState) *corev1.ConfigMap {
	return &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: key.Namespace,
			Name:      key.Name,
			Annotations: map[string]string{
				optionalConnectionAnnotation: strings.ToLower(strings.TrimPrefix(connectionName(connection), "ConnectionState")),
			},
		},
	}
}

func connectionName(connection ConnectionState) string {
	switch connection {
	case ConnectionStateUnspecified:
		return "unspecified"
	case ConnectionStateHealthy:
		return "healthy"
	case ConnectionStateUnhealthy:
		return "unhealthy"
	case ConnectionStateDisabled:
		return "disabled"
	case ConnectionStateNotConfigured:
		return "not-configured"
	default:
		return "unspecified"
	}
}

func optionalSourceApplication(
	namespace, name, projectName, projectDescription string,
) (*pipelinesv1alpha1.Application, *corev1alpha1.AppProject) {
	app := projectionApplication(namespace, name, name+"-uid")
	app.Spec.Project = projectName
	project := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: projectName},
		Spec:       corev1alpha1.AppProjectSpec{Description: projectDescription},
	}
	return app, project
}

type optionalProjectionStore struct {
	*fakeProjectionStore
	optionalSources map[types.NamespacedName]client.Object
}

func newOptionalProjectionStore() *optionalProjectionStore {
	return &optionalProjectionStore{
		fakeProjectionStore: newFakeProjectionStore(),
		optionalSources:     make(map[types.NamespacedName]client.Object),
	}
}

func (s *optionalProjectionStore) ListOptionalSources(
	_ context.Context,
	_ client.Object,
) ([]client.Object, error) {
	s.fakeProjectionStore.mu.Lock()
	defer s.fakeProjectionStore.mu.Unlock()
	result := make([]client.Object, 0, len(s.optionalSources))
	for _, object := range s.optionalSources {
		copyObject, ok := copyOptionalSourceObject(object)
		if !ok {
			return nil, errors.New("invalid optional source test object")
		}
		result = append(result, copyObject)
	}
	return result, nil
}

func (s *optionalProjectionStore) GetOptionalSource(
	_ context.Context,
	_ client.Object,
	key types.NamespacedName,
) (client.Object, bool, error) {
	s.fakeProjectionStore.mu.Lock()
	defer s.fakeProjectionStore.mu.Unlock()
	object, ok := s.optionalSources[key]
	if !ok {
		return nil, false, nil
	}
	copyObject, copied := copyOptionalSourceObject(object)
	if !copied {
		return nil, false, errors.New("invalid optional source test object")
	}
	return copyObject, true, nil
}

func (s *optionalProjectionStore) putOptionalSource(object client.Object) {
	s.fakeProjectionStore.mu.Lock()
	defer s.fakeProjectionStore.mu.Unlock()
	copyObject, copied := copyOptionalSourceObject(object)
	if !copied {
		panic("invalid optional source test object")
	}
	s.optionalSources[clientKey(object)] = copyObject
}

func (s *optionalProjectionStore) deleteOptionalSource(key types.NamespacedName) {
	s.fakeProjectionStore.mu.Lock()
	defer s.fakeProjectionStore.mu.Unlock()
	delete(s.optionalSources, key)
}
