package engine

import (
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// ApplyIgnoreDifferences strips fields matching the specified JSON pointers
// from both desired and live objects in-place, so they are excluded from diff
// computation. Rules with a group/kind/name/namespace scope only apply to
// matching objects; empty scope fields are wildcards.
func ApplyIgnoreDifferences(desired, live map[string]unstructured.Unstructured, ignoreDiffs []pipelinesv1alpha1.IgnoreDiff) {
	if len(ignoreDiffs) == 0 {
		return
	}
	for i := range ignoreDiffs {
		id := &ignoreDiffs[i]
		for _, pointer := range id.JSONPointers {
			for _, obj := range desired {
				if ignoreDiffMatches(id, obj) {
					removeField(obj.Object, pointer)
				}
			}
			for _, obj := range live {
				if ignoreDiffMatches(id, obj) {
					removeField(obj.Object, pointer)
				}
			}
		}
	}
}

// ignoreDiffMatches reports whether a rule's group/kind/name/namespace scope
// selects the object. Empty scope fields are wildcards — a rule with no scope
// applies to every object, preserving pre-scoping behavior.
func ignoreDiffMatches(id *pipelinesv1alpha1.IgnoreDiff, obj unstructured.Unstructured) bool {
	if id.Group != "" {
		group, _ := parseGroupVersion(obj.GetAPIVersion())
		if group != id.Group {
			return false
		}
	}
	if id.Kind != "" && obj.GetKind() != id.Kind {
		return false
	}
	if id.Name != "" && obj.GetName() != id.Name {
		return false
	}
	if id.Namespace != "" && obj.GetNamespace() != id.Namespace {
		return false
	}
	return true
}

// parseGroupVersion splits apiVersion into group and version.
func parseGroupVersion(apiVersion string) (group, version string) {
	if i := strings.LastIndex(apiVersion, "/"); i >= 0 {
		return apiVersion[:i], apiVersion[i+1:]
	}
	return "", apiVersion
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
