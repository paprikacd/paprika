package v1alpha1

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
)

func TestApplicationCustomValidator_validateApplication(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, corev1alpha1.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	project := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "allowed-project", Namespace: "default"},
		Spec: corev1alpha1.AppProjectSpec{
			SourceRepos: []string{"https://github.com/org/allowed*"},
			Kinds:       []string{"Deployment"},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(project).Build()
	v := &ApplicationCustomValidator{enforcer: auth.NewProjectEnforcer(c)}

	t.Run("valid application without project", func(t *testing.T) {
		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source: pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://github.com/org/any"},
				Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
			},
		}
		require.NoError(t, v.validateApplication(context.Background(), app))
	})

	t.Run("allowed source repo", func(t *testing.T) {
		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Project: "allowed-project",
				Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://github.com/org/allowed-repo"},
				Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
			},
		}
		require.NoError(t, v.validateApplication(context.Background(), app))
	})

	t.Run("denied source repo", func(t *testing.T) {
		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Project: "allowed-project",
				Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://github.com/other/repo"},
				Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
			},
		}
		err := v.validateApplication(context.Background(), app)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "not allowed")
	})

	t.Run("missing source type", func(t *testing.T) {
		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source: pipelinesv1alpha1.ApplicationSource{Type: ""},
				Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
			},
		}
		err := v.validateApplication(context.Background(), app)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "Source type is required")
	})

	t.Run("missing git repo url", func(t *testing.T) {
		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source: pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit},
				Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
			},
		}
		err := v.validateApplication(context.Background(), app)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "Repo URL is required")
	})

	t.Run("missing stages", func(t *testing.T) {
		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Source: pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://github.com/org/allowed-repo"},
			},
		}
		err := v.validateApplication(context.Background(), app)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "At least one stage is required")
	})
}

func TestApplicationCustomDefaulter_Default(t *testing.T) {
	d := &ApplicationCustomDefaulter{}
	app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{Name: "app"}}
	require.NoError(t, d.Default(context.Background(), app))
}
