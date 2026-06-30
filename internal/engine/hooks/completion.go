package hooks

import (
	"context"
	"fmt"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// CompletionFunc reports whether a hook resource has reached a terminal
// state. Returns (done, succeeded, message, err). When done is false, the
// controller should re-check on the next reconcile. When done is true,
// succeeded indicates whether the hook succeeded; message is human-readable
// status text.
type CompletionFunc func(ctx context.Context, client dynamic.Interface, ns, name string) (done, succeeded bool, message string, err error)

var completionRegistry = map[string]CompletionFunc{}

func init() {
	RegisterCompletionChecker("batch/v1, Kind=Job", jobCompletion)
	RegisterCompletionChecker("v1, Kind=Pod", podCompletion)
}

// RegisterCompletionChecker registers a completion checker for a GVK string
// formatted as "group/version, Kind=kind" (the format GVK.String() produces).
func RegisterCompletionChecker(gvk string, fn CompletionFunc) {
	completionRegistry[gvk] = fn
}

// CompletionFor returns the registered checker for the given GVK, or nil
// (meaning "fire-and-forget" — creation is considered completion).
func CompletionFor(gvk string) CompletionFunc {
	return completionRegistry[gvk]
}

// jobCompletion fetches a Job and checks its status.conditions / succeeded/failed counts.
func jobCompletion(ctx context.Context, client dynamic.Interface, ns, name string) (done, succeeded bool, message string, err error) {
	obj, err := client.Resource(jobGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return false, false, "", fmt.Errorf("getting Job: %w", err)
	}
	return jobCompletionFromObject(obj)
}

// podCompletion fetches a Pod and checks its status.phase.
func podCompletion(ctx context.Context, client dynamic.Interface, ns, name string) (done, succeeded bool, message string, err error) {
	obj, err := client.Resource(podGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return false, false, "", fmt.Errorf("getting Pod: %w", err)
	}
	return podCompletionFromObject(obj)
}

func jobCompletionFromObject(obj *unstructured.Unstructured) (done, succeeded bool, message string, err error) {
	var job batchv1.Job
	if err = runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &job); err != nil {
		return false, false, "", fmt.Errorf("converting to Job: %w", err)
	}
	for _, c := range job.Status.Conditions {
		if c.Type == batchv1.JobComplete && c.Status == corev1.ConditionTrue {
			return true, true, "Job completed successfully", nil
		}
		if c.Type == batchv1.JobFailed && c.Status == corev1.ConditionTrue {
			msg := "Job failed"
			if c.Message != "" {
				msg = c.Message
			}
			return true, false, msg, nil
		}
	}
	if job.Status.Succeeded > 0 {
		return true, true, "Job succeeded", nil
	}
	if job.Status.Failed > 0 {
		return true, false, fmt.Sprintf("Job failed (%d pods failed)", job.Status.Failed), nil
	}
	return false, false, "", nil
}

func podCompletionFromObject(obj *unstructured.Unstructured) (done, succeeded bool, message string, err error) {
	var pod corev1.Pod
	if err = runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &pod); err != nil {
		return false, false, "", fmt.Errorf("converting to Pod: %w", err)
	}
	if pod.Status.Phase == corev1.PodSucceeded {
		return true, true, "Pod succeeded", nil
	}
	if pod.Status.Phase == corev1.PodFailed {
		msg := "Pod failed"
		if pod.Status.Message != "" {
			msg = pod.Status.Message
		}
		return true, false, msg, nil
	}
	return false, false, "", nil
}

var (
	jobGVR = schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "jobs"}
	podGVR = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}
)
