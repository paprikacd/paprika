package engine

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestServicePublishNotReadyAddressesOmittedFalse(t *testing.T) {
	t.Parallel()
	// The Kubernetes JSON representation omits this false-valued field.
	service := corev1.Service{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "Service"},
		ObjectMeta: metav1.ObjectMeta{Name: "cache-peers", Namespace: "tenant"},
		Spec:       corev1.ServiceSpec{ClusterIP: "None", PublishNotReadyAddresses: false},
	}
	encoded, err := json.Marshal(service)
	require.NoError(t, err)
	var live unstructured.Unstructured
	require.NoError(t, live.UnmarshalJSON(encoded))
	_, found, err := unstructured.NestedFieldNoCopy(live.Object, "spec", "publishNotReadyAddresses")
	require.NoError(t, err)
	require.False(t, found)
	desired := live.DeepCopy()
	require.NoError(t, unstructured.SetNestedField(desired.Object, false, "spec", "publishNotReadyAddresses"))
	beforeDesired, beforeLive := desired.DeepCopy(), live.DeepCopy()
	require.True(t, resourceEqual(*desired, live), "an explicitly false Service default is not drift")
	require.Equal(t, beforeDesired, desired, "comparison must not mutate cached desired objects")
	require.Equal(t, beforeLive, &live, "comparison must not mutate cached live objects")
}

func TestServicePublishNotReadyAddressesPreservesRealDrift(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, apiVersion, kind string
		desired, live          interface{}
		wantEqual              bool
	}{
		{"true is not absent", "v1", "Service", true, nil, false},
		{"false is not true", "v1", "Service", false, true, false},
		{"true matches true", "v1", "Service", true, true, true},
		{"omitted desired permits live true", "v1", "Service", nil, true, true},
		{"false on custom Service remains significant", "example.test/v1", "Service", false, nil, false},
		{"false on another kind remains significant", "v1", "ConfigMap", false, nil, false},
		{"string false is not a boolean", "v1", "Service", "false", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			desired := unstructured.Unstructured{Object: map[string]interface{}{
				"apiVersion": tc.apiVersion, "kind": tc.kind,
				"metadata": map[string]interface{}{"name": "example"},
				"spec":     map[string]interface{}{},
			}}
			live := desired.DeepCopy()
			if tc.desired != nil {
				require.NoError(t, unstructured.SetNestedField(desired.Object, tc.desired, "spec", "publishNotReadyAddresses"))
			}
			if tc.live != nil {
				require.NoError(t, unstructured.SetNestedField(live.Object, tc.live, "spec", "publishNotReadyAddresses"))
			}
			require.Equal(t, tc.wantEqual, resourceEqual(desired, *live))
		})
	}
}
