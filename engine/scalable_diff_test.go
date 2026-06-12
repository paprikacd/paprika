package engine

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestEnsureManagedLabels(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]interface{}{
			"name":      "app",
			"namespace": "default",
		},
	}}

	require.NoError(t, ensureManagedLabels(obj, DiffOptions{ApplicationName: "my-app"}))

	labels := obj.GetLabels()
	assert.Equal(t, ManagedByLabelValue, labels[ManagedByLabelKey])
	assert.Equal(t, "my-app", labels[ApplicationNameLabelKey])
}

func TestEnsureManagedLabels_AlreadyHasLabels(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]interface{}{
			"name":      "app",
			"namespace": "default",
			"labels": map[string]interface{}{
				"existing": "label",
			},
		},
	}}

	require.NoError(t, ensureManagedLabels(obj, DiffOptions{ApplicationName: "my-app"}))

	labels := obj.GetLabels()
	assert.Equal(t, "label", labels["existing"])
	assert.Equal(t, ManagedByLabelValue, labels[ManagedByLabelKey])
}

func TestComputeDiff_AddsManagedLabels(t *testing.T) {
	app := &paprikav1.Application{ObjectMeta: metav1.ObjectMeta{Name: "my-app", Namespace: "default"}}
	desired := []unstructured.Unstructured{{
		Object: map[string]interface{}{
			"apiVersion": "apps/v1",
			"kind":       "Deployment",
			"metadata": map[string]interface{}{
				"name":      "app",
				"namespace": "default",
			},
		},
	}}

	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"}, &unstructured.Unstructured{})
	scheme.AddKnownTypeWithName(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "DeploymentList"}, &unstructured.UnstructuredList{})
	dynClient := fake.NewSimpleDynamicClient(scheme)
	eng := NewScalableDiffEngine(dynClient)

	_, err := eng.ComputeDiff(context.Background(), desired, DiffOptions{
		Namespace:       "default",
		ApplicationName: app.Name,
	})
	require.NoError(t, err)

	assert.Equal(t, ManagedByLabelValue, desired[0].GetLabels()[ManagedByLabelKey])
	assert.Equal(t, "my-app", desired[0].GetLabels()[ApplicationNameLabelKey])
}
