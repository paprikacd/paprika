package controller

import (
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestPropagationPolicy(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		opts *paprikav1.SyncOptions
		want string
	}{
		{"nil options", nil, ""},
		{"empty policy", &paprikav1.SyncOptions{}, ""},
		{"foreground", &paprikav1.SyncOptions{PrunePropagationPolicy: "Foreground"}, "Foreground"},
		{"background", &paprikav1.SyncOptions{PrunePropagationPolicy: "Background"}, "Background"},
		{"orphan", &paprikav1.SyncOptions{PrunePropagationPolicy: "Orphan"}, "Orphan"},
		{"unknown", &paprikav1.SyncOptions{PrunePropagationPolicy: "Invalid"}, ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := propagationPolicy(tc.opts)
			if tc.want == "" {
				if got != nil {
					t.Fatalf("expected nil propagation policy, got %v", *got)
				}
				return
			}
			if got == nil {
				t.Fatalf("expected %s propagation policy, got nil", tc.want)
			}
			if string(*got) != tc.want {
				t.Errorf("propagationPolicy() = %s, want %s", *got, tc.want)
			}
		})
	}
}

func TestResourceInSync(t *testing.T) {
	t.Parallel()

	deployment := func(image string) *unstructured.Unstructured {
		return &unstructured.Unstructured{
			Object: map[string]interface{}{
				"apiVersion": "apps/v1",
				"kind":       "Deployment",
				"metadata": map[string]interface{}{
					"name":      "web",
					"namespace": "default",
					"labels": map[string]interface{}{
						"app": "web",
					},
				},
				"spec": map[string]interface{}{
					"replicas": 1,
					"template": map[string]interface{}{
						"spec": map[string]interface{}{
							"containers": []interface{}{
								map[string]interface{}{"name": "app", "image": image},
							},
						},
					},
				},
			},
		}
	}

	t.Run("equal resources", func(t *testing.T) {
		desired := deployment("nginx:1.0")
		live := deployment("nginx:1.0")
		metadata, ok := live.Object["metadata"].(map[string]interface{})
		require.True(t, ok)
		metadata["resourceVersion"] = "123"
		metadata["uid"] = "abc"
		if !resourceInSync(desired, live) {
			t.Error("expected resources to be in sync")
		}
	})

	t.Run("different spec", func(t *testing.T) {
		desired := deployment("nginx:2.0")
		live := deployment("nginx:1.0")
		if resourceInSync(desired, live) {
			t.Error("expected resources to be out of sync")
		}
	})

	t.Run("extra live metadata ignored", func(t *testing.T) {
		desired := deployment("nginx:1.0")
		live := deployment("nginx:1.0")
		metadata, ok := live.Object["metadata"].(map[string]interface{})
		require.True(t, ok)
		metadata["annotations"] = map[string]interface{}{
			"deployment.kubernetes.io/revision": "1",
		}
		if !resourceInSync(desired, live) {
			t.Error("expected server-added annotations to be ignored")
		}
	})

	t.Run("missing desired key", func(t *testing.T) {
		desired := &unstructured.Unstructured{
			Object: map[string]interface{}{
				"apiVersion": "v1",
				"kind":       "ConfigMap",
				"metadata": map[string]interface{}{
					"name": "cfg",
				},
				"data": map[string]interface{}{
					"key": "value",
				},
			},
		}
		live := &unstructured.Unstructured{
			Object: map[string]interface{}{
				"apiVersion": "v1",
				"kind":       "ConfigMap",
				"metadata": map[string]interface{}{
					"name": "cfg",
				},
			},
		}
		if resourceInSync(desired, live) {
			t.Error("expected missing data to be out of sync")
		}
	})
}

func TestIsEmptyValue(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		v    interface{}
		want bool
	}{
		{"nil", nil, true},
		{"empty string", "", true},
		{"empty map", map[string]interface{}{}, true},
		{"empty slice", []interface{}{}, true},
		{"non-empty string", "x", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isEmptyValue(tc.v); got != tc.want {
				t.Errorf("isEmptyValue(%v) = %v, want %v", tc.v, got, tc.want)
			}
		})
	}
}
