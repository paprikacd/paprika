package hooks

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestIsHook_True(t *testing.T) {
	u := &unstructured.Unstructured{}
	u.SetGroupVersionKind(schema.GroupVersionKind{Group: "batch", Version: "v1", Kind: "Job"})
	u.SetAnnotations(map[string]string{paprikav1.HookAnnotation: "PreSync"})
	assert.True(t, IsHook(u))
}

func TestIsHook_EmptyValue_False(t *testing.T) {
	u := &unstructured.Unstructured{}
	u.SetAnnotations(map[string]string{paprikav1.HookAnnotation: ""})
	assert.False(t, IsHook(u))
}

func TestIsHook_NoAnnotation_False(t *testing.T) {
	u := &unstructured.Unstructured{}
	assert.False(t, IsHook(u))
}

func TestIsHook_Nil_False(t *testing.T) {
	assert.False(t, IsHook(nil))
}

func TestFilterHooks(t *testing.T) {
	in := []unstructured.Unstructured{
		{}, // no annotation
		{}, // will set below
		{},
	}
	in[1].SetAnnotations(map[string]string{paprikav1.HookAnnotation: "PostSync"})
	out := FilterHooks(in)
	assert.Len(t, out, 2, "hook object should be filtered")
}

func TestFilterHooks_AllHooks(t *testing.T) {
	in := []unstructured.Unstructured{
		{}, // hook
		{}, // hook
	}
	in[0].SetAnnotations(map[string]string{paprikav1.HookAnnotation: "PreSync"})
	in[1].SetAnnotations(map[string]string{paprikav1.HookAnnotation: "PostSync"})
	out := FilterHooks(in)
	assert.Empty(t, out)
}

func TestFilterHooks_NoHooks(t *testing.T) {
	in := []unstructured.Unstructured{{}, {}, {}}
	out := FilterHooks(in)
	assert.Len(t, out, 3, "no hooks should be filtered, all 3 pass through")
}
