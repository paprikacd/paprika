package auth

import (
	"context"
	"fmt"

	"sigs.k8s.io/controller-runtime/pkg/client"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
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
func (e *ProjectEnforcer) AuthorizeApplication(ctx context.Context, appNamespace, appProject, sourceRepo, kind string) error {
	if appProject == "" {
		return nil
	}

	var project corev1alpha1.AppProject
	if err := e.client.Get(ctx, client.ObjectKey{Name: appProject, Namespace: appNamespace}, &project); err != nil {
		return fmt.Errorf("get appproject %s/%s: %w", appNamespace, appProject, err)
	}

	if err := checkList(project.Spec.SourceRepos, sourceRepo, globMatch, "source repo %q not allowed by project %s", sourceRepo, appProject); err != nil {
		return err
	}
	if err := checkDenyList(project.Spec.SourceReposDeny, sourceRepo, globMatch, "source repo %q denied by project %s", sourceRepo, appProject); err != nil {
		return err
	}
	if kind == "" {
		return nil
	}
	if err := checkList(project.Spec.Kinds, kind, kindMatch, "kind %q not allowed by project %s", kind, appProject); err != nil {
		return err
	}
	return checkDenyList(project.Spec.KindsDeny, kind, kindMatch, "kind %q denied by project %s", kind, appProject)
}

func kindMatch(a, b string) bool {
	return a == b || a == "*"
}

func checkList(items []string, value string, match func(string, string) bool, format string, args ...any) error {
	if len(items) == 0 {
		return nil
	}
	for _, item := range items {
		if match(item, value) {
			return nil
		}
	}
	return fmt.Errorf(format, args...)
}

func checkDenyList(items []string, value string, match func(string, string) bool, format string, args ...any) error {
	for _, item := range items {
		if match(item, value) {
			return fmt.Errorf(format, args...)
		}
	}
	return nil
}

func globMatch(pattern, s string) bool {
	if pattern == "" {
		return s == ""
	}
	if pattern == "*" {
		return true
	}
	if pattern != "" && pattern[len(pattern)-1] == '*' {
		return len(s) >= len(pattern)-1 && s[:len(pattern)-1] == pattern[:len(pattern)-1]
	}
	return pattern == s
}
