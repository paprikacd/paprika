package fleet

import (
	"context"
	"errors"

	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// OptionalSourceProjector is the provider-neutral seam implemented by a later
// observability plan. Plan 1 supplies nil and imports no future CRD package.
type OptionalSourceProjector interface {
	Prototype() client.Object
	Summarize(client.Object) (SourceSummary, error)
	// project is nil after AppProject deletion.
	Bindings(
		app *pipelinesv1alpha1.Application,
		project *corev1alpha1.AppProject,
		stages []pipelinesv1alpha1.Stage,
	) []types.NamespacedName
}

// OptionalSourceStore is separate from the frozen seven-CRD ProjectionStore.
// A cache adapter implements it only when an optional projector is registered.
type OptionalSourceStore interface {
	ListOptionalSources(context.Context, client.Object) ([]client.Object, error)
	GetOptionalSource(context.Context, client.Object, types.NamespacedName) (client.Object, bool, error)
}

func optionalSourcePrototype(projector OptionalSourceProjector) (client.Object, error) {
	if projector == nil {
		return nil, nil
	}
	prototype := projector.Prototype()
	if prototype == nil {
		return nil, errors.New("optional source projector returned a nil prototype")
	}
	copyObject, ok := prototype.DeepCopyObject().(client.Object)
	if !ok || copyObject == nil {
		return nil, errors.New("optional source projector prototype is not a client object")
	}
	return copyObject, nil
}

func copyOptionalSourceObject(object client.Object) (client.Object, bool) {
	if object == nil {
		return nil, false
	}
	copyObject, ok := object.DeepCopyObject().(client.Object)
	return copyObject, ok && copyObject != nil
}

func projectOptionalSourceBinding(
	summary *ApplicationSummary,
	application *pipelinesv1alpha1.Application,
	project *corev1alpha1.AppProject,
	stages []*pipelinesv1alpha1.Stage,
	projector OptionalSourceProjector,
	sources map[SourceKey]SourceSummary,
) ProjectionResult {
	if projector == nil {
		summary.ObservabilityConnection = ConnectionStateNotConfigured
		return ProjectionResult{}
	}

	applicationCopy := application.DeepCopy()
	var projectCopy *corev1alpha1.AppProject
	if project != nil {
		projectCopy = project.DeepCopy()
	}
	stageCopies := make([]pipelinesv1alpha1.Stage, 0, len(stages))
	for _, stage := range stages {
		if stage != nil {
			stageCopies = append(stageCopies, *stage.DeepCopy())
		}
	}

	rawBindings := projector.Bindings(applicationCopy, projectCopy, stageCopies)
	bindings, valid := normalizeOptionalBindings(application.Namespace, rawBindings)
	if !valid {
		summary.ObservabilityConnection = ConnectionStateUnhealthy
		return ProjectionResult{ProjectionErrorCount: 1}
	}
	summary.ObservabilityBindings = bindings
	if len(bindings) == 0 {
		summary.ObservabilityBindings = nil
		summary.ObservabilityConnection = ConnectionStateNotConfigured
		return ProjectionResult{}
	}
	return projectOptionalBindingConnection(summary, bindings, sources)
}

func projectOptionalBindingConnection(
	summary *ApplicationSummary,
	bindings []types.NamespacedName,
	sources map[SourceKey]SourceSummary,
) ProjectionResult {
	summary.EffectiveObservabilitySource = bindings[0]
	for _, binding := range bindings {
		boundSource, found := sources[binding]
		if found && boundSource.Project != (ProjectKey{}) && boundSource.Project != summary.Project {
			summary.ObservabilityConnection = ConnectionStateUnhealthy
			return ProjectionResult{ProjectionErrorCount: 1}
		}
	}
	source, found := sources[bindings[0]]
	if !found {
		summary.ObservabilityConnection = ConnectionStateUnhealthy
		return ProjectionResult{}
	}
	summary.ObservabilityConnection = source.Connection
	return ProjectionResult{}
}

func normalizeOptionalBindings(
	namespace string,
	raw []types.NamespacedName,
) ([]types.NamespacedName, bool) {
	seen := make(map[types.NamespacedName]struct{}, len(raw))
	bindings := make([]types.NamespacedName, 0, len(raw))
	for _, key := range raw {
		if key.Name == "" {
			continue
		}
		if key.Namespace == "" {
			key.Namespace = namespace
		}
		if key.Namespace != namespace {
			return nil, false
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		bindings = append(bindings, key)
	}
	return bindings, true
}

func validSourceSummary(expected SourceKey, summary SourceSummary) bool {
	if expected == (SourceKey{}) || summary.Identity != expected {
		return false
	}
	if summary.Project != (ProjectKey{}) &&
		(summary.Project.Name == "" || summary.Project.Namespace != expected.Namespace) {
		return false
	}
	switch summary.Connection {
	case ConnectionStateUnspecified,
		ConnectionStateHealthy,
		ConnectionStateUnhealthy,
		ConnectionStateDisabled,
		ConnectionStateNotConfigured:
		return true
	default:
		return false
	}
}
