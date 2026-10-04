package pipelines

import (
	"context"
	"testing"

	"github.com/go-logr/logr"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	ktesting "k8s.io/client-go/testing"
)

func TestComputeClassApplyUsesRootResource(t *testing.T) {
	t.Parallel()

	client := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	patched := false
	client.PrependReactor("patch", "*", func(action ktesting.Action) (bool, runtime.Object, error) {
		patched = true
		if action.GetNamespace() != "" {
			t.Fatalf("ComputeClass PATCH used namespace %q", action.GetNamespace())
		}
		return true, &unstructured.Unstructured{}, nil
	})
	obj := map[string]interface{}{
		"apiVersion": "cloud.google.com/v1", "kind": "ComputeClass",
		"metadata": map[string]interface{}{"name": "example", "namespace": "render-default"},
	}
	r := &ReleaseReconciler{Resolver: computeClassTestResolver{}}
	changed, err := r.applyDocument(context.Background(), logr.Discard(), client, obj, "release-default", "example", "example-release", nil)
	if err != nil || !changed || !patched {
		t.Fatalf("apply did not succeed: changed=%v patched=%v err=%v", changed, patched, err)
	}
	if _, present := obj["metadata"].(map[string]interface{})["namespace"]; present {
		t.Fatal("ComputeClass manifest retained an injected namespace")
	}
}

type computeClassTestResolver struct{}

func (computeClassTestResolver) Resolve(context.Context, string, string, string) (schema.GroupVersionResource, error) {
	return schema.GroupVersionResource{Group: "cloud.google.com", Version: "v1", Resource: "computeclasses"}, nil
}
