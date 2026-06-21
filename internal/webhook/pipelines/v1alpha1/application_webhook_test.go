package v1alpha1

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
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
	defaultProject := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "default", Namespace: "default"},
		Spec: corev1alpha1.AppProjectSpec{
			SourceRepos: []string{"*"},
			Destinations: []corev1alpha1.AppProjectDestination{
				{Server: "*", Namespace: "*"},
			},
			Kinds: []string{"*"},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(project, defaultProject).Build()
	resolver := governance.NewProjectResolver(c)
	validator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(c), nil)
	v := &ApplicationCustomValidator{validator: validator}

	t.Run("valid application with default project", func(t *testing.T) {
		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Project: "default",
				Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://github.com/org/any"},
				Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
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

	t.Run("inline source without configMapRef is rejected", func(t *testing.T) {
		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Project: "default",
				Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeInline, Inline: &pipelinesv1alpha1.InlineSourceSpec{ConfigMapRef: ""}},
				Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
			},
		}
		err := v.validateApplication(context.Background(), app)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "configMapRef is required for inline source")
	})

	t.Run("inline source with configMapRef is accepted", func(t *testing.T) {
		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Project: "default",
				Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeInline, Inline: &pipelinesv1alpha1.InlineSourceSpec{ConfigMapRef: "snapshot"}},
				Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
			},
		}
		require.NoError(t, v.validateApplication(context.Background(), app))
	})

	t.Run("inline source with a project does not require repo authorization", func(t *testing.T) {
		app := &pipelinesv1alpha1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
			Spec: pipelinesv1alpha1.ApplicationSpec{
				Project: "allowed-project",
				Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeInline, Inline: &pipelinesv1alpha1.InlineSourceSpec{ConfigMapRef: "snapshot"}},
				Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
			},
		}
		require.NoError(t, v.validateApplication(context.Background(), app))
	})
}

func TestApplicationCustomDefaulter_Default(t *testing.T) {
	d := &ApplicationCustomDefaulter{}
	app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{Name: "app"}}
	require.NoError(t, d.Default(context.Background(), app))
}

func TestApplicationCustomDefaulter_DefaultsProject(t *testing.T) {
	d := &ApplicationCustomDefaulter{}
	app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{Name: "app"}}
	require.NoError(t, d.Default(context.Background(), app))
	assert.Equal(t, "default", app.Spec.Project)
}

func TestApplicationCustomValidator_GovernanceValidator(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, corev1alpha1.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	project := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "restricted", Namespace: "default"},
		Spec: corev1alpha1.AppProjectSpec{
			SourceRepos: []string{"https://github.com/org/allowed*"},
			Destinations: []corev1alpha1.AppProjectDestination{
				{Server: "https://kubernetes.default.svc", Namespace: "allowed-ns"},
			},
			Kinds: []string{"Deployment"},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(project).Build()
	resolver := governance.NewProjectResolver(c)
	validator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(c), nil)
	v := &ApplicationCustomValidator{validator: validator}

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: "restricted",
			Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://github.com/org/allowed-repo"},
			Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1, Cluster: pipelinesv1alpha1.ClusterRef{Server: "https://other.server"}}},
		},
	}
	err := v.validateApplication(context.Background(), app)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not allowed")
}

// newQuotaApp builds a minimal valid Application in the given project.
func newQuotaApp(name, project string) *pipelinesv1alpha1.Application {
	return &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: project,
			Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://github.com/org/repo"},
			Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
		},
	}
}

func TestApplicationCustomValidator_Quota(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, corev1alpha1.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))

	buildValidator := func(project *corev1alpha1.AppProject, existing ...*pipelinesv1alpha1.Application) *ApplicationCustomValidator {
		objs := make([]client.Object, 0, 1+len(existing))
		objs = append(objs, project)
		for _, a := range existing {
			objs = append(objs, a)
		}
		c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
		resolver := governance.NewProjectResolver(c)
		validator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(c), nil)
		return &ApplicationCustomValidator{validator: validator, client: c}
	}

	t.Run("allowed when under the limit", func(t *testing.T) {
		project := &corev1alpha1.AppProject{
			ObjectMeta: metav1.ObjectMeta{Name: "quota", Namespace: "default"},
			Spec: corev1alpha1.AppProjectSpec{
				SourceRepos: []string{"*"},
				Destinations: []corev1alpha1.AppProjectDestination{
					{Server: "*", Namespace: "*"},
				},
				Kinds:  []string{"*"},
				Limits: &corev1alpha1.ProjectLimits{MaxApplications: 2},
			},
		}
		existing := newQuotaApp("app-1", "quota")
		v := buildValidator(project, existing)
		_, err := v.ValidateCreate(context.Background(), newQuotaApp("app-2", "quota"))
		require.NoError(t, err)
	})

	t.Run("rejected when at the limit", func(t *testing.T) {
		project := &corev1alpha1.AppProject{
			ObjectMeta: metav1.ObjectMeta{Name: "quota", Namespace: "default"},
			Spec: corev1alpha1.AppProjectSpec{
				SourceRepos: []string{"*"},
				Destinations: []corev1alpha1.AppProjectDestination{
					{Server: "*", Namespace: "*"},
				},
				Kinds:  []string{"*"},
				Limits: &corev1alpha1.ProjectLimits{MaxApplications: 2},
			},
		}
		existing := []*pipelinesv1alpha1.Application{
			newQuotaApp("app-1", "quota"),
			newQuotaApp("app-2", "quota"),
		}
		v := buildValidator(project, existing...)
		_, err := v.ValidateCreate(context.Background(), newQuotaApp("app-3", "quota"))
		require.Error(t, err)
		assert.Contains(t, err.Error(), "MaxApplications limit")
	})

	t.Run("allowed when no limit set (Limits nil)", func(t *testing.T) {
		project := &corev1alpha1.AppProject{
			ObjectMeta: metav1.ObjectMeta{Name: "nolimits", Namespace: "default"},
			Spec: corev1alpha1.AppProjectSpec{
				SourceRepos: []string{"*"},
				Destinations: []corev1alpha1.AppProjectDestination{
					{Server: "*", Namespace: "*"},
				},
				Kinds: []string{"*"},
			},
		}
		v := buildValidator(project)
		_, err := v.ValidateCreate(context.Background(), newQuotaApp("app-1", "nolimits"))
		require.NoError(t, err)
	})

	t.Run("allowed when MaxApplications is zero (unlimited)", func(t *testing.T) {
		project := &corev1alpha1.AppProject{
			ObjectMeta: metav1.ObjectMeta{Name: "zero", Namespace: "default"},
			Spec: corev1alpha1.AppProjectSpec{
				SourceRepos: []string{"*"},
				Destinations: []corev1alpha1.AppProjectDestination{
					{Server: "*", Namespace: "*"},
				},
				Kinds:  []string{"*"},
				Limits: &corev1alpha1.ProjectLimits{MaxApplications: 0},
			},
		}
		existing := []*pipelinesv1alpha1.Application{
			newQuotaApp("app-1", "zero"),
			newQuotaApp("app-2", "zero"),
		}
		v := buildValidator(project, existing...)
		_, err := v.ValidateCreate(context.Background(), newQuotaApp("app-3", "zero"))
		require.NoError(t, err)
	})
}
