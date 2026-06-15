// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects,verbs=get;list;watch;create;update

package bootstrap

import (
	"context"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
)

// EnsureDefaultAppProject creates the permissive default project if missing.
func EnsureDefaultAppProject(ctx context.Context, c client.Client, namespace string) error {
	project := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "default",
			Namespace: namespace,
		},
		Spec: corev1alpha1.AppProjectSpec{
			SourceRepos: []string{"*"},
			Destinations: []corev1alpha1.AppProjectDestination{
				{Server: "*", Namespace: "*"},
			},
			Kinds: []string{"*"},
			Roles: []corev1alpha1.AppProjectRole{
				{Name: "default", Subjects: []string{"*"}, Actions: []string{"read", "write"}},
			},
		},
	}
	if err := c.Create(ctx, project); err != nil && !apierrors.IsAlreadyExists(err) {
		return err
	}
	return nil
}
