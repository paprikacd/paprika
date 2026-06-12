package v1alpha1

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
)

func TestRepositoryCustomValidator_validateRepository(t *testing.T) {
	v := &RepositoryCustomValidator{}

	t.Run("valid git repository", func(t *testing.T) {
		repo := &corev1alpha1.Repository{
			ObjectMeta: metav1.ObjectMeta{Name: "repo"},
			Spec: corev1alpha1.RepositorySpec{
				Type: corev1alpha1.RepositoryTypeGit,
				URL:  "https://github.com/org/repo.git",
			},
		}
		require.NoError(t, v.validateRepository(repo))
	})

	t.Run("valid oci repository", func(t *testing.T) {
		repo := &corev1alpha1.Repository{
			ObjectMeta: metav1.ObjectMeta{Name: "repo"},
			Spec: corev1alpha1.RepositorySpec{
				Type: corev1alpha1.RepositoryTypeOCI,
				URL:  "oci://registry.example.com/charts",
			},
		}
		require.NoError(t, v.validateRepository(repo))
	})

	t.Run("missing type", func(t *testing.T) {
		repo := &corev1alpha1.Repository{
			ObjectMeta: metav1.ObjectMeta{Name: "repo"},
			Spec: corev1alpha1.RepositorySpec{
				URL: "https://github.com/org/repo.git",
			},
		}
		err := v.validateRepository(repo)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "type is required")
	})

	t.Run("missing url", func(t *testing.T) {
		repo := &corev1alpha1.Repository{
			ObjectMeta: metav1.ObjectMeta{Name: "repo"},
			Spec: corev1alpha1.RepositorySpec{
				Type: corev1alpha1.RepositoryTypeGit,
			},
		}
		err := v.validateRepository(repo)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "URL is required")
	})

	t.Run("oci URL missing scheme", func(t *testing.T) {
		repo := &corev1alpha1.Repository{
			ObjectMeta: metav1.ObjectMeta{Name: "repo"},
			Spec: corev1alpha1.RepositorySpec{
				Type: corev1alpha1.RepositoryTypeOCI,
				URL:  "registry.example.com/charts",
			},
		}
		err := v.validateRepository(repo)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "oci:// scheme")
	})

	t.Run("helm URL uses oci scheme", func(t *testing.T) {
		repo := &corev1alpha1.Repository{
			ObjectMeta: metav1.ObjectMeta{Name: "repo"},
			Spec: corev1alpha1.RepositorySpec{
				Type: corev1alpha1.RepositoryTypeHelm,
				URL:  "oci://registry.example.com/charts",
			},
		}
		err := v.validateRepository(repo)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must not use oci://")
	})

	t.Run("secretRef missing name", func(t *testing.T) {
		repo := &corev1alpha1.Repository{
			ObjectMeta: metav1.ObjectMeta{Name: "repo"},
			Spec: corev1alpha1.RepositorySpec{
				Type:      corev1alpha1.RepositoryTypeGit,
				URL:       "https://github.com/org/repo.git",
				SecretRef: &corev1alpha1.SecretRef{},
			},
		}
		err := v.validateRepository(repo)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "secretRef name is required")
	})
}

func TestRepositoryCustomDefaulter_Default(t *testing.T) {
	d := &RepositoryCustomDefaulter{}
	repo := &corev1alpha1.Repository{ObjectMeta: metav1.ObjectMeta{Name: "repo"}}
	require.NoError(t, d.Default(context.Background(), repo))
}
