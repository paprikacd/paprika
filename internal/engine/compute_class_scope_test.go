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

func TestComputeClassDiffReadsNamedRootResource(t *testing.T) {
	t.Parallel()

	gvr := schema.GroupVersionResource{Group: "cloud.google.com", Version: "v1", Resource: "computeclasses"}
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{gvr: "ComputeClassList"})
	read := false
	client.PrependReactor("get", "computeclasses", func(action ktesting.Action) (bool, runtime.Object, error) {
		read = true
		if action.GetNamespace() != "" {
			t.Fatalf("ComputeClass GET used namespace %q", action.GetNamespace())
		}
		get, ok := action.(ktesting.GetAction)
		if !ok || get.GetName() != "example" {
			t.Fatal("GET must use only the desired name")
		}
		return true, &unstructured.Unstructured{Object: map[string]interface{}{"apiVersion": "cloud.google.com/v1", "kind": "ComputeClass", "metadata": map[string]interface{}{"name": "example"}}}, nil
	})
	diff := NewScalableDiffEngine(client)
	diff.SetResolver(computeClassTestResolver{})
	diff.SetLiveCache(nil)
	obj := unstructured.Unstructured{}
	obj.SetAPIVersion("cloud.google.com/v1")
	obj.SetKind("ComputeClass")
	obj.SetName("example")
	_, err := diff.ComputeDiff(context.Background(), []unstructured.Unstructured{obj}, &DiffOptions{Namespace: "release-default", ApplicationName: "example"})
	if err != nil || !read {
		t.Fatalf("diff did not query ComputeClass: read=%v err=%v", read, err)
	}
	for _, action := range client.Actions() {
		if action.GetVerb() != "get" {
			t.Fatalf("name-scoped reads must not use %s", action.GetVerb())
		}
	}
}

type computeClassTestResolver struct{}

func (computeClassTestResolver) Resolve(context.Context, string, string, string) (schema.GroupVersionResource, error) {
	return schema.GroupVersionResource{Group: "cloud.google.com", Version: "v1", Resource: "computeclasses"}, nil
}
