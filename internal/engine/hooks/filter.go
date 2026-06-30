package hooks

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// IsHook reports whether the given resource carries a non-empty hook
// annotation. Used by the diff engine to exclude hook resources from
// OutOfSync calculations (hooks are not "managed" resources).
func IsHook(obj *unstructured.Unstructured) bool {
	if obj == nil {
		return false
	}
	ann := obj.GetAnnotations()
	v, ok := ann[paprikav1.HookAnnotation]
	return ok && v != ""
}

// FilterHooks returns a copy of objs with hook resources removed.
func FilterHooks(objs []unstructured.Unstructured) []unstructured.Unstructured {
	out := make([]unstructured.Unstructured, 0, len(objs))
	for i := range objs {
		if !IsHook(&objs[i]) {
			out = append(out, objs[i])
		}
	}
	return out
}
