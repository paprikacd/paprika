// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects,verbs=get;list;watch;create;update

package governance

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const defaultProjectDescription = "Auto-generated permissive default project"

type ProjectResolver struct {
	client client.Reader
}

func NewProjectResolver(c client.Reader) *ProjectResolver {
	return &ProjectResolver{client: c}
}

func (r *ProjectResolver) Resolve(ctx context.Context, obj client.Object) (*corev1alpha1.AppProject, error) {
	switch t := obj.(type) {
	case *pipelinesv1alpha1.Application:
		if t == nil {
			return nil, fmt.Errorf("nil %T", obj)
		}
		return r.resolveByName(ctx, t.Namespace, t.Spec.Project)
	case *pipelinesv1alpha1.Template:
		if t == nil {
			return nil, fmt.Errorf("nil %T", obj)
		}
		return r.resolveFromOwnerApplication(ctx, t.Namespace, t.OwnerReferences)
	case *pipelinesv1alpha1.Stage:
		if t == nil {
			return nil, fmt.Errorf("nil %T", obj)
		}
		return r.resolveFromOwnerApplication(ctx, t.Namespace, t.OwnerReferences)
	default:
		return nil, fmt.Errorf("unsupported object type %T", obj)
	}
}

func (r *ProjectResolver) resolveFromOwnerApplication(ctx context.Context, namespace string, owners []metav1.OwnerReference) (*corev1alpha1.AppProject, error) {
	app, err := r.resolveOwnerApplication(ctx, namespace, owners)
	if err != nil {
		return nil, err
	}
	return r.resolveByName(ctx, app.Namespace, app.Spec.Project)
}

func (r *ProjectResolver) resolveOwnerApplication(ctx context.Context, namespace string, owners []metav1.OwnerReference) (*pipelinesv1alpha1.Application, error) {
	for _, ref := range owners {
		if ref.Kind == "Application" && ref.APIVersion == pipelinesv1alpha1.GroupVersion.String() {
			var app pipelinesv1alpha1.Application
			if err := r.client.Get(ctx, client.ObjectKey{Name: ref.Name, Namespace: namespace}, &app); err != nil {
				return nil, fmt.Errorf("get application %s/%s: %w", namespace, ref.Name, err)
			}
			return &app, nil
		}
	}
	return nil, fmt.Errorf("no Application owner reference found") //nolint:perfsprint // consistency with other error constructors
}

func (r *ProjectResolver) resolveByName(ctx context.Context, namespace, name string) (*corev1alpha1.AppProject, error) {
	if name == "" {
		name = "default"
	}
	var project corev1alpha1.AppProject
	if err := r.client.Get(ctx, client.ObjectKey{Name: name, Namespace: namespace}, &project); err != nil {
		if apierrors.IsNotFound(err) && name == "default" {
			log.FromContext(ctx).Info("Returning permissive default project; create an AppProject/default to enforce boundaries", "namespace", namespace)
			return permissiveDefaultProject(namespace), nil
		}
		return nil, fmt.Errorf("get appproject %s/%s: %w", namespace, name, err)
	}
	return &project, nil
}

func permissiveDefaultProject(namespace string) *corev1alpha1.AppProject {
	return &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "default", Namespace: namespace},
		Spec: corev1alpha1.AppProjectSpec{
			Description: defaultProjectDescription,
			Destinations: []corev1alpha1.AppProjectDestination{
				{Server: "*", Namespace: "*"},
			},
			SourceRepos:              []string{"*"},
			Kinds:                    []string{"*"},
			ClusterResourceWhitelist: []string{"*"},
		},
	}
}
