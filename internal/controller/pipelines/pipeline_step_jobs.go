package pipelines

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/selection"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
)

// deleteStepJobs deletes the step Jobs of a Pipeline that is being deleted.
//
// Step Jobs run in the operator namespace. A Pipeline can live in another
// namespace, and Kubernetes rejects an owner reference across namespaces, so
// garbage collection never removes these Jobs. The finalizer finds them by
// label instead. Background propagation removes their Pods too.
//
// Jobs created before the namespace label existed carry only the Pipeline
// name. The finalizer also deletes those, which matches the name only.
func (r *PipelineReconciler) deleteStepJobs(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline) (int, error) {
	if r.K8sClient == nil || r.Namespace == "" {
		return 0, nil
	}
	selectors, err := stepJobSelectors(pipeline)
	if err != nil {
		return 0, err
	}
	deleted := 0
	for _, selector := range selectors {
		n, err := r.deleteStepJobsMatching(ctx, pipeline, selector)
		deleted += n
		if err != nil {
			return deleted, err
		}
	}
	return deleted, nil
}

func (r *PipelineReconciler) deleteStepJobsMatching(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, selector string) (int, error) {
	jobs := r.K8sClient.BatchV1().Jobs(r.Namespace)
	list, err := jobs.List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return 0, fmt.Errorf("listing step jobs of pipeline %s/%s: %w", pipeline.Namespace, pipeline.Name, err)
	}
	propagation := metav1.DeletePropagationBackground
	deleted := 0
	for i := range list.Items {
		job := &list.Items[i]
		err := jobs.Delete(ctx, job.Name, metav1.DeleteOptions{
			PropagationPolicy: &propagation,
			Preconditions:     &metav1.Preconditions{UID: &job.UID},
		})
		switch {
		case err == nil:
			deleted++
		case apierrors.IsNotFound(err), apierrors.IsConflict(err):
		default:
			return deleted, fmt.Errorf("deleting step job %s: %w", job.Name, err)
		}
	}
	return deleted, nil
}

// stepJobSelectors returns the label selectors of the Pipeline's step Jobs:
// Jobs labeled with this Pipeline's namespace, and older Jobs that carry no
// namespace label.
func stepJobSelectors(pipeline *pipelinesv1alpha1.Pipeline) ([]string, error) {
	name, err := labels.NewRequirement(engine.StepPipelineLabelKey, selection.Equals, []string{pipeline.Name})
	if err != nil {
		return nil, fmt.Errorf("building step job selector: %w", err)
	}
	namespace, err := labels.NewRequirement(engine.StepPipelineNamespaceLabelKey, selection.Equals, []string{pipeline.Namespace})
	if err != nil {
		return nil, fmt.Errorf("building step job selector: %w", err)
	}
	unlabeled, err := labels.NewRequirement(engine.StepPipelineNamespaceLabelKey, selection.DoesNotExist, nil)
	if err != nil {
		return nil, fmt.Errorf("building step job selector: %w", err)
	}
	return []string{
		labels.NewSelector().Add(*name, *namespace).String(),
		labels.NewSelector().Add(*name, *unlabeled).String(),
	}, nil
}
