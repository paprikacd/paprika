package v1alpha1

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
)

func TestAppProjectCustomValidator_validateAppProject(t *testing.T) {
	v := &AppProjectCustomValidator{}

	t.Run("valid empty project", func(t *testing.T) {
		p := &corev1alpha1.AppProject{ObjectMeta: metav1.ObjectMeta{Name: "p"}}
		require.NoError(t, v.validateAppProject(p))
	})

	t.Run("overlapping source allow/deny", func(t *testing.T) {
		p := &corev1alpha1.AppProject{
			ObjectMeta: metav1.ObjectMeta{Name: "p"},
			Spec: corev1alpha1.AppProjectSpec{
				SourceRepos:     []string{"https://github.com/org/allowed"},
				SourceReposDeny: []string{"https://github.com/org/allowed"},
			},
		}
		err := v.validateAppProject(p)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "also appears in allow list")
	})

	t.Run("overlapping kinds allow/deny", func(t *testing.T) {
		p := &corev1alpha1.AppProject{
			ObjectMeta: metav1.ObjectMeta{Name: "p"},
			Spec: corev1alpha1.AppProjectSpec{
				Kinds:     []string{"Deployment"},
				KindsDeny: []string{"Deployment"},
			},
		}
		err := v.validateAppProject(p)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "also appears in allow list")
	})
}

func TestAppProjectValidator_RejectsEmptyDestination(t *testing.T) {
	v := &AppProjectCustomValidator{}
	project := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "bad"},
		Spec: corev1alpha1.AppProjectSpec{
			Destinations: []corev1alpha1.AppProjectDestination{{}},
		},
	}
	_, err := v.ValidateCreate(context.Background(), project)
	require.Error(t, err)
}

func TestAppProjectCustomDefaulter_Default(t *testing.T) {
	d := &AppProjectCustomDefaulter{}
	p := &corev1alpha1.AppProject{ObjectMeta: metav1.ObjectMeta{Name: "p"}}
	require.NoError(t, d.Default(context.Background(), p))
}
