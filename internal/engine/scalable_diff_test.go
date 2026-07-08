package engine

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestEnsureManagedLabels(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		initialLabels map[string]interface{}
		wantExisting  string
	}{
		{
			name:         "adds labels when absent",
			wantExisting: "",
		},
		{
			name:          "preserves existing labels",
			initialLabels: map[string]interface{}{"existing": "label"},
			wantExisting:  "label",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			metadata := map[string]interface{}{
				"name":      "app",
				"namespace": "default",
			}
			if tc.initialLabels != nil {
				metadata["labels"] = tc.initialLabels
			}

			obj := &unstructured.Unstructured{Object: map[string]interface{}{
				"apiVersion": "apps/v1",
				"kind":       "Deployment",
				"metadata":   metadata,
			}}

			require.NoError(t, ensureManagedLabels(obj, &DiffOptions{ApplicationName: "my-app"}))

			labels := obj.GetLabels()
			assert.Equal(t, ManagedByLabelValue, labels[ManagedByLabelKey])
			assert.Equal(t, "my-app", labels[ApplicationNameLabelKey])
			if tc.wantExisting != "" {
				assert.Equal(t, tc.wantExisting, labels["existing"])
			}
		})
	}
}

func TestComputeDiff_AddsManagedLabels(t *testing.T) {
	t.Parallel()
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

	_, err := eng.ComputeDiff(context.Background(), desired, &DiffOptions{
		Namespace:       "default",
		ApplicationName: app.Name,
	})
	require.NoError(t, err)

	assert.Equal(t, ManagedByLabelValue, desired[0].GetLabels()[ManagedByLabelKey])
	assert.Equal(t, "my-app", desired[0].GetLabels()[ApplicationNameLabelKey])
}

func TestComputeDiff_IgnoresReleaseOwnedInternalConfigMaps(t *testing.T) {
	t.Parallel()

	desired := []unstructured.Unstructured{{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata": map[string]interface{}{
				"name":      "app-config",
				"namespace": "default",
				"labels": map[string]interface{}{
					"app.kubernetes.io/name": "app",
				},
			},
			"data": map[string]interface{}{
				"ENV": "prod",
			},
		},
	}}

	liveConfig := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "app-config",
			Namespace: "default",
			Labels: map[string]string{
				"app.kubernetes.io/name": "app",
				ManagedByLabelKey:        ManagedByLabelValue,
				ApplicationNameLabelKey:  "my-app",
			},
		},
		Data: map[string]string{"ENV": "prod"},
	}
	internalSnapshot := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "my-app-release-manifest-snapshot",
			Namespace: "default",
			Labels: map[string]string{
				ManagedByLabelKey:        ManagedByLabelValue,
				ApplicationNameLabelKey:  "my-app",
				"app.paprika.io/release": "my-app-release",
			},
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: "pipelines.paprika.io/v1alpha1",
				Kind:       "Release",
				Name:       "my-app-release",
				UID:        types.UID("release-uid"),
			}},
		},
		Data: map[string]string{"manifests.yaml": "---"},
	}

	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	dynClient := fake.NewSimpleDynamicClient(scheme, liveConfig, internalSnapshot)
	eng := NewScalableDiffEngine(dynClient)
	eng.SetLiveCache(nil)

	result, err := eng.ComputeDiff(context.Background(), desired, &DiffOptions{
		Namespace:       "default",
		LabelSelector:   ManagedByAppSelector("my-app").String(),
		ApplicationName: "my-app",
	})
	require.NoError(t, err)

	assert.Empty(t, result.Added)
	assert.Empty(t, result.Modified)
	assert.Empty(t, result.Deleted)
	require.Len(t, result.Unchanged, 1)
	assert.Equal(t, "app-config", result.Unchanged[0].Name)
	assert.Equal(t, 0, result.OutOfSyncCount())
}
