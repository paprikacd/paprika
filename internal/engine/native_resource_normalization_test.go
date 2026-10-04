package engine

import (
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestPriorityClassDefaultFalseMatchesOmissionWithoutHidingTrue(t *testing.T) {
	desired := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "scheduling.k8s.io/v1", "kind": "PriorityClass",
		"metadata": map[string]interface{}{"name": "example"},
		"value":    int64(-100), "globalDefault": false, "preemptionPolicy": "Never",
	}}
	live := desired.DeepCopy()
	unstructured.RemoveNestedField(live.Object, "globalDefault")
	require.True(t, resourceEqual(desired, *live))
	require.Equal(t, false, desired.Object["globalDefault"], "do not mutate desired input")
	require.NotContains(t, live.Object, "globalDefault", "do not mutate live input")

	live.Object["globalDefault"] = true
	require.False(t, resourceEqual(desired, *live), "a live global priority default must remain drift")
	desired.Object["globalDefault"] = true
	require.True(t, resourceEqual(desired, *live))
	unstructured.RemoveNestedField(live.Object, "globalDefault")
	require.False(t, resourceEqual(desired, *live), "an omitted live value cannot satisfy desired true")

	desired.Object["globalDefault"] = false
	desired.SetAPIVersion("example.test/v1")
	live.SetAPIVersion("example.test/v1")
	require.False(t, resourceEqual(desired, *live), "do not normalize unrelated CRD fields")
}

func TestQuotaCanonicalQuantitiesDoNotHideActualChanges(t *testing.T) {
	desired := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "ResourceQuota", "metadata": map[string]interface{}{"name": "example"},
		"spec": map[string]interface{}{"hard": map[string]interface{}{"requests.cpu": "5000m", "requests.memory": "10240Mi"}},
	}}
	live := desired.DeepCopy()
	require.NoError(t, unstructured.SetNestedField(live.Object, "5", "spec", "hard", "requests.cpu"))
	require.NoError(t, unstructured.SetNestedField(live.Object, "10Gi", "spec", "hard", "requests.memory"))
	require.True(t, resourceEqual(desired, *live))
	require.NoError(t, unstructured.SetNestedField(live.Object, "6", "spec", "hard", "requests.cpu"))
	require.False(t, resourceEqual(desired, *live))
	// Normalization must neither mutate inputs nor alter arbitrary CRD strings.
	value, _, err := unstructured.NestedString(desired.Object, "spec", "hard", "requests.cpu")
	require.NoError(t, err)
	require.Equal(t, "5000m", value)
	desired.SetAPIVersion("example.test/v1")
	live.SetAPIVersion("example.test/v1")
	require.NoError(t, unstructured.SetNestedField(live.Object, "5", "spec", "hard", "requests.cpu"))
	require.False(t, resourceEqual(desired, *live))
}

func TestNetworkPolicyEmptyRulesMatchOmissionButDetectAddedAccess(t *testing.T) {
	desired := unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": map[string]interface{}{"name": "example"},
		"spec": map[string]interface{}{"podSelector": map[string]interface{}{}, "policyTypes": []interface{}{"Ingress", "Egress"}, "ingress": []interface{}{}, "egress": []interface{}{}},
	}}
	live := desired.DeepCopy()
	unstructured.RemoveNestedField(live.Object, "spec", "ingress")
	unstructured.RemoveNestedField(live.Object, "spec", "egress")
	require.True(t, resourceEqual(desired, *live))
	for _, field := range []string{"ingress", "egress"} {
		t.Run(field, func(t *testing.T) {
			opened := live.DeepCopy()
			require.NoError(t, unstructured.SetNestedSlice(opened.Object, []interface{}{map[string]interface{}{}}, "spec", field))
			require.False(t, resourceEqual(desired, *opened), "an empty rule allows all traffic and must remain drift")
		})
	}
	_, present, err := unstructured.NestedSlice(desired.Object, "spec", "ingress")
	require.NoError(t, err)
	require.True(t, present, "do not mutate rendered input")
}
