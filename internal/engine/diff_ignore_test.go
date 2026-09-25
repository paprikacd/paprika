package engine

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestApplyIgnoreDifferences_Scoped(t *testing.T) {
	desired := map[string]unstructured.Unstructured{
		"Deployment/web": {Object: map[string]interface{}{
			"apiVersion": "apps/v1", "kind": "Deployment",
			"metadata": map[string]interface{}{"name": "web", "namespace": "prod"},
			"spec":     map[string]interface{}{"replicas": int64(5)},
		}},
		"Deployment/api": {Object: map[string]interface{}{
			"apiVersion": "apps/v1", "kind": "Deployment",
			"metadata": map[string]interface{}{"name": "api", "namespace": "prod"},
			"spec":     map[string]interface{}{"replicas": int64(5)},
		}},
	}
	ApplyIgnoreDifferences(desired, map[string]unstructured.Unstructured{}, []pipelinesv1alpha1.IgnoreDiff{{
		Group: "apps", Kind: "Deployment", Name: "web", Namespace: "prod",
		JSONPointers: []string{"/spec/replicas"},
	}})
	web := desired["Deployment/web"]
	api := desired["Deployment/api"]
	if _, ok := web.Object["spec"].(map[string]interface{})["replicas"]; ok {
		t.Fatal("scoped rule should strip replicas from the matching object")
	}
	if _, ok := api.Object["spec"].(map[string]interface{})["replicas"]; !ok {
		t.Fatal("scoped rule must not touch non-matching objects")
	}
}
