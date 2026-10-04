package engine

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	ktesting "k8s.io/client-go/testing"
)

func TestComputeClassDiffListsRootResource(t *testing.T) {
	t.Parallel()

	gvr := schema.GroupVersionResource{Group: "cloud.google.com", Version: "v1", Resource: "computeclasses"}
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{gvr: "ComputeClassList"})
	listed := false
	client.PrependReactor("list", "computeclasses", func(action ktesting.Action) (bool, runtime.Object, error) {
		listed = true
		if action.GetNamespace() != "" {
			t.Fatalf("ComputeClass LIST used namespace %q", action.GetNamespace())
		}
		return true, &unstructured.UnstructuredList{Object: map[string]interface{}{"apiVersion": "cloud.google.com/v1", "kind": "ComputeClassList"}}, nil
	})
	diff := NewScalableDiffEngine(client)
	diff.SetResolver(computeClassTestResolver{})
	diff.SetLiveCache(nil)
	obj := unstructured.Unstructured{}
	obj.SetAPIVersion("cloud.google.com/v1")
	obj.SetKind("ComputeClass")
	obj.SetName("example")
	_, err := diff.ComputeDiff(context.Background(), []unstructured.Unstructured{obj}, &DiffOptions{Namespace: "release-default", ApplicationName: "example"})
	if err != nil || !listed {
		t.Fatalf("diff did not query ComputeClass: listed=%v err=%v", listed, err)
	}
}

type computeClassTestResolver struct{}

func (computeClassTestResolver) Resolve(context.Context, string, string, string) (schema.GroupVersionResource, error) {
	return schema.GroupVersionResource{Group: "cloud.google.com", Version: "v1", Resource: "computeclasses"}, nil
}
