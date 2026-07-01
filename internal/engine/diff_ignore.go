package engine

import (
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// ApplyIgnoreDifferences strips fields matching the specified JSON pointers
// from both desired and live objects in-place, so they are excluded from diff
// computation.
func ApplyIgnoreDifferences(desired, live map[string]unstructured.Unstructured, ignoreDiffs []pipelinesv1alpha1.IgnoreDiff) {
	if len(ignoreDiffs) == 0 {
		return
	}
	for _, id := range ignoreDiffs {
		for _, pointer := range id.JSONPointers {
			for _, obj := range desired {
				removeField(obj.Object, pointer)
			}
			for _, obj := range live {
				removeField(obj.Object, pointer)
			}
		}
	}
}

// removeField removes a field from a nested map at the given JSON Pointer path.
// Non-existent paths are silently ignored.
func removeField(obj map[string]interface{}, pointer string) {
	if pointer == "" || pointer == "/" {
		return
	}
	parts := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
	if len(parts) == 0 {
		return
	}
	current := obj
	for i, part := range parts {
		if i == len(parts)-1 {
			delete(current, part)
		} else {
			if next, ok := current[part].(map[string]interface{}); ok {
				current = next
			} else {
				return
			}
		}
	}
}
