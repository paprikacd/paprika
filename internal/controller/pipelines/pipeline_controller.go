package controller

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	"github.com/benebsworth/paprika/internal/sharding"
	"github.com/benebsworth/paprika/metrics"
)

const pipelineFinalizer = "paprika.io/pipeline-cleanup"

// PipelineReconciler reconciles Pipeline resources.
type PipelineReconciler struct {
	client.Client
	Scheme         *runtime.Scheme
	K8sClient      kubernetes.Interface
	Namespace      string
	WorkflowEngine engine.WorkflowEngine
	ShardFilter    *sharding.Filter
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=pipelines,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=pipelines/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=pipelines/finalizers,verbs=update
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups=core,resources=pods/log,verbs=get;list

// Reconcile handles Pipeline reconciliation.
func (r *PipelineReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	result := resultSuccess
	start := metrics.Timer()
	defer func() {
		metrics.ReconcileTotal.WithLabelValues("pipeline", result).Inc()
		metrics.ReconcileDuration.WithLabelValues("pipeline").Observe(metrics.Since(start))
	}()

	var pipeline pipelinesv1alpha1.Pipeline
	if err := r.Get(ctx, req.NamespacedName, &pipeline); err != nil {
		result = resultError
		if k8sErr := client.IgnoreNotFound(err); k8sErr != nil {
			return ctrl.Result{}, fmt.Errorf("getting pipeline: %w", k8sErr)
		}
		return ctrl.Result{}, nil
	}

	log := logf.FromContext(ctx)
	if r.ShardFilter != nil && !r.ShardFilter.Matches(req.Namespace) {
		log.Info("Skipping pipeline not in shard", "namespace", req.Namespace, "shard", r.ShardFilter.ShardID())
		return ctrl.Result{}, nil
	}

	if !pipeline.DeletionTimestamp.IsZero() {
		if err := r.handlePipelineDeletion(ctx, &pipeline); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	if !controllerutil.ContainsFinalizer(&pipeline, pipelineFinalizer) {
		if err := r.ensurePipelineFinalizer(ctx, &pipeline); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	return r.reconcilePipeline(ctx, req, &pipeline, start, &result)
}

func (r *PipelineReconciler) patchPipelineStatus(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline) error {
	desiredStatus := pipeline.Status.DeepCopy()
	if err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		var fresh pipelinesv1alpha1.Pipeline
		if err := r.Get(ctx, types.NamespacedName{Name: pipeline.Name, Namespace: pipeline.Namespace}, &fresh); err != nil {
			return fmt.Errorf("fetching pipeline for status update: %w", err)
		}
		fresh.Status = *desiredStatus
		fresh.Status.ObservedGeneration = fresh.Generation
		if err := r.Status().Update(ctx, &fresh); err != nil {
			return fmt.Errorf("updating pipeline status: %w", err)
		}
		return nil
	}); err != nil {
		return fmt.Errorf("patching pipeline status: %w", err)
	}
	return nil
}

func (r *PipelineReconciler) handlePipelineResult(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, stepStatuses []pipelinesv1alpha1.StepStatus, start time.Time, result *string) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
	allSucceeded := true
	for _, s := range stepStatuses {
		if s.Phase == pipelinesv1alpha1.StepFailed {
			allSucceeded = false
			break
		}
	}

	if allSucceeded {
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineSucceeded
		metrics.PipelinePhaseTotal.WithLabelValues(pipeline.Name, pipeline.Namespace, "Succeeded").Inc()
		metrics.PipelineDuration.WithLabelValues(pipeline.Name, pipeline.Namespace).Observe(metrics.Since(start))
		pipeline.Status.StepStatuses = stepStatuses
		if err := r.patchPipelineStatus(ctx, pipeline); err != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("failed to update pipeline status to succeeded: %w", err)
		}

		for _, output := range pipeline.Spec.Artifacts {
			if err := r.createArtifact(ctx, pipeline, output); err != nil {
				log.Error(err, "Failed to create artifact", "artifact", output.Name)
			}
		}
	} else {
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineFailed
		metrics.PipelinePhaseTotal.WithLabelValues(pipeline.Name, pipeline.Namespace, "Failed").Inc()
		pipeline.Status.StepStatuses = stepStatuses
		if err := r.patchPipelineStatus(ctx, pipeline); err != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("failed to update pipeline status to failed: %w", err)
		}
	}
	return ctrl.Result{}, nil
}

func (r *PipelineReconciler) handlePipelineDeletion(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline) error {
	if !controllerutil.ContainsFinalizer(pipeline, pipelineFinalizer) {
		return nil
	}
	controllerutil.RemoveFinalizer(pipeline, pipelineFinalizer)
	if err := r.Update(ctx, pipeline); err != nil {
		return fmt.Errorf("removing pipeline finalizer: %w", err)
	}
	return nil
}

func (r *PipelineReconciler) ensurePipelineFinalizer(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline) error {
	if controllerutil.ContainsFinalizer(pipeline, pipelineFinalizer) {
		return nil
	}
	controllerutil.AddFinalizer(pipeline, pipelineFinalizer)
	if err := r.Update(ctx, pipeline); err != nil {
		return fmt.Errorf("adding pipeline finalizer: %w", err)
	}
	return nil
}

func (r *PipelineReconciler) reconcilePipeline(ctx context.Context, req ctrl.Request, pipeline *pipelinesv1alpha1.Pipeline, start time.Time, result *string) (ctrl.Result, error) {
	if pipeline.Status.Phase == pipelinesv1alpha1.PipelineSucceeded ||
		pipeline.Status.Phase == pipelinesv1alpha1.PipelineFailed {
		return ctrl.Result{}, nil
	}

	if pipeline.Status.Phase == "" {
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineRunning
		metrics.PipelinePhaseTotal.WithLabelValues(pipeline.Name, pipeline.Namespace, "Running").Inc()
		pipeline.Status.LastExecutionID = "run-" + req.Name
		now := metav1.Now()
		pipeline.Status.LastExecutionTime = &now
		if err := r.patchPipelineStatus(ctx, pipeline); err != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("failed to set pipeline running: %w", err)
		}
	}

	stepStatuses, err := r.WorkflowEngine.RunPipeline(ctx, pipeline)
	if err != nil {
		log := logf.FromContext(ctx)
		log.Error(err, "Pipeline execution failed", "pipeline", req.Name)
		pipeline.Status.Phase = pipelinesv1alpha1.PipelineFailed
		metrics.PipelinePhaseTotal.WithLabelValues(pipeline.Name, pipeline.Namespace, "Failed").Inc()
		pipeline.Status.StepStatuses = stepStatuses
		if updateErr := r.patchPipelineStatus(ctx, pipeline); updateErr != nil {
			*result = resultError
			return ctrl.Result{}, fmt.Errorf("failed to update pipeline status to failed: %w", updateErr)
		}
		return ctrl.Result{}, fmt.Errorf("running pipeline workflow: %w", err)
	}

	return r.handlePipelineResult(ctx, pipeline, stepStatuses, start, result)
}

func (r *PipelineReconciler) createArtifact(ctx context.Context, pipeline *pipelinesv1alpha1.Pipeline, output pipelinesv1alpha1.PipelineOutput) error {
	artifact := &pipelinesv1alpha1.Artifact{
		ObjectMeta: metav1.ObjectMeta{
			GenerateName: pipeline.Name + "-artifact-",
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
	if err := r.Create(ctx, artifact); err != nil {
		return fmt.Errorf("creating artifact: %w", err)
	}
	return nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *PipelineReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.Pipeline{}).
		Owns(&corev1.Pod{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 3}).
		Named("pipeline").
		Complete(r); err != nil {
		return fmt.Errorf("setting up pipeline controller: %w", err)
	}
	return nil
}
