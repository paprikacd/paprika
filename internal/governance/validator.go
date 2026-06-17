// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects,verbs=get;list;watch;create;update

package governance

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

type ProjectValidator struct {
	resolver        *ProjectResolver
	clusterResolver ClusterResolver
	restMapper      meta.RESTMapper
}

func NewProjectValidator(resolver *ProjectResolver, clusterResolver ClusterResolver, restMapper meta.RESTMapper) *ProjectValidator {
	return &ProjectValidator{
		resolver:        resolver,
		clusterResolver: clusterResolver,
		restMapper:      restMapper,
	}
}

// ResolveProject looks up an AppProject by namespace and name.
func (v *ProjectValidator) ResolveProject(ctx context.Context, namespace, name string) (*corev1alpha1.AppProject, error) {
	return v.resolver.resolveByName(ctx, namespace, name)
}

func (v *ProjectValidator) Validate(ctx context.Context, app *pipelinesv1alpha1.Application, manifests []*unstructured.Unstructured, project *corev1alpha1.AppProject) (Violations, error) {
	return v.validate(ctx, project, app.Spec.Source, app.Spec.Stages, app.Namespace, "", manifests)
}

// ValidateBundle validates a bundle. defaultNs is the namespace to use when a ClusterRef has no namespace.
// server is the destination Kubernetes API server for the manifests; if empty it defaults to the in-cluster server.
//
//nolint:gocritic // heavy CRD struct passed by value per API
func (v *ProjectValidator) ValidateBundle(ctx context.Context, project *corev1alpha1.AppProject, source pipelinesv1alpha1.ApplicationSource, stages []pipelinesv1alpha1.ApplicationPromotionStage, defaultNs, server string, manifests []*unstructured.Unstructured) (Violations, error) {
	return v.validate(ctx, project, source, stages, defaultNs, server, manifests)
}

//nolint:gocritic // heavy CRD struct passed by value per API
func (v *ProjectValidator) validate(ctx context.Context, project *corev1alpha1.AppProject, source pipelinesv1alpha1.ApplicationSource, stages []pipelinesv1alpha1.ApplicationPromotionStage, defaultNs, server string, manifests []*unstructured.Unstructured) (Violations, error) {
	violations := validateSource(project, source)

	stageViolations, err := v.validateStages(ctx, project, stages, defaultNs)
	if err != nil {
		return violations, err
	}
	violations = append(violations, stageViolations...)

	manifestServer := server
	if manifestServer == "" {
		manifestServer = defaultInClusterServer
	}
	manifestViolations, err := v.validateManifests(project, manifests, manifestServer)
	if err != nil {
		return violations, err
	}
	violations = append(violations, manifestViolations...)

	return violations, nil
}

//nolint:gocritic // heavy CRD struct passed by value per API
func validateSource(project *corev1alpha1.AppProject, source pipelinesv1alpha1.ApplicationSource) Violations {
	var violations Violations
	if source.RepoURL != "" {
		if err := CheckDenyList(project.Spec.SourceReposDeny, source.RepoURL, GlobMatch, "source repo %q denied by project %s", source.RepoURL, project.Name); err != nil {
			violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
		} else if err := CheckList(project.Spec.SourceRepos, source.RepoURL, GlobMatch, "source repo %q not allowed by project %s", source.RepoURL, project.Name); err != nil {
			violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
		}
	}
	if source.RepoRef != "" {
		if err := CheckList(project.Spec.Repositories, source.RepoRef, StringEqual, "repository %q not allowed by project %s", source.RepoRef, project.Name); err != nil {
			violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
		}
	}
	return violations
}

func (v *ProjectValidator) validateStages(ctx context.Context, project *corev1alpha1.AppProject, stages []pipelinesv1alpha1.ApplicationPromotionStage, defaultNs string) (Violations, error) {
	var violations Violations
	for i := range stages {
		stage := &stages[i]
		stageServer, err := v.clusterResolver.ResolveServer(ctx, defaultNs, stage.Cluster)
		if err != nil {
			return violations, fmt.Errorf("resolve cluster for stage %q: %w", stage.Name, err)
		}
		if !destinationAllowed(project.Spec.Destinations, stageServer, stage.Cluster.Name) {
			violations = append(violations, Violation{
				Rule:    "project",
				Message: fmt.Sprintf("stage %q cluster not allowed by project %s", stage.Name, project.Name),
				Action:  PolicyActionEnforce,
			})
		}
		if defaultNs != "" && len(project.Spec.Destinations) > 0 && !namespaceAllowed(project.Spec.Destinations, stageServer, defaultNs) {
			violations = append(violations, Violation{
				Rule:    "project",
				Message: fmt.Sprintf("stage %q namespace %q not allowed by project %s", stage.Name, defaultNs, project.Name),
				Action:  PolicyActionEnforce,
			})
		}
	}
	return violations, nil
}

//nolint:cyclop // manifest validation has many independent rules
func (v *ProjectValidator) validateManifests(project *corev1alpha1.AppProject, manifests []*unstructured.Unstructured, manifestServer string) (Violations, error) {
	var violations Violations
	for _, m := range manifests {
		kind := m.GetKind()
		if kind != "" {
			if err := CheckDenyList(project.Spec.KindsDeny, kind, GlobMatch, "kind %q denied by project %s", kind, project.Name); err != nil {
				violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
			} else if err := CheckList(project.Spec.Kinds, kind, GlobMatch, "kind %q not allowed by project %s", kind, project.Name); err != nil {
				violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
			}
		}

		clusterScoped, err := v.isClusterScoped(m)
		if err != nil {
			return violations, err
		}
		if clusterScoped {
			if err := CheckDenyList(project.Spec.ClusterResourceBlacklist, kind, GlobMatch, "cluster-scoped kind %q denied by project %s", kind, project.Name); err != nil {
				violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
			} else if err := CheckList(project.Spec.ClusterResourceWhitelist, kind, GlobMatch, "cluster-scoped kind %q not allowed by project %s", kind, project.Name); err != nil {
				violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
			}
		}

		ns := m.GetNamespace()
		if ns != "" && len(project.Spec.Destinations) > 0 {
			if !namespaceAllowed(project.Spec.Destinations, manifestServer, ns) {
				violations = append(violations, Violation{
					Rule:    "project",
					Message: fmt.Sprintf("namespace %q not allowed by project %s", ns, project.Name),
					Action:  PolicyActionEnforce,
				})
			}
		}
	}
	return violations, nil
}

func (v *ProjectValidator) isClusterScoped(obj *unstructured.Unstructured) (bool, error) {
	if v.restMapper == nil {
		return obj.GetNamespace() == "", nil
	}
	mapping, err := v.restMapper.RESTMapping(obj.GroupVersionKind().GroupKind())
	if err != nil {
		return obj.GetNamespace() == "", nil
	}
	return mapping.Scope.Name() == meta.RESTScopeNameRoot, nil
}

func destinationAllowed(destinations []corev1alpha1.AppProjectDestination, server, name string) bool {
	if len(destinations) == 0 {
		return true
	}
	for _, d := range destinations {
		if d.Server != "" && !GlobMatch(d.Server, server) {
			continue
		}
		if d.Name != "" && !GlobMatch(d.Name, name) {
			continue
		}
		return true
	}
	return false
}

func namespaceAllowed(destinations []corev1alpha1.AppProjectDestination, server, namespace string) bool {
	if len(destinations) == 0 {
		return true
	}
	for _, d := range destinations {
		if d.Server != "" && !GlobMatch(d.Server, server) {
			continue
		}
		if d.Namespace != "" && !GlobMatch(d.Namespace, namespace) {
			continue
		}
		return true
	}
	return false
}
