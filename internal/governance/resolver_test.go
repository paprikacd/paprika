package governance

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func newTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, corev1alpha1.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	require.NoError(t, corev1.AddToScheme(scheme))
	return scheme
}

func TestProjectResolver_ResolveApplication(t *testing.T) {
	project := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "payments", Namespace: "default"},
	}
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: "payments",
			Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://example.com"},
			Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
		},
	}
	c := fake.NewClientBuilder().WithScheme(newTestScheme(t)).WithObjects(project, app).Build()
	r := NewProjectResolver(c)

	got, err := r.Resolve(context.Background(), app)
	require.NoError(t, err)
	assert.Equal(t, "payments", got.Name)
	assert.Equal(t, "default", got.Namespace)
}

func newResolverWithProjectAppAndObjects(t *testing.T, projectName string, objs ...client.Object) (*ProjectResolver, *pipelinesv1alpha1.Application) {
	t.Helper()
	project := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: projectName, Namespace: "default"},
	}
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: projectName,
			Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://example.com"},
		},
	}
	allObjects := append([]client.Object{project, app}, objs...)
	c := fake.NewClientBuilder().WithScheme(newTestScheme(t)).WithObjects(allObjects...).Build()
	return NewProjectResolver(c), app
}

func TestProjectResolver_ResolveTemplate(t *testing.T) {
	tmpl := &pipelinesv1alpha1.Template{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "tmpl",
			Namespace: "default",
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: pipelinesv1alpha1.GroupVersion.String(),
				Kind:       "Application",
				Name:       "app",
			}},
		},
	}
	r, _ := newResolverWithProjectAppAndObjects(t, "payments", tmpl)

	got, err := r.Resolve(context.Background(), tmpl)
	require.NoError(t, err)
	assert.Equal(t, "payments", got.Name)
	assert.Equal(t, "default", got.Namespace)
}

func TestProjectResolver_ResolveStage(t *testing.T) {
	stage := &pipelinesv1alpha1.Stage{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "stage",
			Namespace: "default",
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: pipelinesv1alpha1.GroupVersion.String(),
				Kind:       "Application",
				Name:       "app",
			}},
		},
	}
	r, _ := newResolverWithProjectAppAndObjects(t, "payments", stage)

	got, err := r.Resolve(context.Background(), stage)
	require.NoError(t, err)
	assert.Equal(t, "payments", got.Name)
	assert.Equal(t, "default", got.Namespace)
}

func TestProjectResolver_MissingProject(t *testing.T) {
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: "missing",
			Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://example.com"},
			Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
		},
	}
	c := fake.NewClientBuilder().WithScheme(newTestScheme(t)).WithObjects(app).Build()
	r := NewProjectResolver(c)

	_, err := r.Resolve(context.Background(), app)
	require.Error(t, err)
}

func TestProjectResolver_MissingOwnerReference(t *testing.T) {
	tmpl := &pipelinesv1alpha1.Template{
		ObjectMeta: metav1.ObjectMeta{Name: "tmpl", Namespace: "default"},
	}
	c := fake.NewClientBuilder().WithScheme(newTestScheme(t)).WithObjects(tmpl).Build()
	r := NewProjectResolver(c)

	_, err := r.Resolve(context.Background(), tmpl)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no Application owner reference found")
}

func TestProjectResolver_OwnerApplicationNotFound(t *testing.T) {
	tmpl := &pipelinesv1alpha1.Template{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "tmpl",
			Namespace: "default",
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: pipelinesv1alpha1.GroupVersion.String(),
				Kind:       "Application",
				Name:       "missing-app",
			}},
		},
	}
	c := fake.NewClientBuilder().WithScheme(newTestScheme(t)).WithObjects(tmpl).Build()
	r := NewProjectResolver(c)

	_, err := r.Resolve(context.Background(), tmpl)
	require.Error(t, err)
}

func TestProjectResolver_DefaultProjectNormalized(t *testing.T) {
	project := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{Name: "default", Namespace: "default"},
	}
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Source: pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://example.com"},
		},
	}
	c := fake.NewClientBuilder().WithScheme(newTestScheme(t)).WithObjects(project, app).Build()
	r := NewProjectResolver(c)

	got, err := r.Resolve(context.Background(), app)
	require.NoError(t, err)
	assert.Equal(t, "default", got.Name)
	assert.Equal(t, "default", got.Namespace)
}

func TestProjectResolver_DefaultProjectFallback(t *testing.T) {
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Source: pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://example.com"},
		},
	}
	c := fake.NewClientBuilder().WithScheme(newTestScheme(t)).WithObjects(app).Build()
	r := NewProjectResolver(c)

	got, err := r.Resolve(context.Background(), app)
	require.NoError(t, err)
	assert.Equal(t, "default", got.Name)
	assert.Equal(t, "default", got.Namespace)
	assert.Equal(t, defaultProjectDescription, got.Spec.Description)
	assert.Contains(t, got.Spec.SourceRepos, "*")
	assert.Contains(t, got.Spec.Destinations, corev1alpha1.AppProjectDestination{Server: "*", Namespace: "*"})
	assert.Contains(t, got.Spec.Kinds, "*")
	assert.Contains(t, got.Spec.ClusterResourceWhitelist, "*")
}

func TestProjectResolver_UnsupportedType(t *testing.T) {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "cm", Namespace: "default"},
	}
	c := fake.NewClientBuilder().WithScheme(newTestScheme(t)).WithObjects(cm).Build()
	r := NewProjectResolver(c)

	_, err := r.Resolve(context.Background(), cm)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported object type")
}

func TestProjectResolver_NilTypedPointer(t *testing.T) {
	c := fake.NewClientBuilder().WithScheme(newTestScheme(t)).Build()
	r := NewProjectResolver(c)

	var nilApp *pipelinesv1alpha1.Application
	_, err := r.Resolve(context.Background(), nilApp)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "nil")
}

func TestProjectResolver_NilInterface(t *testing.T) {
	c := fake.NewClientBuilder().WithScheme(newTestScheme(t)).Build()
	r := NewProjectResolver(c)

	_, err := r.Resolve(context.Background(), nil)
	require.Error(t, err)
}
