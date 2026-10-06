package engine

import (
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestApplicationOwnedImmutableSnapshotsAreControlPlaneArtifacts(t *testing.T) {
	input := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "ConfigMap", "immutable": true,
		"metadata": map[string]interface{}{"name": "pending-bundle", "namespace": "tenant", "labels": map[string]interface{}{ApplicationNameLabelKey: "tenant", ManagedByLabelKey: ManagedByLabelValue}},
		"data":     map[string]interface{}{"manifests.yaml": "reviewed tenant manifests"},
	}}
	input.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "pipelines.paprika.io/v1alpha1", Kind: "Application", Name: "tenant", UID: "tenant-uid"}})
	require.True(t, shouldIgnoreLiveResource(input))
	for _, mutate := range []func(*unstructured.Unstructured){
		func(o *unstructured.Unstructured) { o.SetOwnerReferences(nil) },
		func(o *unstructured.Unstructured) { o.Object["immutable"] = false },
		func(o *unstructured.Unstructured) {
			o.Object["data"] = map[string]interface{}{"runtime": "configuration"}
		},
		func(o *unstructured.Unstructured) {
			o.SetLabels(map[string]string{ApplicationNameLabelKey: "another-app"})
		},
	} {
		workload := input.DeepCopy()
		mutate(workload)
		require.False(t, shouldIgnoreLiveResource(workload))
	}
}
