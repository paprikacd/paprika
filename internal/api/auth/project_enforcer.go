package auth

import (
	"context"
	"fmt"

	"sigs.k8s.io/controller-runtime/pkg/client"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
)

// ProjectEnforcer validates resource operations against AppProject constraints.
type ProjectEnforcer struct {
	client client.Client
}

// NewProjectEnforcer creates a new enforcer.
func NewProjectEnforcer(c client.Client) *ProjectEnforcer {
	return &ProjectEnforcer{client: c}
}

// AuthorizeApplication checks whether an application conforms to its project's constraints.
// repoRef is the optional name of a core.paprika.io Repository referenced by the application.
func (e *ProjectEnforcer) AuthorizeApplication(ctx context.Context, appNamespace, appProject, sourceRepo, repoRef, kind string) error {
	if appProject == "" {
		return nil
	}

	var project corev1alpha1.AppProject
	if err := e.client.Get(ctx, client.ObjectKey{Name: appProject, Namespace: appNamespace}, &project); err != nil {
		return fmt.Errorf("get appproject %s/%s: %w", appNamespace, appProject, err)
	}

	if err := governance.CheckList(project.Spec.SourceRepos, sourceRepo, governance.GlobMatch, "source repo %q not allowed by project %s", sourceRepo, appProject); err != nil {
		return fmt.Errorf("source repo check: %w", err)
	}
	if err := governance.CheckDenyList(project.Spec.SourceReposDeny, sourceRepo, governance.GlobMatch, "source repo %q denied by project %s", sourceRepo, appProject); err != nil {
		return fmt.Errorf("source repo deny check: %w", err)
	}
	if repoRef != "" {
		if err := governance.CheckList(project.Spec.Repositories, repoRef, governance.StringEqual, "repository %q not allowed by project %s", repoRef, appProject); err != nil {
			return fmt.Errorf("repository check: %w", err)
		}
	}
	if kind == "" {
		return nil
	}
	if err := governance.CheckList(project.Spec.Kinds, kind, governance.GlobMatch, "kind %q not allowed by project %s", kind, appProject); err != nil {
		return fmt.Errorf("kind check: %w", err)
	}
	if err := governance.CheckDenyList(project.Spec.KindsDeny, kind, governance.GlobMatch, "kind %q denied by project %s", kind, appProject); err != nil {
		return fmt.Errorf("kind deny check: %w", err)
	}
	return nil
}
