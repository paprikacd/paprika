package engine

import (
	"context"
	"errors"
	"fmt"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// ValidatePipelineJobsStopped prevents a retry from overlapping a Job whose
// watcher failed before the Kubernetes execution actually stopped.
func ValidatePipelineJobsStopped(ctx context.Context, kube kubernetes.Interface, namespace, pipelineName string) error {
	if kube == nil || namespace == "" {
		return errors.New("retry requires a configured Kubernetes client and operator execution namespace to establish prior Job completion")
	}
	jobs, err := kube.BatchV1().Jobs(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "paprika.io/pipeline=" + pipelineName,
	})
	if err != nil {
		return fmt.Errorf("cannot establish prior Job completion: %w", err)
	}
	for i := range jobs.Items {
		if !pipelineRetryJobTerminal(&jobs.Items[i]) {
			return fmt.Errorf("prior Job %s/%s is active, nonterminal or terminating; retry requires all prior Jobs to have stopped", jobs.Items[i].Namespace, jobs.Items[i].Name)
		}
	}
	return nil
}

func pipelineRetryJobTerminal(job *batchv1.Job) bool {
	if job.Status.Active != 0 || !job.DeletionTimestamp.IsZero() {
		return false
	}
	for _, condition := range job.Status.Conditions {
		if (condition.Type == batchv1.JobComplete || condition.Type == batchv1.JobFailed) && condition.Status == corev1.ConditionTrue {
			return true
		}
	}
	return false
}
