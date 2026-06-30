package hooks

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic"
)

func TestJobCompletion_Succeeded(t *testing.T) {
	job := &batchv1.Job{
		TypeMeta:   metav1.TypeMeta{Kind: "Job", APIVersion: "batch/v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "succeeded", Namespace: "default"},
		Status: batchv1.JobStatus{Conditions: []batchv1.JobCondition{
			{Type: batchv1.JobComplete, Status: corev1.ConditionTrue},
		}},
	}
	u, err := runtime.DefaultUnstructuredConverter.ToUnstructured(job)
	require.NoError(t, err)
	obj := &unstructured.Unstructured{Object: u}

	done, succeeded, msg, err := jobCompletionFromObject(obj)
	require.NoError(t, err)
	assert.True(t, done)
	assert.True(t, succeeded)
	assert.NotEmpty(t, msg)
}

func TestJobCompletion_Failed(t *testing.T) {
	job := &batchv1.Job{
		TypeMeta:   metav1.TypeMeta{Kind: "Job", APIVersion: "batch/v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "failed", Namespace: "default"},
		Status: batchv1.JobStatus{Conditions: []batchv1.JobCondition{
			{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, Message: "backoff limit reached"},
		}},
	}
	u, _ := runtime.DefaultUnstructuredConverter.ToUnstructured(job)
	obj := &unstructured.Unstructured{Object: u}

	done, succeeded, msg, err := jobCompletionFromObject(obj)
	require.NoError(t, err)
	assert.True(t, done)
	assert.False(t, succeeded)
	assert.Contains(t, msg, "backoff limit")
}

func TestJobCompletion_NotDone(t *testing.T) {
	job := &batchv1.Job{
		TypeMeta:   metav1.TypeMeta{Kind: "Job", APIVersion: "batch/v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "running", Namespace: "default"},
		Status:     batchv1.JobStatus{},
	}
	u, _ := runtime.DefaultUnstructuredConverter.ToUnstructured(job)
	obj := &unstructured.Unstructured{Object: u}

	done, _, _, err := jobCompletionFromObject(obj)
	require.NoError(t, err)
	assert.False(t, done)
}

func TestJobCompletion_SucceededCount(t *testing.T) {
	// No conditions but status.succeeded > 0.
	job := &batchv1.Job{
		TypeMeta:   metav1.TypeMeta{Kind: "Job", APIVersion: "batch/v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "ok", Namespace: "default"},
		Status:     batchv1.JobStatus{Succeeded: 1},
	}
	u, _ := runtime.DefaultUnstructuredConverter.ToUnstructured(job)
	obj := &unstructured.Unstructured{Object: u}

	done, succeeded, _, _ := jobCompletionFromObject(obj)
	assert.True(t, done)
	assert.True(t, succeeded)
}

func TestPodCompletion_Succeeded(t *testing.T) {
	pod := &corev1.Pod{
		TypeMeta:   metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "ok", Namespace: "default"},
		Status:     corev1.PodStatus{Phase: corev1.PodSucceeded},
	}
	u, _ := runtime.DefaultUnstructuredConverter.ToUnstructured(pod)
	obj := &unstructured.Unstructured{Object: u}

	done, succeeded, _, _ := podCompletionFromObject(obj)
	assert.True(t, done)
	assert.True(t, succeeded)
}

func TestPodCompletion_Failed(t *testing.T) {
	pod := &corev1.Pod{
		TypeMeta:   metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "bad", Namespace: "default"},
		Status:     corev1.PodStatus{Phase: corev1.PodFailed, Message: "OOMKilled"},
	}
	u, _ := runtime.DefaultUnstructuredConverter.ToUnstructured(pod)
	obj := &unstructured.Unstructured{Object: u}

	done, succeeded, msg, _ := podCompletionFromObject(obj)
	assert.True(t, done)
	assert.False(t, succeeded)
	assert.Contains(t, msg, "OOMKilled")
}

func TestPodCompletion_Pending(t *testing.T) {
	pod := &corev1.Pod{
		TypeMeta:   metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "pending", Namespace: "default"},
		Status:     corev1.PodStatus{Phase: corev1.PodPending},
	}
	u, _ := runtime.DefaultUnstructuredConverter.ToUnstructured(pod)
	obj := &unstructured.Unstructured{Object: u}

	done, _, _, err := podCompletionFromObject(obj)
	require.NoError(t, err)
	assert.False(t, done)
}

func TestCompletionFor_KnownKinds(t *testing.T) {
	assert.NotNil(t, CompletionFor("batch/v1, Kind=Job"))
	assert.NotNil(t, CompletionFor("v1, Kind=Pod"))
}

func TestCompletionFor_UnknownKind_Nil(t *testing.T) {
	assert.Nil(t, CompletionFor("example.com/v1, Kind=Widget"), "unknown GVK should return nil (fire-and-forget)")
}

func TestRegisterCompletionChecker_Custom(t *testing.T) {
	// Register a custom checker and verify it's returned via CompletionFor.
	gvk := "example.com/v1, Kind=Widget"
	defer delete(completionRegistry, gvk) // cleanup
	RegisterCompletionChecker(gvk, func(_ context.Context, _ dynamic.Interface, _, _ string) (bool, bool, string, error) {
		return true, true, "custom", nil
	})
	assert.NotNil(t, CompletionFor(gvk))
}
