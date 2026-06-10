package controller

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
)

const pipelineFinalizer = "paprika.io/pipeline-cleanup"

type PipelineReconciler struct {
	client.Client
	Scheme    *runtime.Scheme
	K8sClient kubernetes.Interface
	Namespace string
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=pipelines,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=pipelines/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=pipelines/finalizers,verbs=update
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups=core,resources=pods/log,verbs=get;list

func (r *PipelineReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var pipeline pipelinesv1alpha1.Pipeline
	if err := r.Get(ctx, req.NamespacedName, &pipeline); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !pipeline.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&pipeline, pipelineFinalizer) {
			controllerutil.RemoveFinalizer(&pipeline, pipelineFinalizer)
			if err := r.Update(ctx, &pipeline); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}

	if !controllerutil.ContainsFinalizer(&pipeline, pipelineFinalizer) {
		controllerutil.AddFinalizer(&pipeline, pipelineFinalizer)
		if err := r.Update(ctx, &pipeline); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	if pipeline.Status.Phase == pipelinesv1alpha1.PipelineSucceeded ||
		pipeline.Status.Phase == pipelinesv1alpha1.PipelineFailed {
		return ctrl.Result{}, nil
	}

	if pipeline.Status.Phase == "" {
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineRunning
		pipeline.Status.LastExecutionID = fmt.Sprintf("run-%s", req.Name)
		now := metav1.Now()
		pipeline.Status.LastExecutionTime = &now
		if err := r.Status().Update(ctx, &pipeline); err != nil {
			return ctrl.Result{}, fmt.Errorf("failed to set pipeline running: %w", err)
		}
	}

	workflowEngine := engine.NewWorkflowEngine(r.K8sClient, r.Namespace)

	stepStatuses, err := workflowEngine.RunPipeline(ctx, &pipeline)
	if err != nil {
		log.Error(err, "Pipeline execution failed", "pipeline", req.Name)
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineFailed
		pipeline.Status.StepStatuses = stepStatuses
		if updateErr := r.Status().Update(ctx, &pipeline); updateErr != nil {
			return ctrl.Result{}, fmt.Errorf("failed to update pipeline status to failed: %w", updateErr)
		}
		return ctrl.Result{}, err
	}

	allSucceeded := true
	for _, s := range stepStatuses {
		if s.Phase == pipelinesv1alpha1.StepFailed {
			allSucceeded = false
			break
		}
	}

	if allSucceeded {
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineSucceeded
		pipeline.Status.StepStatuses = stepStatuses
		if err := r.Status().Update(ctx, &pipeline); err != nil {
			return ctrl.Result{}, fmt.Errorf("failed to update pipeline status to succeeded: %w", err)
		}

		for _, output := range pipeline.Spec.Artifacts {
			if err := r.createArtifact(ctx, &pipeline, output); err != nil {
				log.Error(err, "Failed to create artifact", "artifact", output.Name)
			}
		}
	} else {
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineFailed
		pipeline.Status.StepStatuses = stepStatuses
		if err := r.Status().Update(ctx, &pipeline); err != nil {
			return ctrl.Result{}, fmt.Errorf("failed to update pipeline status to failed: %w", err)
		}
	}

	return ctrl.Result{}, nil
}

func (r *PipelineReconciler) createArtifact(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, output pipelinesv1alpha1.PipelineOutput) error {
	artifact := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{
			GenerateName: fmt.Sprintf("%s-artifact-", pipeline.Name),
			Namespace:    pipeline.Namespace,
			Labels: map[string]string{
				"paprika.io/pipeline": pipeline.Name,
			},
		},
		Spec: pipelinesv1alpha1.ArtifactSpec{
			Type:      "oci",
			Reference: output.Path,
			Provenance: pipelinesv1alpha1.ArtifactProvenance{
				Pipeline: pipeline.Name,
				Build:    pipeline.Status.LastExecutionID,
			},
		},
	}
	return r.Create(ctx, artifact)
}

func (r *PipelineReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.Pipeline{}).
		Owns(&corev1.Pod{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 3}).
		Named("pipeline").
		Complete(r)
}
