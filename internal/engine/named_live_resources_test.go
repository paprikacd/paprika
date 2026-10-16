package engine

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	ktesting "k8s.io/client-go/testing"
)

func TestNamedPriorityReadFiltersOwnershipAndPropagatesForbidden(t *testing.T) {
	gvr := schema.GroupVersionResource{Group: "scheduling.k8s.io", Version: "v1", Resource: "priorityclasses"}
	obj := &unstructured.Unstructured{Object: map[string]interface{}{"apiVersion": "scheduling.k8s.io/v1", "kind": "PriorityClass", "metadata": map[string]interface{}{"name": "example"}}}
	c := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), obj)
	d := NewScalableDiffEngine(c)
	defer d.Stop()
	refs := map[schema.GroupVersionResource]map[string]struct{}{gvr: {"example": {}, "absent": {}}}
	live := map[string]unstructured.Unstructured{}
	opts := &DiffOptions{LabelSelector: ManagedByAppSelector("example").String()}
	require.NoError(t, d.fetchNamedLiveResources(context.Background(), opts, refs, live))
	require.Empty(t, live, "do not adopt objects owned by another application")
	obj.SetLabels(map[string]string{ManagedByLabelKey: ManagedByLabelValue, ApplicationNameLabelKey: "example"})
	_, err := c.Resource(gvr).Update(context.Background(), obj, metav1.UpdateOptions{})
	require.NoError(t, err)
	require.NoError(t, d.fetchNamedLiveResources(context.Background(), opts, refs, live))
	require.Len(t, live, 1)
	c.PrependReactor("get", "priorityclasses", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(gvr.GroupResource(), "example", nil)
	})
	err = d.fetchNamedLiveResources(context.Background(), opts, refs, live)
	require.Error(t, err)
	require.True(t, apierrors.IsForbidden(err), "denied GET must not be reported as a missing object")
}
