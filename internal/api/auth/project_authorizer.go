// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects,verbs=get;list;watch;create;update

package auth

import (
	"context"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
)

type ProjectAuthorizer struct {
	client client.Reader
}

func NewProjectAuthorizer(c client.Reader) *ProjectAuthorizer {
	return &ProjectAuthorizer{client: c}
}

func (a *ProjectAuthorizer) Authorize(ctx context.Context, p *Principal, action Action, resource Resource, namespace, project string) error {
	if project == "" {
		return nil
	}
	if namespace == "" {
		namespace = "default"
	}
	var ap corev1alpha1.AppProject
	if err := a.client.Get(ctx, client.ObjectKey{Name: project, Namespace: namespace}, &ap); err != nil {
		if apierrors.IsNotFound(err) && project == "default" {
			return nil
		}
		return fmt.Errorf("get appproject %s/%s: %w", namespace, project, err)
	}

	for _, role := range ap.Spec.Roles {
		if !actionAllowed(role.Actions, action) {
			continue
		}
		if subjectMatches(role.Subjects, p) {
			return nil
		}
	}
	return fmt.Errorf("principal %q cannot %s %s in project %q: %w", p.Subject, action, resource, project, ErrUnauthorized)
}

// actionAllowed reports whether the supplied role actions permit action.
func actionAllowed(actions []string, action Action) bool {
	for _, a := range actions {
		if a == "*" || a == string(action) {
			return true
		}
		if a == "admin" {
			return true
		}
		if a == "write" && action == ActionRead {
			return true
		}
	}
	return false
}

// subjectMatches reports whether the principal matches one of the role subjects.
// Subjects are opaque strings; conventions such as "serviceaccount:<ns>:<name>"
// must match the principal subject produced by the configured authenticator.
func subjectMatches(subjects []string, p *Principal) bool {
	for _, s := range subjects {
		if s == "*" {
			return true
		}
		if s == p.Subject {
			return true
		}
		if strings.HasPrefix(s, "group:") {
			if p.IsInGroup(strings.TrimPrefix(s, "group:")) {
				return true
			}
		}
	}
	return false
}
