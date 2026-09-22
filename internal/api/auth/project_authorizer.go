// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects,verbs=get;list;watch;create;update

package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	toolscache "k8s.io/client-go/tools/cache"
	crcache "sigs.k8s.io/controller-runtime/pkg/cache"
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
	ap, err := a.appProject(ctx, namespace, project)
	if err != nil {
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

// AuthorizedProjects filters only the supplied candidates, preserving their
// order and full namespaced identity.
func (a *ProjectAuthorizer) AuthorizedProjects(
	ctx context.Context,
	p *Principal,
	action Action,
	resource Resource,
	candidates []ProjectRef,
) ([]ProjectRef, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	authorized := make([]ProjectRef, 0, len(candidates))
	for _, candidate := range candidates {
		err := a.Authorize(ctx, p, action, resource, candidate.Namespace, candidate.Name)
		switch {
		case err == nil:
			authorized = append(authorized, candidate)
		case errors.Is(err, ErrUnauthorized), apierrors.IsNotFound(err):
			continue
		default:
			return nil, fmt.Errorf("authorize project %s/%s: %w", candidate.Namespace, candidate.Name, err)
		}
	}
	return authorized, nil
}

// informerSource is the subset of crcache.Cache that exposes typed
// informers. The API server's informer-backed reader satisfies it; a plain
// client.Reader does not.
type informerSource interface {
	GetInformer(context.Context, client.Object, ...crcache.InformerGetOption) (crcache.Informer, error)
}

var _ informerSource = (crcache.Cache)(nil)

// appProject returns the AppProject for namespace/name. When the reader is
// informer-backed the object comes straight from the informer store —
// skipping the deep copy every client.Get performs — which matters because
// this lookup runs once per candidate per authorized request (and once per
// capability grant on fleet-scoped calls). The returned object is then the
// store's SHARED instance: it is only ever read, never mutated.
func (a *ProjectAuthorizer) appProject(ctx context.Context, namespace, name string) (*corev1alpha1.AppProject, error) {
	if source, ok := a.client.(informerSource); ok {
		informer, err := source.GetInformer(ctx, &corev1alpha1.AppProject{})
		if err == nil && informer.HasSynced() {
			if shared, ok := informer.(toolscache.SharedIndexInformer); ok {
				return appProjectFromIndexer(shared.GetIndexer(), namespace, name)
			}
		}
		// On GetInformer failure, an unsynced informer, or a non-shared
		// informer implementation, fall through to the plain client read
		// (which itself blocks until the informer syncs when cache-backed).
	}
	var ap corev1alpha1.AppProject
	if err := a.client.Get(ctx, client.ObjectKey{Name: name, Namespace: namespace}, &ap); err != nil {
		return nil, err
	}
	return &ap, nil
}

func appProjectFromIndexer(indexer toolscache.Indexer, namespace, name string) (*corev1alpha1.AppProject, error) {
	obj, exists, err := indexer.GetByKey(client.ObjectKey{Namespace: namespace, Name: name}.String())
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, apierrors.NewNotFound(
			corev1alpha1.GroupVersion.WithResource("appprojects").GroupResource(), name)
	}
	ap, ok := obj.(*corev1alpha1.AppProject)
	if !ok {
		return nil, fmt.Errorf("appproject informer returned %T", obj)
	}
	return ap, nil
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
