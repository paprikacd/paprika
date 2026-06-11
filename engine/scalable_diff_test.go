package engine

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
)

func TestScalableDiffEngine_ComputeDiff(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)

	dynClient := fake.NewSimpleDynamicClient(scheme)
	engine := NewScalableDiffEngine(dynClient)

	ctx := context.Background()
	appName := "test-app"
	selector := ManagedByAppSelector(appName).String()

	desired := []unstructured.Unstructured{
		newTestConfigMap("default", "desired-cm", appName, map[string]string{"key": "value"}),
		newTestConfigMap("default", "modified-cm", appName, map[string]string{"key": "new-value"}),
		newTestConfigMap("default", "added-cm", appName, map[string]string{"key": "value"}),
	}

	// Seed a live resource that should be detected as modified (different metadata label).
	modifiedLive := newTestConfigMap("default", "modified-cm", appName, map[string]string{"key": "value"})
	modifiedLive.SetLabels(map[string]string{
		ManagedByLabelKey:       ManagedByLabelValue,
		ApplicationNameLabelKey: appName,
		"extra":                 "old",
	})
	_, err := dynClient.Resource(configMapGVR()).Namespace("default").Create(ctx, &modifiedLive, metav1.CreateOptions{})
	require.NoError(t, err)

	// Seed a live resource that should be detected as deleted.
	orphanLive := newTestConfigMap("default", "orphan-cm", appName, map[string]string{"key": "value"})
	_, err = dynClient.Resource(configMapGVR()).Namespace("default").Create(ctx, &orphanLive, metav1.CreateOptions{})
	require.NoError(t, err)

	result, err := engine.ComputeDiff(ctx, desired, DiffOptions{
		Namespace:     "default",
		LabelSelector: selector,
	})
	require.NoError(t, err)
	require.NotNil(t, result)

	require.Equal(t, 2, len(result.Added), "expected 2 added")
	addedNames := make(map[string]struct{})
	for _, a := range result.Added {
		addedNames[a.Name] = struct{}{}
	}
	require.Contains(t, addedNames, "added-cm")
	require.Contains(t, addedNames, "desired-cm")

	require.Equal(t, 1, len(result.Modified), "expected 1 modified")
	require.Equal(t, "modified-cm", result.Modified[0].Name)

	require.Equal(t, 1, len(result.Deleted), "expected 1 deleted")
	require.Equal(t, "orphan-cm", result.Deleted[0].Name)

	require.Equal(t, 0, len(result.Unchanged), "expected 0 unchanged")
}

func TestScalableDiffEngine_IgnoresUnmanagedResources(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)

	dynClient := fake.NewSimpleDynamicClient(scheme)
	engine := NewScalableDiffEngine(dynClient)

	ctx := context.Background()
	appName := "test-app"

	// Create an unmanaged ConfigMap.
	unmanaged := newTestConfigMap("default", "unmanaged", "", map[string]string{"key": "value"})
	_, err := dynClient.Resource(configMapGVR()).Namespace("default").Create(ctx, &unmanaged, metav1.CreateOptions{})
	require.NoError(t, err)

	// Desired set only contains managed resources.
	desired := []unstructured.Unstructured{
		newTestConfigMap("default", "managed-cm", appName, map[string]string{"key": "value"}),
	}

	result, err := engine.ComputeDiff(ctx, desired, DiffOptions{
		Namespace:     "default",
		LabelSelector: ManagedByAppSelector(appName).String(),
	})
	require.NoError(t, err)

	require.Equal(t, 1, len(result.Added))
	require.Equal(t, 0, len(result.Deleted), "unmanaged resource should be ignored")
}

func newTestConfigMap(namespace, name, appName string, data map[string]string) unstructured.Unstructured {
	labels := map[string]string{ManagedByLabelKey: ManagedByLabelValue}
	if appName != "" {
		labels[ApplicationNameLabelKey] = appName
	}

	obj := unstructured.Unstructured{}
	obj.SetAPIVersion("v1")
	obj.SetKind("ConfigMap")
	obj.SetNamespace(namespace)
	obj.SetName(name)
	obj.SetLabels(labels)
	_ = unstructured.SetNestedStringMap(obj.Object, data, "data")
	return obj
}

func configMapGVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}
}
